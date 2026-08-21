import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ContactOut is the mobile source for company-first discovery.
 *
 * The operator's position is that ContactOut mobile data is materially more
 * accurate than Apollo's. The cost runs the same way: a ContactOut mobile is 1
 * ContactOut credit, an Apollo mobile is 9 Apollo credits (1 for the match plus
 * an 8-credit surcharge) against a 2,920/month plan. Nine times the price for
 * the number the operator trusts less is not a fallback worth keeping, so the
 * discovery reveal path does not have one — and the UI says so rather than
 * hiding it behind a checkbox that reads like Apollo is the primary path.
 *
 * The multi-contact picker (`/api/companies/[id]/reveal`) keeps the waterfall
 * it has always had; that is the default, and these tests pin both behaviours.
 */

type Row = Record<string, unknown>;

const contactRows: Row[] = [];
const companyRows: Row[] = [];
const updates: Array<{ table: string; values: Row }> = [];

function thenable(result: Row[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    where: self,
    orderBy: self,
    limit: self,
    returning: () => Promise.resolve(result),
    then: (
      onFulfilled?: (value: Row[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  });
  return chain;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table);
        return thenable(
          name === "contacts"
            ? contactRows
            : name === "companies"
              ? companyRows
              : [],
        );
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (values: Row) => {
        updates.push({ table: getTableName(table), values });
        return thenable([]);
      },
    }),
    insert: () => ({ values: () => thenable([]) }),
  },
}));

/** Args: (apiKey, apolloId, revealPhone, context, companyId). */
type MatchPersonArgs = [string, string, boolean, string, string];

const matchPersonCalls: MatchPersonArgs[] = [];

const matchPerson = vi.fn(
  async (...args: MatchPersonArgs): Promise<Record<string, unknown> | null> => {
    matchPersonCalls.push(args);
    return {
      id: "apollo-1",
      first_name: "Dana",
      last_name: "Reyes",
      name: "Dana Reyes",
      email: "dana@quietlaw.com",
      linkedin_url: "https://linkedin.com/in/danareyes",
      // An Apollo mobile is always available in this fixture, so any number
      // that shows up in the saved contact came from Apollo.
      mobile_phone: "+1 561-555-0999",
    };
  },
);

vi.mock("@/lib/apollo-enrich", () => ({
  matchPerson,
  apolloWebhookConfigured: () => true,
  searchPeople: vi.fn(async () => []),
  searchPeopleByCompanyName: vi.fn(async () => []),
}));

/** Args: (linkedinUrl, apiKey, needs, context, companyId). */
type ContactOutNeeds = { needPhone?: boolean; needPersonalEmail?: boolean };
type ContactOutArgs = [string, string, ContactOutNeeds, string, string];

let contactOutHasMobile = false;
const contactOutCalls: ContactOutArgs[] = [];

const enrichFromContactOut = vi.fn(async (...args: ContactOutArgs) => {
  contactOutCalls.push(args);
  return {
    personalEmail: "dana.reyes@gmail.com",
    personalEmails: ["dana.reyes@gmail.com"],
    workEmail: null,
    personalPhone: contactOutHasMobile ? "+1 561-555-0111" : null,
    phones: contactOutHasMobile
      ? [
          {
            number: "+1 561-555-0111",
            source: "contactout" as const,
            kind: "mobile" as const,
          },
        ]
      : [],
    phoneApiLocked: false,
    apiError: null,
  };
});

vi.mock("@/lib/contactout-enrich", () => ({
  enrichFromContactOut,
  describeContactOutError: () => "ContactOut error",
}));

vi.mock("@/lib/contactout-credits", () => ({
  markContactOutCreditsExhausted: vi.fn(async () => {}),
}));

vi.mock("@/lib/email-verify", () => ({
  verifyContactEmail: vi.fn(async () => ({
    deliverable: true,
    reason: "accepted",
  })),
}));

const { revealSelectedContacts } = await import("@/lib/enrich/discovery");
const { revealSingleDecisionMaker } = await import("@/lib/enrich/single-contact");

const CONTACT_ID = "contact-1";
const COMPANY_ID = "company-1";

function seedContact(overrides: Row = {}) {
  contactRows.length = 0;
  contactRows.push({
    id: CONTACT_ID,
    companyId: COMPANY_ID,
    name: "Dana R***",
    title: "Managing Partner",
    apolloId: "apollo-1",
    linkedinUrl: "https://linkedin.com/in/danareyes",
    email: null,
    workEmail: null,
    personalEmail: null,
    personalEmails: [],
    phone: null,
    personalPhone: null,
    companyPhone: null,
    phones: [],
    revealStatus: "discovered",
    revealChannels: null,
    sourceProvider: "apollo_discovery",
    isPrimary: true,
    locationMatched: true,
    contactLocation: "West Palm Beach, Florida",
    emailDeliverable: null,
    ...overrides,
  });
  companyRows.length = 0;
  companyRows.push({
    id: COMPANY_ID,
    name: "Quiet Law Offices",
    vertical: "legal",
    industry: "law practice",
    estimatedEmployees: 14,
    domain: "quietlaw.com",
    discoveryCompletedAt: new Date(),
  });
}

/** Every phone number written back to the contact row. */
function savedPhones(): string[] {
  return updates
    .filter((u) => u.table === "contacts")
    .flatMap((u) => (u.values.phones as Array<{ number: string }> | undefined) ?? [])
    .map((p) => p.number);
}

/** How many Apollo people/match calls asked for the 9-credit mobile reveal. */
const apolloPhoneRequests = () =>
  matchPersonCalls.filter((args) => args[2] === true).length;

beforeEach(() => {
  updates.length = 0;
  matchPersonCalls.length = 0;
  contactOutCalls.length = 0;
  matchPerson.mockClear();
  enrichFromContactOut.mockClear();
  contactOutHasMobile = false;
  seedContact();
});

describe("the discovery reveal path takes its mobile from ContactOut", () => {
  it("asks ContactOut for the mobile and never asks Apollo", async () => {
    contactOutHasMobile = true;
    const result = await revealSingleDecisionMaker({
      companyId: COMPANY_ID,
      apiKey: "apollo-key",
      contactOutApiKey: "co-key",
      contactOutAvailable: true,
      includePhone: true,
      context: "manual_enrich:company-1",
    });

    expect(enrichFromContactOut).toHaveBeenCalledTimes(1);
    expect(contactOutCalls[0][2]).toMatchObject({ needPhone: true });
    expect(apolloPhoneRequests()).toBe(0);
    expect(savedPhones()).toContain("+1 561-555-0111");
    expect(savedPhones()).not.toContain("+1 561-555-0999");
    expect(result.message).toContain("mobile found via ContactOut");
  });

  it("reports no mobile rather than falling back to Apollo's 9-credit one", async () => {
    contactOutHasMobile = false;
    const result = await revealSingleDecisionMaker({
      companyId: COMPANY_ID,
      apiKey: "apollo-key",
      contactOutApiKey: "co-key",
      contactOutAvailable: true,
      includePhone: true,
      context: "manual_enrich:company-1",
    });

    expect(enrichFromContactOut).toHaveBeenCalledTimes(1);
    expect(apolloPhoneRequests()).toBe(0);
    expect(savedPhones()).toHaveLength(0);
    expect(result.message).toContain("ContactOut has no mobile");
    expect(result.message).toContain("no Apollo fallback");
  });

  it("does not reach Apollo for a mobile even when ContactOut cannot run", async () => {
    await revealSingleDecisionMaker({
      companyId: COMPANY_ID,
      apiKey: "apollo-key",
      contactOutApiKey: undefined,
      contactOutAvailable: false,
      includePhone: true,
      context: "manual_enrich:company-1",
    });

    expect(enrichFromContactOut).not.toHaveBeenCalled();
    expect(apolloPhoneRequests()).toBe(0);
    // The email match still runs — that is the 1-credit leg, not the mobile.
    expect(matchPerson).toHaveBeenCalledTimes(1);
    expect(savedPhones()).toHaveLength(0);
  });

  it("still buys the email when the mobile was not requested", async () => {
    const result = await revealSingleDecisionMaker({
      companyId: COMPANY_ID,
      apiKey: "apollo-key",
      contactOutApiKey: "co-key",
      contactOutAvailable: true,
      includePhone: false,
      context: "manual_enrich:company-1",
    });

    expect(apolloPhoneRequests()).toBe(0);
    expect(contactOutCalls[0][2]).toMatchObject({ needPhone: false });
    expect(result.message).toContain("mobile not requested");
  });
});

describe("revealSelectedContacts records which mobile source it was given", () => {
  it("skips and counts the Apollo mobile when pinned to ContactOut", async () => {
    const result = await revealSelectedContacts({
      companyId: COMPANY_ID,
      selections: [{ contactId: CONTACT_ID, channels: "email_phone" }],
      apiKey: "apollo-key",
      contactOutApiKey: "co-key",
      contactOutAvailable: true,
      mobileSource: "contactout_only",
      context: "manual_enrich:company-1",
    });

    expect(result.mobileSource).toBe("contactout_only");
    expect(result.apolloMobileSkipped).toBe(1);
    expect(apolloPhoneRequests()).toBe(0);
  });

  it("keeps the legacy Apollo fallback for the multi-contact picker", async () => {
    const result = await revealSelectedContacts({
      companyId: COMPANY_ID,
      selections: [{ contactId: CONTACT_ID, channels: "email_phone" }],
      apiKey: "apollo-key",
      contactOutApiKey: "co-key",
      contactOutAvailable: true,
      context: "manual_enrich:company-1",
    });

    expect(result.mobileSource).toBe("contactout_then_apollo");
    expect(result.apolloMobileSkipped).toBe(0);
    expect(apolloPhoneRequests()).toBe(1);
    expect(savedPhones()).toContain("+1 561-555-0999");
  });
});
