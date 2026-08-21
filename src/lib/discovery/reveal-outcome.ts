/**
 * What the operator is told after clicking "Approve for enrichment".
 *
 * Pure translation of an approve-enrichment response into a headline plus
 * specific follow-ups. Every failure mode gets its own sentence: a silent
 * refresh, or a green "Enriched" over a ContactOut auth failure, is the exact
 * defect this module exists to prevent.
 */

export type RevealOutcomeTone = "success" | "warning" | "error";

export type RevealOutcome = {
  tone: RevealOutcomeTone;
  /** The one line to read first. */
  headline: string;
  /** Specific, actionable follow-ups. Never a bare "failed". */
  details: string[];
  /** Whether a reveal credit was actually spent on this click. */
  spentCredit: boolean;
};

export type RevealedContactSummary = {
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
};

/** The fields of the approve-enrichment 200 body this module reads. */
export type ApproveEnrichmentSuccess = {
  revealed: number;
  candidatesFound: number;
  alreadyRevealedCount: number;
  phoneRequested: boolean;
  phonesFound: number;
  emailDeliverable: boolean | null;
  emailVerifyReason: string | null;
  contactOutUsed: boolean;
  contactOutLocked: boolean;
  contactOutError: string | null;
  contactOutConfigured: boolean;
  contactOutRetryAt: string | null;
  apolloMobileSkipped: number;
  contact: RevealedContactSummary | null;
};

const ET = "America/New_York";

/** "3:41 PM ET" — the only clock the operator's caps and locks run on. */
export function formatEtTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `${time} ET`;
}

function contactOutExhaustedLine(retryAt: string | null): string {
  const at = formatEtTime(retryAt);
  return at
    ? `ContactOut credits exhausted, retry after ${at}`
    : "ContactOut credits exhausted — the 24h lock has to clear before another lookup";
}

function contactLabel(contact: RevealedContactSummary | null): string {
  if (!contact) return "the top-ranked decision-maker";
  return contact.title ? `${contact.name} · ${contact.title}` : contact.name;
}

/** Why no mobile came back, in the operator's terms. One line, always. */
function mobileDetail(r: ApproveEnrichmentSuccess): string {
  if (!r.phoneRequested) {
    return "Mobile was not requested — tick the ContactOut box before approving to look one up.";
  }
  if (r.phonesFound > 0) return "Mobile found via ContactOut (1 ContactOut credit).";
  if (r.contactOutLocked) return contactOutExhaustedLine(r.contactOutRetryAt);
  if (r.contactOutError) return r.contactOutError;
  if (!r.contactOutConfigured) {
    return "ContactOut is not configured on this deployment, so no mobile was looked up. Set CONTACTOUT_API_KEY.";
  }
  if (r.contactOutUsed) {
    return "ContactOut has no mobile for this contact. Apollo's mobile is 9 credits and less accurate, so nothing was charged for it.";
  }
  return "No ContactOut lookup ran — the contact has no LinkedIn URL to look up.";
}

function emailDetail(r: ApproveEnrichmentSuccess): string {
  if (r.emailDeliverable === true) return "Email verified (MX check passed).";
  if (r.emailDeliverable === false) {
    return `Email is risky — ${r.emailVerifyReason ?? "verification failed"}. Treat it as unconfirmed.`;
  }
  if (r.contact?.email) return "Email found but not verified.";
  return "No email found for this contact — Apollo had no address to reveal.";
}

export function describeRevealSuccess(
  r: ApproveEnrichmentSuccess,
): RevealOutcome {
  // Nothing was revealed. Each reason is a different operator decision, so
  // each gets its own headline rather than a shared "nothing happened".
  if (r.revealed === 0) {
    if (r.alreadyRevealedCount > 0) {
      return {
        tone: "warning",
        headline:
          "A decision-maker is already revealed here — no credits spent.",
        details: [
          "Use Find additional contact to reveal one more, which spends another credit.",
        ],
        spentCredit: false,
      };
    }
    if (r.candidatesFound === 0) {
      return {
        tone: "warning",
        headline: "No decision-maker candidates found for this company.",
        details: [
          "Apollo's people search returned nobody at this domain or company name. No reveal credit was spent.",
        ],
        spentCredit: false,
      };
    }
    return {
      tone: "warning",
      headline: `Every one of the ${r.candidatesFound} candidates here is already revealed — no credits spent.`,
      details: ["Open the company to see who exists and what is on file."],
      spentCredit: false,
    };
  }

  const details = [emailDetail(r), mobileDetail(r)];
  // A ContactOut fault during a reveal that otherwise succeeded is still a
  // fault: it changes what the operator can do next, so it is a warning.
  const degraded =
    r.contactOutLocked ||
    Boolean(r.contactOutError) ||
    r.emailDeliverable === false ||
    !r.contact?.email;

  details.push(
    "Stopped at one contact — Find additional contact is the only way to spend another credit.",
  );

  return {
    tone: degraded ? "warning" : "success",
    headline: `Revealed ${contactLabel(r.contact)}`,
    details,
    spentCredit: true,
  };
}

/**
 * A non-2xx approve-enrichment response. The message from the server is
 * already operator-readable (the paid-egress cap text, for instance), so it is
 * kept verbatim and given a headline that says what to do about it.
 */
export function describeRevealFailure(
  status: number,
  error: string | null | undefined,
  options: { contactOutRetryAt?: string | null; reviewStatusApplied?: boolean } = {},
): RevealOutcome {
  const message = error?.trim() || null;
  const details: string[] = [];
  let headline: string;

  if (status === 503 && /APOLLO_API_KEY/i.test(message ?? "")) {
    headline = "Apollo is not configured on this deployment — nothing ran.";
    details.push("Set APOLLO_API_KEY in the Vercel project and redeploy.");
  } else if (status === 403 && /apollo daily safety cap/i.test(message ?? "")) {
    headline = "Daily Apollo cap reached — no credits spent.";
    if (message) details.push(message);
  } else if (
    status === 403 &&
    /contactout daily safety cap/i.test(message ?? "")
  ) {
    headline = "Daily ContactOut cap reached — no credits spent.";
    if (message) details.push(message);
  } else if (status === 403 && /out of credits|exhaust/i.test(message ?? "")) {
    headline = contactOutExhaustedLine(options.contactOutRetryAt ?? null);
    if (message) details.push(message);
  } else if (status === 403 && /paid egress is disabled/i.test(message ?? "")) {
    headline = "Paid lookups are switched off — nothing was charged.";
    if (message) details.push(message);
    details.push(
      "Re-enable the provider in the environment before approving again.",
    );
  } else if (status === 403) {
    headline = "Blocked before any paid call — no credits spent.";
    if (message) details.push(message);
  } else if (status === 404 || /company not found/i.test(message ?? "")) {
    headline = "This company is no longer in the database.";
    details.push("Reload the queue — the row is stale.");
  } else if (status === 504 || status === 408) {
    headline = "The reveal ran longer than the request allows.";
    details.push(
      "Apollo or ContactOut may still have completed it — reopen this row before approving again so you do not pay twice.",
    );
  } else {
    headline = "The reveal failed — check the provider before retrying.";
    if (message) details.push(message);
  }

  if (options.reviewStatusApplied) {
    details.push(
      "The company was still moved to Approved, so it is in the Approved bucket with nothing revealed.",
    );
  }

  return { tone: "error", headline, details, spentCredit: false };
}

/** The fetch never completed — distinct from a server-side failure. */
export function describeRevealNetworkFailure(): RevealOutcome {
  return {
    tone: "error",
    headline: "The request never reached the server.",
    details: [
      "Nothing was charged. Check the connection and try again — the reveal did not run.",
    ],
    spentCredit: false,
  };
}
