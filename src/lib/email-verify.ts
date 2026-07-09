import { promises as dns } from "dns";

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "tempmail.com",
  "throwaway.email",
  "yopmail.com",
  "10minutemail.com",
]);

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export type EmailVerifyResult = {
  email: string;
  deliverable: boolean;
  reason: string;
};

function pickEmail(contact: {
  personalEmail?: string | null;
  workEmail?: string | null;
  email?: string | null;
}): string | null {
  return (
    contact.personalEmail?.trim() ||
    contact.workEmail?.trim() ||
    contact.email?.trim() ||
    null
  );
}

export async function verifyEmailAddress(
  email: string,
): Promise<EmailVerifyResult> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return { email: normalized, deliverable: false, reason: "invalid_format" };
  }

  const domain = normalized.split("@")[1];
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { email: normalized, deliverable: false, reason: "disposable_domain" };
  }

  try {
    const mx = await dns.resolveMx(domain);
    if (!mx?.length) {
      return { email: normalized, deliverable: false, reason: "no_mx" };
    }
    return { email: normalized, deliverable: true, reason: "mx_ok" };
  } catch {
    return { email: normalized, deliverable: false, reason: "dns_failed" };
  }
}

export async function verifyContactEmail(contact: {
  personalEmail?: string | null;
  workEmail?: string | null;
  email?: string | null;
}): Promise<EmailVerifyResult | null> {
  const address = pickEmail(contact);
  if (!address) return null;
  return verifyEmailAddress(address);
}
