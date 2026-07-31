import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "@/lib/outreach/suppression";

/**
 * Signed one-click unsubscribe links (RFC 8058) for outreach sends.
 *
 * Gmail/Yahoo bulk-sender rules expect a List-Unsubscribe header; its absence
 * is one of the signals that lands cold email in Junk. The token is an HMAC
 * over the normalized recipient address, so the link works with no database
 * lookup and cannot be forged for another address.
 */

function secret(): string | null {
  return (
    process.env.OUTREACH_UNSUBSCRIBE_SECRET ??
    process.env.WORKER_API_KEY ??
    null
  );
}

export function appBaseUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL?.replace(/\/$/, "");
  if (vercel) return `https://${vercel}`;
  return null;
}

export function unsubscribeToken(email: string): string | null {
  const normalized = normalizeEmail(email);
  const key = secret();
  if (!normalized || !key) return null;
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = unsubscribeToken(email);
  if (!expected || !token) return false;
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(token, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Absolute unsubscribe URL, or null when base URL / secret are unset. */
export function buildUnsubscribeUrl(email: string): string | null {
  const base = appBaseUrl();
  const normalized = normalizeEmail(email);
  const token = unsubscribeToken(email);
  if (!base || !normalized || !token) return null;
  const params = new URLSearchParams({ email: normalized, token });
  return `${base}/api/unsubscribe?${params.toString()}`;
}
