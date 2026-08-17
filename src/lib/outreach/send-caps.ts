import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachMessages } from "@/lib/db/schema";

/**
 * The system daily send cap is enforced PER CHANNEL.
 *
 * It used to be a single all-channel total, which meant the two transports
 * competed for one budget even though they are dispatched by different systems
 * and constrained by completely different things. Email is limited by domain
 * reputation and warm-up; texts are limited by what a single Mac mini and
 * Apple's rate limits will carry. On 2026-08-17 that coupling cost 71 intro
 * emails: 83 emails plus 73 texts hit the shared 100 first, and the email loop
 * deferred everything after that while the sending pool still had headroom.
 *
 * So the configured number is a ceiling for email AND a ceiling for text,
 * counted independently.
 */
export type SendChannel = "email" | "imessage";

export async function sentTodayOnChannel(
  channel: SendChannel,
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.status, "sent"),
        eq(outreachMessages.channel, channel),
        gte(outreachMessages.sentAt, startOfDay),
      ),
    );
  return Number(row?.count ?? 0);
}

/** Sends still allowed on this channel today. Infinity when uncapped (0). */
export function remainingToday(cap: number, sentToday: number): number {
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, cap - sentToday);
}
