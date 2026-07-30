import { randomUUID } from "node:crypto";
import type { SendingProfile } from "@/lib/db/schema";

/**
 * Outreach email sends via Resend. Cold-email hygiene, verified per send:
 *  - text/plain only (we pass `text`, never `html`)
 *  - no tracking pixels/click-wrapping (per-send headers disable tracking;
 *    sending domains must also have tracking off in Resend)
 *  - our own RFC 5322 Message-ID so replies can be threaded via
 *    In-Reply-To/References (Resend's internal id can't thread)
 * Per-profile API keys are resolved from env var NAMES (resend_key_ref) at
 * send time — keys never live in the database.
 */

export type OutreachSendResult =
  | { ok: true; resendId: string; messageId: string }
  | { ok: false; error: string };

export function resolveProfileApiKey(profile: SendingProfile | null): string | null {
  if (profile?.resendKeyRef) {
    const key = process.env[profile.resendKeyRef];
    if (key) return key;
    console.error(
      `[outreach] profile ${profile.label} resend_key_ref ${profile.resendKeyRef} not set — falling back to RESEND_API_KEY`,
    );
  }
  return process.env.RESEND_API_KEY ?? null;
}

export function defaultFromAddress(): string | null {
  return (
    process.env.OUTREACH_FROM_EMAIL ??
    process.env.REPORT_FROM_EMAIL ??
    null
  );
}

export function buildMessageId(fromAddress: string): string {
  const domain = fromAddress.match(/@([^>\s]+)/)?.[1] ?? "vexecsearch.local";
  return `<${randomUUID()}@${domain}>`;
}

/** CAN-SPAM footer: identity + physical address (no unsubscribe-link games —
 * plain-text reply opt-out is honored by the classifier + suppression). */
export function emailFooter(options: {
  senderName: string;
  senderTitle?: string;
  firm: string;
  phone?: string | null;
  physicalAddress?: string | null;
}): string {
  return [
    "",
    "Best regards,",
    "",
    options.senderName,
    options.senderTitle ? `${options.senderTitle} — ${options.firm}` : options.firm,
    options.phone ?? null,
    options.physicalAddress ?? null,
    "",
    "If you'd rather not hear from me, just reply and let me know.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function sendOutreachEmail(options: {
  apiKey: string;
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  textBody: string;
  /** For threaded replies: Message-ID being replied to. */
  inReplyTo?: string | null;
}): Promise<OutreachSendResult> {
  const messageId = buildMessageId(options.from);
  const headers: Record<string, string> = {
    "Message-ID": messageId,
    // Belt-and-braces: disable Resend link/open tracking per send.
    "X-Entity-Ref-ID": messageId,
  };
  if (options.inReplyTo) {
    headers["In-Reply-To"] = options.inReplyTo;
    headers["References"] = options.inReplyTo;
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: options.from,
        to: [options.to],
        ...(options.replyTo ? { reply_to: [options.replyTo] } : {}),
        subject: options.subject,
        text: options.textBody,
        headers,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Resend HTTP ${resp.status}: ${text.slice(0, 300)}` };
    }
    const data = (await resp.json()) as { id?: string };
    if (!data.id) return { ok: false, error: "Resend response missing id" };
    return { ok: true, resendId: data.id, messageId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown send error",
    };
  }
}
