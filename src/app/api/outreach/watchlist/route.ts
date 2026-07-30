import { inArray, isNotNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { outreachMessages, sequenceEnrollments } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Numbers + Message-IDs the worker should watch for inbound replies:
 * chat.db scan (texts from enrolled numbers) and IMAP threading match.
 */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  const enrollments = await db
    .select({
      phoneNumber: sequenceEnrollments.phoneNumber,
      status: sequenceEnrollments.status,
    })
    .from(sequenceEnrollments)
    .where(isNotNull(sequenceEnrollments.phoneNumber));

  // Watch every number that ever got a text — replies can arrive after a
  // sequence completes and must still be classified (STOP especially).
  const phones = [
    ...new Set(
      enrollments
        .map((e) => (e.phoneNumber ?? "").replace(/\D/g, "").slice(-10))
        .filter((p) => p.length === 10),
    ),
  ];

  const sentEmails = await db
    .select({ messageId: outreachMessages.messageId })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.channel, "email"),
        eq(outreachMessages.status, "sent"),
        isNotNull(outreachMessages.messageId),
      ),
    )
    .limit(2000);

  return NextResponse.json({
    phones,
    message_ids: sentEmails.map((m) => m.messageId).filter(Boolean),
  });
}
