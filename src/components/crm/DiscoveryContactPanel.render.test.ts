import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DiscoveryContactPanel,
  type DiscoveryContactPanelProps,
} from "@/components/crm/DiscoveryContactPanel";
import {
  describeRevealFailure,
  describeRevealSuccess,
} from "@/lib/discovery/reveal-outcome";
import type { Contact } from "@/lib/db/schema";

const COMPANY_ID = "9f3d0f0a-2a2b-4a1e-9d47-6b0b6a2f1c11";

/**
 * Carousel Development & Restoration Inc as the operator saw it: 18 employees,
 * construction, no job postings at all, one revealed owner and two candidates
 * still on file unrevealed.
 */
function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: "contact-1",
    companyId: COMPANY_ID,
    name: "Joe Carosella",
    title: "Director & Co-Owner",
    email: "joecarosella@gmail.com",
    workEmail: "jcarosella@cdri.net",
    personalEmail: "joecarosella@gmail.com",
    personalEmails: ["joecarosella@gmail.com"],
    phone: "+15615550143",
    personalPhone: "+15615550143",
    companyPhone: null,
    phones: [
      {
        number: "+15615550143",
        source: "contactout",
        kind: "mobile",
        classification: "mobile",
      },
    ],
    phoneClassification: "mobile",
    linkedinUrl: "https://www.linkedin.com/in/joecarosella",
    apolloId: "apollo-1",
    sourceProvider: "apollo+contactout",
    imessageCapable: null,
    emailDeliverable: true,
    emailVerifiedAt: new Date("2026-08-21T10:00:00.000Z"),
    presenceCheckedAt: null,
    locationMatched: false,
    contactLocation: "Delray Beach, Florida",
    jobLocation: null,
    revealStatus: "revealed",
    revealChannels: "email_phone",
    isPrimary: true,
    timezoneOverride: null,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    ...over,
  };
}

const UNREVEALED = contact({
  id: "contact-2",
  name: "Micah Cl***r",
  title: "President",
  email: null,
  workEmail: null,
  personalEmail: null,
  personalEmails: [],
  phone: null,
  personalPhone: null,
  phones: [],
  emailDeliverable: null,
  emailVerifiedAt: null,
  revealStatus: "discovered",
  revealChannels: null,
  isPrimary: false,
  sourceProvider: "apollo_discovery",
});

function render(over: Partial<DiscoveryContactPanelProps> = {}): string {
  const props: DiscoveryContactPanelProps = {
    panelId: `discovery-contacts-${COMPANY_ID}`,
    companyId: COMPANY_ID,
    contacts: null,
    jobLocation: null,
    loading: false,
    loadError: null,
    pending: false,
    pendingLabel: "Revealing one decision-maker…",
    outcome: null,
    costNote: null,
    onFindAdditional: () => {},
    additionalBusy: false,
    ...over,
  };
  return renderToStaticMarkup(createElement(DiscoveryContactPanel, props));
}

const SUCCESS = describeRevealSuccess({
  revealed: 1,
  candidatesFound: 3,
  alreadyRevealedCount: 0,
  phoneRequested: true,
  phonesFound: 1,
  emailDeliverable: true,
  emailVerifyReason: null,
  contactOutUsed: true,
  contactOutLocked: false,
  contactOutError: null,
  contactOutConfigured: true,
  contactOutRetryAt: null,
  apolloMobileSkipped: 0,
  contact: {
    name: "Joe Carosella",
    title: "Director & Co-Owner",
    email: "jcarosella@cdri.net",
    phone: "+15615550143",
  },
});

describe("DiscoveryContactPanel — pending", () => {
  it("says what is running instead of looking like a refresh", () => {
    const html = render({
      pending: true,
      pendingLabel: "Revealing one decision-maker — Apollo match, email verify, then ContactOut…",
    });
    expect(html).toContain("role=\"status\"");
    expect(html).toContain("Revealing one decision-maker");
    expect(html).toContain("animate-spin");
  });

  it("carries the panel id the row's aria-controls points at", () => {
    expect(render()).toContain(`id="discovery-contacts-${COMPANY_ID}"`);
  });
});

describe("DiscoveryContactPanel — revealed", () => {
  it("renders the contact inline with name, title, emails and LinkedIn", () => {
    const html = render({ contacts: [contact()], outcome: SUCCESS });
    expect(html).toContain("Joe Carosella");
    expect(html).toContain("Director &amp; Co-Owner");
    expect(html).toContain("jcarosella@cdri.net");
    expect(html).toContain("joecarosella@gmail.com");
    expect(html).toContain("linkedin.com/in/joecarosella");
  });

  it("uses the profile page's own phone and verification badges", () => {
    const html = render({ contacts: [contact()], outcome: SUCCESS });
    expect(html).toContain("ContactOut · Mobile");
    expect(html).toContain("Do not call ·");
    expect(html).toContain("MX ✓");
  });

  it("headlines the reveal and states the one-contact stop", () => {
    const html = render({ contacts: [contact()], outcome: SUCCESS });
    expect(html).toContain("Revealed Joe Carosella · Director &amp; Co-Owner");
    expect(html).toContain("Stopped at one contact");
  });

  it("offers Find additional contact once something is revealed", () => {
    const html = render({ contacts: [contact()], outcome: SUCCESS });
    expect(html).toContain("Find additional contact");
  });

  it("keeps Add to Call List reachable from the expanded row", () => {
    const html = render({ contacts: [contact()], outcome: SUCCESS });
    expect(html).toContain("Add to Call List");
  });

  it("reports the credit cost of the click", () => {
    const html = render({
      contacts: [contact()],
      outcome: SUCCESS,
      costNote: "One contact revealed: 1 Apollo email credit.",
    });
    expect(html).toContain("1 Apollo email credit");
  });
});

describe("DiscoveryContactPanel — already revealed", () => {
  it("says no credits were spent and points at the explicit action", () => {
    const outcome = describeRevealSuccess({
      revealed: 0,
      candidatesFound: 3,
      alreadyRevealedCount: 1,
      phoneRequested: false,
      phonesFound: 0,
      emailDeliverable: null,
      emailVerifyReason: null,
      contactOutUsed: false,
      contactOutLocked: false,
      contactOutError: null,
      contactOutConfigured: true,
      contactOutRetryAt: null,
      apolloMobileSkipped: 0,
      contact: null,
    });
    const html = render({ contacts: [contact(), UNREVEALED], outcome });
    expect(html).toContain("already revealed");
    expect(html).toContain("no credits spent");
    expect(html).toContain("Find additional contact");
  });
});

describe("DiscoveryContactPanel — unrevealed contacts present", () => {
  it("shows who exists before a credit is spent", () => {
    const html = render({ contacts: [UNREVEALED] });
    expect(html).toContain("Found, not yet revealed (1)");
    expect(html).toContain("no credits spent");
    expect(html).toContain("Micah Cl***r");
    expect(html).toContain("Discovered — not revealed");
  });

  it("separates revealed from unrevealed", () => {
    const html = render({ contacts: [contact(), UNREVEALED] });
    expect(html).toContain("Revealed (1)");
    expect(html).toContain("Found, not yet revealed (1)");
  });

  it("hides Find additional contact while nothing is revealed", () => {
    expect(render({ contacts: [UNREVEALED] })).not.toContain(
      "Find additional contact",
    );
  });

  it("does not name a job posting for a company that has none", () => {
    const html = render({ contacts: [UNREVEALED], jobLocation: null });
    expect(html).not.toContain("Location not verified for this posting");
    expect(html).toContain("no job posting on file to verify against");
  });
});

describe("DiscoveryContactPanel — collapsed-equivalent empty state", () => {
  it("explains the flow when no contacts exist yet", () => {
    const html = render({ contacts: [] });
    expect(html).toContain("No contacts on file yet");
    expect(html).toContain("one credit");
  });

  it("shows a loading line on the first free read", () => {
    expect(render({ loading: true })).toContain("Loading contacts…");
  });

  it("reports a failed free read without pretending a reveal happened", () => {
    const html = render({
      contacts: [],
      loadError: "Network error — could not load the contacts on file.",
    });
    expect(html).toContain("could not load the contacts on file");
  });
});

describe("DiscoveryContactPanel — each distinct failure reaches the operator", () => {
  const cases: Array<[string, ReturnType<typeof describeRevealFailure>, string]> = [
    [
      "missing Apollo key",
      describeRevealFailure(503, "APOLLO_API_KEY is not configured."),
      "Apollo is not configured",
    ],
    [
      "daily Apollo cap",
      describeRevealFailure(
        403,
        "apollo daily safety cap reached — 240/240 estimated credits used since midnight ET.",
      ),
      "Daily Apollo cap reached",
    ],
    [
      "ContactOut credits exhausted",
      describeRevealFailure(403, "contactout is out of credits", {
        contactOutRetryAt: "2026-08-22T19:41:00.000Z",
      }),
      "ContactOut credits exhausted, retry after 3:41 PM ET",
    ],
    [
      "paid egress disabled",
      describeRevealFailure(403, "apollo paid egress is disabled for people/match"),
      "Paid lookups are switched off",
    ],
    [
      "timeout",
      describeRevealFailure(504, null),
      "longer than the request allows",
    ],
    [
      "provider 502",
      describeRevealFailure(502, "Apollo returned HTTP 500"),
      "Apollo returned HTTP 500",
    ],
  ];

  for (const [name, outcome, expected] of cases) {
    it(`renders the ${name} message as an alert`, () => {
      const html = render({ contacts: [], outcome });
      expect(html).toContain("role=\"alert\"");
      expect(html).toContain(expected);
    });
  }

  it("says the approval stuck when only the reveal failed", () => {
    const html = render({
      contacts: [],
      outcome: describeRevealFailure(403, "blocked", {
        reviewStatusApplied: true,
      }),
    });
    expect(html).toContain("moved to Approved");
  });
});
