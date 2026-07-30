import { inArray, eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  outreachTemplates,
  type InboundIntent,
  type OutreachTemplate,
  type OutreachTemplateKind,
} from "@/lib/db/schema";
import { sanitizeExemplarForPrompt } from "@/lib/outreach/sanitizer";

/**
 * Reply template kinds that define how we answer after an inbound is classified.
 * The classifier reads these exemplars so intent → next email is deliberate,
 * not a hardcoded guess disconnected from the Template bank.
 */
export const REPLY_TEMPLATE_KINDS = [
  "reply_positive",
  "reply_info_request",
  "reply_decline",
] as const satisfies readonly OutreachTemplateKind[];

export type ReplyTemplateKind = (typeof REPLY_TEMPLATE_KINDS)[number];

/** Intent → which reply exemplar / draft kind goes out next. */
export const REPLY_KIND_BY_INTENT: Partial<
  Record<InboundIntent, ReplyTemplateKind>
> = {
  positive: "reply_positive",
  positive_link_request: "reply_positive",
  info_request: "reply_info_request",
  negative: "reply_decline",
};

const INTENT_LABEL: Record<ReplyTemplateKind, string> = {
  reply_positive:
    "positive (wants a call / agrees to meet) or positive_link_request (same, but asks for a calendar link)",
  reply_info_request:
    "info_request (asks a substantive question without committing to a call)",
  reply_decline:
    "negative (not interested / all set — polite or blunt decline)",
};

/** Active reply exemplars from the Template bank (style DNA for classify + draft). */
export async function loadActiveReplyPlaybook(): Promise<OutreachTemplate[]> {
  return db
    .select()
    .from(outreachTemplates)
    .where(
      and(
        eq(outreachTemplates.isActive, true),
        inArray(outreachTemplates.kind, [...REPLY_TEMPLATE_KINDS]),
      ),
    );
}

/** Build the playbook block injected into the classifier prompt. */
export function formatReplyPlaybookForClassifier(
  templates: OutreachTemplate[],
): string {
  const byKind = new Map<string, OutreachTemplate[]>();
  for (const t of templates) {
    const list = byKind.get(t.kind) ?? [];
    list.push(t);
    byKind.set(t.kind, list);
  }

  const sections: string[] = [];
  for (const kind of REPLY_TEMPLATE_KINDS) {
    const exemplars = byKind.get(kind) ?? [];
    const label = INTENT_LABEL[kind];
    if (!exemplars.length) {
      sections.push(
        `When intent is ${label}:\n(no active ${kind} exemplar in Template bank)`,
      );
      continue;
    }
    const bodies = exemplars
      .slice(0, 2)
      .map((t, i) => {
        const body = sanitizeExemplarForPrompt(t.exampleBody, 700);
        return `Exemplar ${i + 1} (${t.name}):\n"""\n${body}\n"""`;
      })
      .join("\n\n");
    sections.push(
      `When intent is ${label}, the NEXT email we send matches this voice (${kind}):\n${bodies}`,
    );
  }

  return `OUR RESPONSE PLAYBOOK (from Template bank — use these to decide which intent fits, because that intent picks which email goes out next):\n\n${sections.join("\n\n")}`;
}

export function replyKindForIntent(
  intent: InboundIntent,
): ReplyTemplateKind | null {
  return REPLY_KIND_BY_INTENT[intent] ?? null;
}
