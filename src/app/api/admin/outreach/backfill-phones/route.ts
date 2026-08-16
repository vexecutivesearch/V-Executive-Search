import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { backfillEnrollmentPhones } from "@/lib/outreach/phone-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Attach phone numbers found after enrollment to live email-only sequences.
 *
 * Runs automatically at the top of every dispatch pass; this endpoint is the
 * on-demand version. Idempotent — an enrollment that already has a number is
 * never touched again.
 */
export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await backfillEnrollmentPhones({ actor: "admin" });

  const parts = [`${summary.attached} enrollment(s) upgraded to email + text`];
  if (summary.dayZeroTextRestored > 0) {
    parts.push(
      `${summary.dayZeroTextRestored} had the intro text restored — it leads their text sequence`,
    );
  }
  if (summary.dayZeroTextMissed > 0) {
    parts.push(
      `${summary.dayZeroTextMissed} had already sent their intro email, so they resume at the next text step rather than a stale "just emailed you"`,
    );
  }
  if (summary.skippedNoPhone > 0) {
    parts.push(`${summary.skippedNoPhone} still have no phone number`);
  }
  if (summary.pendingCapabilityCheck > 0) {
    parts.push(
      `${summary.pendingCapabilityCheck} have a phone but no iMessage check yet — the Mac worker was asked to check them, retry after it runs`,
    );
  }
  if (summary.skippedSuppressed > 0) {
    parts.push(`${summary.skippedSuppressed} phone(s) suppressed`);
  }
  if (summary.skippedNotTextable > 0) {
    parts.push(`${summary.skippedNotTextable} marked not textable`);
  }

  return NextResponse.json({
    ok: true,
    ...summary,
    message: parts.join(" · "),
  });
}
