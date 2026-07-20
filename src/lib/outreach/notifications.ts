import { db } from "@/lib/db";
import { companyActivities, outreachNotifications } from "@/lib/db/schema";
import { sendAlertEmail } from "@/lib/alert-email";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";

/**
 * Reply notifications: in-app badge row + (per-intent toggleable) email alert
 * + follow-up task in companyActivities for actionable intents.
 */
export async function notifyReply(options: {
  intent: string;
  contactId?: string | null;
  companyId?: string | null;
  inboundMessageId?: string | null;
  contactName?: string | null;
  companyName?: string | null;
  snippet: string;
  createFollowUpTask?: boolean;
  notifyEmail?: string | null;
}): Promise<void> {
  await db.insert(outreachNotifications).values({
    intent: options.intent,
    contactId: options.contactId ?? null,
    companyId: options.companyId ?? null,
    inboundMessageId: options.inboundMessageId ?? null,
    snippet: options.snippet.slice(0, 500),
  });

  if (options.createFollowUpTask && options.companyId) {
    try {
      await db.insert(companyActivities).values({
        companyId: options.companyId,
        contactId: options.contactId ?? null,
        type: "note",
        summary: `Outreach reply (${options.intent})${
          options.contactName ? ` from ${options.contactName}` : ""
        }: ${options.snippet.slice(0, 300)}`,
        source: "outreach",
      });
    } catch (error) {
      console.error("[outreach] follow-up task insert failed", error);
    }
  }

  const settings = await getOrCreateOutreachSettings();
  const toggles = settings.notifyIntents ?? {};
  // Positive + info_request default ON; everything else opt-in.
  const defaultOn = ["positive", "positive_link_request", "info_request"];
  const enabled =
    toggles[options.intent] ?? defaultOn.includes(options.intent);
  if (!enabled) return;

  const to = options.notifyEmail;
  if (!to) return;
  await sendAlertEmail({
    toEmail: to,
    subject: `[Outreach] ${options.intent.replace(/_/g, " ")} reply${
      options.companyName ? ` — ${options.companyName}` : ""
    }`,
    html: `
      <h2 style="font-family:sans-serif">Outreach reply: ${options.intent}</h2>
      <p style="font-family:sans-serif">${
        options.contactName ? `<strong>${options.contactName}</strong>` : "A contact"
      }${options.companyName ? ` at <strong>${options.companyName}</strong>` : ""} replied:</p>
      <blockquote style="font-family:sans-serif;color:#333;border-left:3px solid #ccc;padding-left:12px">${options.snippet
        .slice(0, 800)
        .replace(/</g, "&lt;")}</blockquote>
      <p style="font-family:sans-serif;color:#666;font-size:12px">V Executive Search outreach sequencer</p>
    `,
  });
}
