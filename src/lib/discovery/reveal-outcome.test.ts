import { describe, expect, it } from "vitest";
import {
  describeRevealFailure,
  describeRevealNetworkFailure,
  describeRevealSuccess,
  formatEtTime,
  type ApproveEnrichmentSuccess,
} from "@/lib/discovery/reveal-outcome";

/** A clean single reveal: one contact, verified email, no phone requested. */
const BASE: ApproveEnrichmentSuccess = {
  revealed: 1,
  candidatesFound: 3,
  alreadyRevealedCount: 0,
  phoneRequested: false,
  phonesFound: 0,
  emailDeliverable: true,
  emailVerifyReason: null,
  contactOutUsed: false,
  contactOutLocked: false,
  contactOutError: null,
  contactOutConfigured: true,
  contactOutRetryAt: null,
  apolloMobileSkipped: 0,
  contact: {
    name: "Joe Carosella",
    title: "Director & Co-Owner",
    email: "jcarosella@cdri.net",
    phone: null,
  },
};

const s = (over: Partial<ApproveEnrichmentSuccess> = {}) =>
  describeRevealSuccess({ ...BASE, ...over });

describe("describeRevealSuccess — the reveal landed", () => {
  it("names the contact it spent the credit on", () => {
    const out = s();
    expect(out.tone).toBe("success");
    expect(out.headline).toBe("Revealed Joe Carosella · Director & Co-Owner");
    expect(out.spentCredit).toBe(true);
  });

  it("says the mobile was not requested rather than 'no phone found'", () => {
    expect(s().details).toContain(
      "Mobile was not requested — tick the ContactOut box before approving to look one up.",
    );
  });

  it("reports the verified email as verified", () => {
    expect(s().details).toContain("Email verified (MX check passed).");
  });

  it("always states the one-contact stop", () => {
    expect(s().details.some((d) => d.includes("Stopped at one contact"))).toBe(
      true,
    );
  });

  it("confirms a ContactOut mobile when one came back", () => {
    const out = s({ phoneRequested: true, phonesFound: 1, contactOutUsed: true });
    expect(out.tone).toBe("success");
    expect(out.details).toContain(
      "Mobile found via ContactOut (1 ContactOut credit).",
    );
  });
});

describe("describeRevealSuccess — every distinct partial failure", () => {
  it("distinguishes 'ContactOut has no mobile' from a ContactOut fault", () => {
    const out = s({ phoneRequested: true, contactOutUsed: true });
    expect(out.tone).toBe("success");
    expect(
      out.details.some((d) => d.startsWith("ContactOut has no mobile for this contact")),
    ).toBe(true);
  });

  it("reports an exhausted ContactOut balance with the retry time", () => {
    const out = s({
      phoneRequested: true,
      contactOutUsed: true,
      contactOutLocked: true,
      contactOutRetryAt: "2026-08-22T19:41:00.000Z",
    });
    expect(out.tone).toBe("warning");
    expect(out.details).toContain(
      "ContactOut credits exhausted, retry after 3:41 PM ET",
    );
  });

  it("falls back to the 24h lock wording when no expiry is known", () => {
    const out = s({
      phoneRequested: true,
      contactOutUsed: true,
      contactOutLocked: true,
    });
    expect(
      out.details.some((d) => d.includes("ContactOut credits exhausted")),
    ).toBe(true);
  });

  it("surfaces a ContactOut auth failure instead of burying it in a green line", () => {
    const out = s({
      phoneRequested: true,
      contactOutUsed: true,
      contactOutError:
        "ContactOut rejected the API key (HTTP 401) — check CONTACTOUT_API_KEY",
    });
    expect(out.tone).toBe("warning");
    expect(out.details).toContain(
      "ContactOut rejected the API key (HTTP 401) — check CONTACTOUT_API_KEY",
    );
  });

  it("says ContactOut is unconfigured rather than 'no mobile'", () => {
    const out = s({ phoneRequested: true, contactOutConfigured: false });
    expect(
      out.details.some((d) => d.includes("ContactOut is not configured")),
    ).toBe(true);
  });

  it("blames the missing LinkedIn URL when ContactOut never ran", () => {
    const out = s({ phoneRequested: true, contactOutUsed: false });
    expect(
      out.details.some((d) => d.includes("no LinkedIn URL to look up")),
    ).toBe(true);
  });

  it("marks a risky email as a warning and gives the reason", () => {
    const out = s({ emailDeliverable: false, emailVerifyReason: "no MX record" });
    expect(out.tone).toBe("warning");
    expect(out.details).toContain(
      "Email is risky — no MX record. Treat it as unconfirmed.",
    );
  });

  it("warns when the reveal produced no email at all", () => {
    const out = s({
      emailDeliverable: null,
      contact: { name: "Micah Cluster", title: "President", email: null, phone: null },
    });
    expect(out.tone).toBe("warning");
    expect(out.details).toContain(
      "No email found for this contact — Apollo had no address to reveal.",
    );
  });
});

describe("describeRevealSuccess — nothing was revealed", () => {
  it("says a contact is already revealed and points at the explicit action", () => {
    const out = s({ revealed: 0, alreadyRevealedCount: 1 });
    expect(out.tone).toBe("warning");
    expect(out.spentCredit).toBe(false);
    expect(out.headline).toContain("already revealed");
    expect(
      out.details.some((d) => d.includes("Find additional contact")),
    ).toBe(true);
  });

  it("says Apollo found nobody, and that nothing was charged", () => {
    const out = s({ revealed: 0, candidatesFound: 0 });
    expect(out.headline).toBe(
      "No decision-maker candidates found for this company.",
    );
    expect(out.details.join(" ")).toContain("No reveal credit was spent");
  });

  it("counts the exhausted candidate pool", () => {
    const out = s({ revealed: 0, candidatesFound: 4, alreadyRevealedCount: 0 });
    expect(out.headline).toBe(
      "Every one of the 4 candidates here is already revealed — no credits spent.",
    );
  });
});

describe("describeRevealFailure — one message per failure mode", () => {
  it("names the missing Apollo key", () => {
    const out = describeRevealFailure(503, "APOLLO_API_KEY is not configured.");
    expect(out.tone).toBe("error");
    expect(out.headline).toContain("Apollo is not configured");
    expect(out.details.join(" ")).toContain("APOLLO_API_KEY");
  });

  it("reports the daily Apollo cap as a cap, not a provider error", () => {
    const message =
      "apollo daily safety cap reached — 240/240 estimated credits used since midnight ET. " +
      "This is the app's own guardrail, not your apollo balance; " +
      "set APOLLO_DAILY_CREDIT_CAP on Vercel to raise it. Resets at midnight ET.";
    const out = describeRevealFailure(403, message);
    expect(out.headline).toBe("Daily Apollo cap reached — no credits spent.");
    expect(out.details).toContain(message);
  });

  it("reports the daily ContactOut cap separately", () => {
    const out = describeRevealFailure(
      403,
      "contactout daily safety cap reached — 50/50 estimated credits used since midnight ET.",
    );
    expect(out.headline).toBe("Daily ContactOut cap reached — no credits spent.");
  });

  it("gives the retry time when a 403 is a spent ContactOut balance", () => {
    const out = describeRevealFailure(403, "contactout is out of credits", {
      contactOutRetryAt: "2026-08-22T19:41:00.000Z",
    });
    expect(out.headline).toBe(
      "ContactOut credits exhausted, retry after 3:41 PM ET",
    );
  });

  it("says paid egress is switched off rather than 'failed'", () => {
    const out = describeRevealFailure(
      403,
      "contactout paid egress is disabled for people/linkedin",
    );
    expect(out.headline).toContain("Paid lookups are switched off");
  });

  it("tells the operator the row is stale on a 404", () => {
    const out = describeRevealFailure(404, "Not found");
    expect(out.headline).toContain("no longer in the database");
  });

  it("warns about a double charge after a timeout", () => {
    const out = describeRevealFailure(504, null);
    expect(out.headline).toContain("longer than the request allows");
    expect(out.details.join(" ")).toContain("do not pay twice");
  });

  it("keeps a provider message verbatim on a 502", () => {
    const out = describeRevealFailure(502, "Apollo returned HTTP 500");
    expect(out.details).toContain("Apollo returned HTTP 500");
  });

  it("says when the approval stuck even though the reveal did not", () => {
    const out = describeRevealFailure(403, "blocked", {
      reviewStatusApplied: true,
    });
    expect(out.details.join(" ")).toContain("moved to Approved");
  });
});

describe("describeRevealNetworkFailure", () => {
  it("is explicit that nothing ran and nothing was charged", () => {
    const out = describeRevealNetworkFailure();
    expect(out.tone).toBe("error");
    expect(out.details.join(" ")).toContain("Nothing was charged");
    expect(out.spentCredit).toBe(false);
  });
});

describe("formatEtTime", () => {
  it("renders the lock expiry on the business clock", () => {
    expect(formatEtTime("2026-08-22T19:41:00.000Z")).toBe("3:41 PM ET");
  });

  it("returns null for absent or unparseable input", () => {
    expect(formatEtTime(null)).toBeNull();
    expect(formatEtTime("not a date")).toBeNull();
  });
});
