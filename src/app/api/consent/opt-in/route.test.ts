import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The opt-in endpoint is the only mechanism in this system that creates SMS
 * permission, so the row it writes has to stand on its own as evidence: the
 * exact words displayed, the mechanism, the form id, when, from which IP and
 * user agent. The submitter never supplies the wording — only a version tag —
 * so a tampered post cannot invent a disclosure we never showed.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
const inserts: Array<{ table: string; values: Row }> = [];
const updates: Array<{ table: string; set: Row }> = [];

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
      from: (table: Parameters<typeof getTableName>[0]) =>
        thenable(selectResults.get(getTableName(table)) ?? []),
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Row) => {
        const name = getTableName(table);
        inserts.push({ table: name, values });
        return {
          returning: () =>
            Promise.resolve([{ id: `${name}-id`, ...values }]),
          then: (onFulfilled?: (value: Row[]) => unknown) =>
            Promise.resolve([{ id: `${name}-id` }]).then(onFulfilled),
        };
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Row) => {
        updates.push({ table: getTableName(table), set });
        return thenable([]);
      },
    }),
  },
}));

const { POST } = await import("@/app/api/consent/opt-in/route");
const { CONSENT_DISCLOSURE_VERSION, currentDisclosure } = await import(
  "@/lib/consent/disclosure"
);
const { NextRequest } = await import("next/server");

const SUBMISSION = {
  company_name: "Harbour & Wren LLP",
  contact_name: "Dana Reyes",
  work_email: "dana@harbourwren.com",
  phone: "(561) 555-0134",
  hiring_for: "two paralegals in Fort Lauderdale",
  sms_consent: "on",
  disclosure_version: CONSENT_DISCLOSURE_VERSION,
};

function post(body: Record<string, unknown>): Request {
  return new NextRequest("https://crm.example.com/api/consent/opt-in", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "user-agent": "Mozilla/5.0 (iPhone)",
    },
    body: JSON.stringify(body),
  });
}

function written(table: string): Row | undefined {
  return inserts.find((i) => i.table === table)?.values;
}

beforeEach(() => {
  selectResults.clear();
  selectResults.set("companies", []);
  inserts.length = 0;
  updates.length = 0;
});

describe("POST /api/consent/opt-in", () => {
  it("writes a complete consent record with the verbatim disclosure", async () => {
    const res = await POST(post(SUBMISSION) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; consent_record_id: string };
    expect(body.ok).toBe(true);
    expect(body.consent_record_id).toBe("consent_records-id");

    const consent = written("consent_records");
    expect(consent).toBeDefined();
    expect(consent!.disclosureText).toBe(currentDisclosure().text);
    // The four things carrier review looks for must be in the stored text.
    expect(consent!.disclosureText).toContain("V Executive Search");
    expect(consent!.disclosureText).toContain("Message frequency");
    expect(consent!.disclosureText).toContain("Msg and data rates may apply");
    expect(consent!.disclosureText).toContain(
      "Reply HELP for help and STOP to opt out",
    );

    expect(consent!.channelScope).toBe("both");
    expect(consent!.source).toBe("web_form");
    expect(consent!.sourceIdentifier).toBe(
      `self-hosted-opt-in:${CONSENT_DISCLOSURE_VERSION}`,
    );
    expect(consent!.email).toBe("dana@harbourwren.com");
    expect(consent!.phone).toBe("(561) 555-0134");
    // First hop of x-forwarded-for, not the proxy.
    expect(consent!.ipAddress).toBe("203.0.113.7");
    expect(consent!.userAgent).toBe("Mozilla/5.0 (iPhone)");
    expect(consent!.contactId).toBe("contacts-id");
    expect(consent!.companyId).toBe("companies-id");
  });

  it("lands the company on the inbound lane and into the review queue", async () => {
    await POST(post(SUBMISSION) as never);
    const company = written("companies");
    expect(company!.leadSource).toBe("inbound_form");
    expect(company!.reviewStatus).toBe("pending");
    expect(company!.domain).toBe("harbourwren.com");
  });

  /* Consent is optional; a lead that declines it is still a lead. */
  it("accepts a submission with the box left unticked and writes no consent", async () => {
    const res = await POST(
      post({ ...SUBMISSION, sms_consent: undefined }) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sms_consent: boolean; consent_record_id: null };
    expect(body.sms_consent).toBe(false);
    expect(body.consent_record_id).toBeNull();
    expect(written("consent_records")).toBeUndefined();
    expect(written("contacts")).toBeDefined();
  });

  /*
   * If we cannot resolve the wording the visitor saw, we cannot honestly claim
   * consent — so the submission is rejected rather than stored with a guess.
   */
  it("refuses a consent tick whose disclosure version we cannot reproduce", async () => {
    const res = await POST(
      post({ ...SUBMISSION, disclosure_version: "spoofed-v9" }) as never,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.disclosureVersion).toBeTruthy();
    expect(inserts).toHaveLength(0);
  });

  it("rejects incomplete submissions without touching the database", async () => {
    const res = await POST(
      post({ ...SUBMISSION, work_email: "not-an-email", phone: "" }) as never,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.workEmail).toBeTruthy();
    expect(body.errors.phone).toBeTruthy();
    expect(inserts).toHaveLength(0);
  });

  /* A form phone is self-reported, so it can never be assumed dialable. */
  it("stores the submitted phone as unclassified", async () => {
    await POST(post(SUBMISSION) as never);
    const contact = written("contacts");
    expect(contact!.phoneClassification).toBe("unknown");
  });

  it("reuses an existing company matched by work-email domain", async () => {
    selectResults.set("companies", [
      { id: "existing-company", name: "Harbour and Wren" },
    ]);
    const res = await POST(post(SUBMISSION) as never);
    const body = (await res.json()) as { company_id: string };
    expect(body.company_id).toBe("existing-company");
    expect(written("companies")).toBeUndefined();
    const update = updates.find((u) => u.table === "companies");
    expect(update?.set.leadSource).toBe("inbound_form");
    expect(update?.set.reviewStatus).toBe("pending");
  });
});
