/**
 * Integration verification for the Aug 14 call-list enroll fix.
 *
 * Reproduces the exact failure the user hit — a freshly imported contact
 * (email_verified_at NULL) added to the Call List the same day — and proves
 * it now enrolls, using the real enrollContact against the live database:
 *
 *   unverified contact + real-MX email → inline verify → enrolled
 *   unverified contact + dead domain   → inline verify → clear failure reason
 *   second enroll of the same contact  → idempotent "already enrolled"
 *
 * Safety: outreach dry-run is switched ON for the duration (dispatch exits
 * before sending anything, both here and in the Vercel cron) and restored in
 * the finally block. Every scratch row is deleted in the finally block, so
 * nothing can ever be sent to the probe addresses.
 *
 * Usage: npx tsx scripts/verify-inline-enroll.ts
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  companyActivities,
  contacts,
  enrollmentEvents,
  outreachMessages,
  outreachSettings,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { enrollContact } from "@/lib/outreach/enroll";

const PROBE_EMAIL_OK = "inline-enroll-probe-ok@gmail.com";
const PROBE_EMAIL_DEAD = "inline-enroll-probe@no-mx-here.invalid";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const leftovers = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, PROBE_EMAIL_OK))
    .limit(1);
  if (leftovers.length) {
    throw new Error("previous probe rows still present — clean up first");
  }

  const [settings] = await db.select().from(outreachSettings).limit(1);
  if (!settings) throw new Error("no outreach settings row");
  const dryRunBefore = settings.dryRun;
  await db
    .update(outreachSettings)
    .set({ dryRun: true })
    .where(eq(outreachSettings.id, settings.id));
  console.log(`dry-run ON for the probe (was ${dryRunBefore})`);

  const [company] = await db
    .insert(companies)
    .values({
      name: "ZZ Inline Enroll Probe (delete me)",
      status: "new",
      firstSeen: new Date().toISOString().slice(0, 10),
    })
    .returning();
  const companyId = company!.id;

  try {
    // The user's exact case: imported today, never seen by the 7:30 AM
    // verify pass — email_verified_at NULL, email_deliverable NULL.
    const [contactOk] = await db
      .insert(contacts)
      .values({
        companyId,
        name: "Probe Inline Ok",
        email: PROBE_EMAIL_OK,
        imessageCapable: false,
      })
      .returning();

    console.log("\nCase 1: unverified contact with a real-MX email enrolls");
    const result = await enrollContact(contactOk!.id, {
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    check(
      "enrollContact succeeds",
      result.enrolled === true,
      result.enrolled ? undefined : `reason: ${(result as { reason: string }).reason}`,
    );
    const [afterOk] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactOk!.id))
      .limit(1);
    check("contact marked deliverable", afterOk?.emailDeliverable === true);
    check("verification timestamp persisted", afterOk?.emailVerifiedAt != null);
    if (result.enrolled) {
      const steps = await db
        .select({ id: outreachMessages.id, status: outreachMessages.status })
        .from(outreachMessages)
        .where(eq(outreachMessages.enrollmentId, result.enrollmentId));
      check("sequence steps drafted", steps.length > 0, `steps: ${steps.length}`);
    }

    console.log("\nCase 2: dead domain fails with a clear reason, marked false");
    const [contactDead] = await db
      .insert(contacts)
      .values({
        companyId,
        name: "Probe Inline Dead",
        email: PROBE_EMAIL_DEAD,
        imessageCapable: false,
      })
      .returning();
    const deadResult = await enrollContact(contactDead!.id, {
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    check("enroll refused", deadResult.enrolled === false);
    check(
      "reason names the verification failure",
      !deadResult.enrolled &&
        deadResult.reason.startsWith("email not deliverable ("),
      !deadResult.enrolled ? deadResult.reason : "enrolled",
    );
    const [afterDead] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactDead!.id))
      .limit(1);
    check("contact marked undeliverable", afterDead?.emailDeliverable === false);

    console.log("\nCase 3: re-enroll of the same contact is idempotent");
    const again = await enrollContact(contactOk!.id, {
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    check(
      "second enroll returns already-enrolled",
      again.enrolled === false && again.reason === "already enrolled previously",
      again.enrolled ? "enrolled twice!" : again.reason,
    );
  } finally {
    const enrollmentRows = await db
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.companyId, companyId));
    const enrollmentIds = enrollmentRows.map((r) => r.id);
    if (enrollmentIds.length) {
      await db
        .delete(outreachMessages)
        .where(inArray(outreachMessages.enrollmentId, enrollmentIds));
      await db
        .delete(enrollmentEvents)
        .where(inArray(enrollmentEvents.enrollmentId, enrollmentIds));
      await db
        .delete(sequenceEnrollments)
        .where(inArray(sequenceEnrollments.id, enrollmentIds));
    }
    await db
      .delete(callListEntries)
      .where(eq(callListEntries.companyId, companyId));
    await db
      .delete(companyActivities)
      .where(eq(companyActivities.companyId, companyId));
    await db.delete(contacts).where(eq(contacts.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await db
      .update(outreachSettings)
      .set({ dryRun: dryRunBefore })
      .where(eq(outreachSettings.id, settings.id));
    console.log(`\nscratch rows deleted, dry-run restored to ${dryRunBefore}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
