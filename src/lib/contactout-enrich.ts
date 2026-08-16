import { isPersonalEmail } from "@/lib/phone-utils";
import {
  extractContactOutPhones,
  mergeSourcedPhones,
  type SourcedPhone,
} from "@/lib/contact-phones";
import {
  pickPersonalEmailFromList,
  pickWorkEmail,
} from "@/lib/contact-enrichment-limits";
import { isContactOutSampleResponse } from "@/lib/contactout-samples";
import {
  assertPaidEgressAllowed,
  recordProviderUsageEvent,
  type PaidEgressContext,
} from "@/lib/paid-egress";

const CONTACTOUT_LINKEDIN_URL = "https://api.contactout.com/v1/people/linkedin";

/**
 * Why a ContactOut call failed. A 404 is NOT a failure — it means ContactOut
 * genuinely has no profile for that LinkedIn URL. Everything else is a fault
 * we must surface, because an unreported 401/429 looks identical to
 * "no phone found" and silently degrades every reveal.
 */
export type ContactOutFailureReason =
  | "auth"
  | "out_of_credits"
  | "rate_limited"
  | "provider_error";

export type ContactOutApiError = {
  status: number;
  reason: ContactOutFailureReason;
};

export type ContactOutData = {
  personalEmail: string | null;
  /** Top personal emails ContactOut found (up to 2), best first. */
  personalEmails: string[];
  workEmail: string | null;
  personalPhone: string | null;
  phones: SourcedPhone[];
  phoneApiLocked: boolean;
  /** Set when ContactOut errored rather than simply having no data. */
  apiError: ContactOutApiError | null;
};

export function describeContactOutError(error: ContactOutApiError): string {
  switch (error.reason) {
    case "auth":
      return `ContactOut rejected the API key (HTTP ${error.status}) — check CONTACTOUT_API_KEY`;
    case "out_of_credits":
      return `ContactOut is out of credits (HTTP ${error.status})`;
    case "rate_limited":
      return `ContactOut rate-limited the request (HTTP ${error.status}) — retry shortly`;
    default:
      return `ContactOut request failed (HTTP ${error.status})`;
  }
}

export type ContactOutEnrichOptions = {
  needPersonalEmail?: boolean;
  needWorkEmail?: boolean;
  needPhone?: boolean;
};

function normalizeLinkedIn(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("http")) return trimmed;
  return `https://www.linkedin.com/in/${trimmed.replace(/^\/+/, "")}`;
}

/** All personal emails ContactOut returned, personal-domain ones first. */
function collectPersonalEmails(emails: unknown[], max = 2): string[] {
  const found: string[] = [];
  const push = (email: string | null | undefined) => {
    const e = email?.trim();
    if (e && isPersonalEmail(e) && !found.includes(e)) found.push(e);
  };
  for (const entry of emails) {
    if (typeof entry === "string") {
      push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, string>;
    push(obj.email || obj.value || obj.address);
  }
  return found.slice(0, max);
}

function pickPersonalEmail(emails: unknown[]): string | null {
  const strings: string[] = [];
  for (const entry of emails) {
    if (typeof entry === "string") {
      strings.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, string>;
    const email = obj.email || obj.value || obj.address;
    if (!email) continue;
    const type = (obj.type || obj.label || "").toLowerCase();
    if (type.includes("personal") || isPersonalEmail(email)) {
      return email;
    }
    strings.push(email);
  }
  return pickPersonalEmailFromList(strings);
}

function collectProfileLists(
  profile: Record<string, unknown>,
  keys: string[],
): unknown[] {
  const out: unknown[] = [];
  for (const key of keys) {
    const val = profile[key];
    if (Array.isArray(val)) out.push(...val);
    else if (typeof val === "string" && val) out.push(val);
  }
  return out;
}

function emptyContactOutData(
  overrides: Partial<ContactOutData> = {},
): ContactOutData {
  return {
    personalEmail: null,
    personalEmails: [],
    workEmail: null,
    personalPhone: null,
    phones: [],
    phoneApiLocked: false,
    apiError: null,
    ...overrides,
  };
}

function parseContactOutPayload(data: Record<string, unknown>): ContactOutData {
  if (isContactOutSampleResponse(data)) {
    return emptyContactOutData({ phoneApiLocked: true });
  }

  const profile = (data.profile ?? data.data ?? data) as Record<string, unknown>;
  const emailsRaw = collectProfileLists(profile, [
    "personal_email",
    "personal_emails",
    "emails",
    "email",
  ]);
  const phonesRaw = collectProfileLists(profile, [
    "phone",
    "phones",
    "mobile",
    "personal_phone",
  ]);
  const workEmailsRaw = collectProfileLists(profile, [
    "work_email",
    "work_emails",
  ]).map(String);

  const phones = extractContactOutPhones(phonesRaw);
  const personalPhone =
    phones.find((p) => p.kind === "mobile")?.number ?? phones[0]?.number ?? null;

  const personalEmails = collectPersonalEmails(emailsRaw, 2);
  return emptyContactOutData({
    personalEmail: pickPersonalEmail(emailsRaw) ?? personalEmails[0] ?? null,
    personalEmails,
    workEmail: pickWorkEmail(workEmailsRaw),
    personalPhone,
    phones,
  });
}

function mergeContactOutData(
  base: ContactOutData,
  phones: ContactOutData,
): ContactOutData {
  return {
    personalEmail: base.personalEmail ?? phones.personalEmail,
    personalEmails: [
      ...new Set([...base.personalEmails, ...phones.personalEmails]),
    ].slice(0, 2),
    workEmail: base.workEmail ?? phones.workEmail,
    personalPhone: phones.personalPhone ?? base.personalPhone,
    phones: mergeSourcedPhones(base.phones, phones.phones),
    phoneApiLocked: base.phoneApiLocked || phones.phoneApiLocked,
    apiError: base.apiError ?? phones.apiError,
  };
}

/** A 404 is a genuine "ContactOut has no profile", not a fault. */
function classifyFailure(status: number): ContactOutFailureReason | null {
  if (status === 404) return null;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "out_of_credits";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

type ContactOutFetch =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ContactOutApiError | null };

async function contactOutGet(
  apiKey: string,
  params: Record<string, string>,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<ContactOutFetch> {
  await assertPaidEgressAllowed("contactout", "people/linkedin", context, {
    companyId,
    estimatedCost: 1,
    metadata: { params },
  });
  const resp = await fetch(
    `${CONTACTOUT_LINKEDIN_URL}?${new URLSearchParams(params)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        token: apiKey,
      },
    },
  );
  if (!resp.ok) {
    const reason = classifyFailure(resp.status);
    if (!reason) return { ok: false, error: null };
    const body = await resp.text().catch(() => "");
    const error = { status: resp.status, reason };
    console.error(
      `ContactOut people/linkedin failed — ${describeContactOutError(error)}: ${body.slice(0, 300)}`,
    );
    // Logged as blocked/zero-cost so it shows up in the audit trail without
    // eating the daily safety cap.
    await recordProviderUsageEvent(
      "contactout",
      "people/linkedin",
      context ?? "automated_scrape",
      {
        companyId,
        recordsReturned: 0,
        estimatedCost: 0,
        blocked: true,
        metadata: {
          params,
          reason,
          status: resp.status,
          body: body.slice(0, 300),
        },
      },
    );
    return { ok: false, error };
  }
  const data = (await resp.json()) as Record<string, unknown>;
  await recordProviderUsageEvent("contactout", "people/linkedin", context ?? "automated_scrape", {
    companyId,
    recordsReturned: data ? 1 : 0,
    estimatedCost: 1,
    metadata: { params },
  });
  return { ok: true, data };
}

export async function enrichFromContactOut(
  linkedinUrl: string,
  apiKey: string,
  options: ContactOutEnrichOptions = {},
  context?: PaidEgressContext,
  companyId?: string,
): Promise<ContactOutData | null> {
  const needPersonalEmail = options.needPersonalEmail ?? true;
  const needWorkEmail = options.needWorkEmail ?? true;
  const needPhone = options.needPhone ?? true;

  if (!needPersonalEmail && !needWorkEmail && !needPhone) {
    return null;
  }

  const profile = normalizeLinkedIn(linkedinUrl);
  let base: ContactOutData | null = null;
  let apiError: ContactOutApiError | null = null;

  if (needPersonalEmail || needWorkEmail) {
    const emailTypes: string[] = [];
    if (needPersonalEmail) emailTypes.push("personal");
    if (needWorkEmail) emailTypes.push("work");
    const emailRes = await contactOutGet(apiKey, {
      profile,
      email_type: emailTypes.join(","),
    }, context, companyId);
    if (emailRes.ok) {
      base = parseContactOutPayload(emailRes.data);
      if (base.phoneApiLocked) return base;
    } else {
      apiError = emailRes.error;
      // A bad key, an empty balance or a rate limit will fail the phone call
      // in exactly the same way — don't burn a second request to prove it.
      if (apiError && apiError.reason !== "provider_error") {
        return emptyContactOutData({ apiError });
      }
      if (!needPhone) {
        // Email miss and no phone wanted — nothing left to fetch.
        return apiError ? emptyContactOutData({ apiError }) : null;
      }
    }
    // Email miss must NOT abort the phone lookup: ContactOut frequently has
    // a mobile for a person it has no email for.
  }

  if (!needPhone) {
    if (base?.personalEmail || base?.workEmail) return base;
    return apiError ? emptyContactOutData({ apiError }) : null;
  }

  const phoneRes = await contactOutGet(apiKey, {
    profile,
    include_phone: "true",
    email_type: "none",
  }, context, companyId);
  if (!phoneRes.ok) {
    apiError = phoneRes.error ?? apiError;
    if (base?.personalEmail || base?.workEmail) return { ...base, apiError };
    return apiError ? emptyContactOutData({ apiError }) : null;
  }

  const phoneResult = parseContactOutPayload(phoneRes.data);
  if (phoneResult.phoneApiLocked) {
    if (base?.personalEmail || base?.workEmail) {
      return { ...base, phoneApiLocked: true };
    }
    return phoneResult;
  }

  const merged = base
    ? mergeContactOutData(base, phoneResult)
    : { ...phoneResult, apiError };

  if (merged.personalEmail || merged.workEmail || merged.phones.length) {
    return merged;
  }
  return merged.apiError ? merged : null;
}

// Re-export for apollo-enrich company-level dedupe
export { applySharedLineFilter as dedupeCompanyPhones } from "@/lib/contact-phones";
