/**
 * Integration verification for the Aug 15 outreach changes:
 *
 *   1. A phone-only contact (the "Outreach skipped: no email address" case)
 *      now enrolls with a text_only plan: only text steps drafted, the
 *      enrollment carries a NULL email address cleanly, and the flow engine
 *      skips the email send nodes and queues the day-0 text without erroring.
 *   2. A company with 3 mixed contacts (email+phone, email-only, phone-only)
 *      enrolls ALL of them via enrollCompanyContacts BEFORE any dispatch —
 *      the company stays "new" during the enrolls, so no contact is refused
 *      with "company status is contacted".
 *   3. Re-running the multi-enroll on the same company is idempotent — no
 *      duplicate enrollments.
 *
 * Safety: outreach dry-run is switched ON for the duration (email dispatch
 * exits before sending and the Mac worker's queue endpoint returns nothing
 * in dry-run) and restored in the finally block. Probe emails have real MX
 * (gmail.com) but can never be sent to; probe phones are +1500555xxxx test
 * numbers. Every scratch row is deleted in the finally block.
 *
 * Usage: npx tsx scripts/verify-text-only-enroll.ts
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import { and, eq, inArray } from "drizzle-orm";
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
import { enrollCompanyContacts, enrollContact } from "@/lib/outreach/enroll";

const PROBE_EMAIL_A = "probe-multi-enroll-a@gmail.com";
const PROBE_EMAIL_B = "probe-multi-enroll-b@gmail.com";
const PROBE_PHONE_SOLO = "+15005550197";
const PROBE_PHONE_A = "+15005550198";
const PROBE_PHONE_C = "+15005550199";

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
    .where(eq(contacts.email, PROBE_EMAIL_A))
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

  const [soloCompany] = await db
    .insert(companies)
    .values({
      name: "ZZ Text Only Probe (delete me)",
      status: "new",
      firstSeen: new Date().toISOString().slice(0, 10),
    })
    .returning();
  const [multiCompany] = await db
    .insert(companies)
    .values({
      name: "ZZ Multi Enroll Probe (delete me)",
      status: "new",
      firstSeen: new Date().toISOString().slice(0, 10),
    })
    .returning();
  const companyIds = [soloCompany!.id, multiCompany!.id];

  try {
    console.log("\nCase 1: phone-only contact enrolls with a text_only plan");
    const [soloContact] = await db
      .insert(contacts)
      .values({
        companyId: soloCompany!.id,
        name: "Probe Phone Only",
        title: "Office Manager",
        phone: PROBE_PHONE_SOLO,
        // NOT imessage-capable: the worker's IDS check + SMS fallback means
        // this must not block a text-only enrollment.
        imessageCapable: false,
      })
      .returning();

    const solo = await enrollContact(soloContact!.id, {
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    check(
      "enrollContact succeeds instead of 'no email address'",
      solo.enrolled === true,
      solo.enrolled ? undefined : `reason: ${(solo as { reason: string }).reason}`,
    );
    if (solo.enrolled) {
      check("channelPlan is text_only", solo.channelPlan === "text_only", solo.channelPlan);
      const [enr] = await db
        .select()
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, solo.enrollmentId))
        .limit(1);
      check("enrollment.emailAddress is NULL", enr?.emailAddress === null);
      check(
        "enrollment.phoneNumber carries the phone",
        enr?.phoneNumber === PROBE_PHONE_SOLO,
        String(enr?.phoneNumber),
      );
      check(
        "enrollment stayed active (flow engine did not pause on missing email steps)",
        enr?.status === "active",
        enr?.status,
      );
      check(
        "flow advanced past the email intro node to the day-0 text",
        enr?.currentNodeId === "send_text_1",
        String(enr?.currentNodeId),
      );

      const msgs = await db
        .select()
        .from(outreachMessages)
        .where(eq(outreachMessages.enrollmentId, solo.enrollmentId));
      check(
        "only text-channel steps drafted",
        msgs.length === 3 && msgs.every((m) => m.channel === "imessage"),
        msgs.map((m) => `${m.stepKind}/${m.channel}`).join(", "),
      );
      const text1 = msgs.find((m) => m.stepKind === "text_1");
      check(
        "day-0 text queued without erroring on missing email steps",
        text1?.status === "queued" && text1.scheduledFor != null,
        `text_1: ${text1?.status}`,
      );
      const skipEvents = await db
        .select()
        .from(enrollmentEvents)
        .where(
          and(
            eq(enrollmentEvents.enrollmentId, solo.enrollmentId),
            eq(enrollmentEvents.eventType, "rule_action"),
          ),
        );
      check(
        "email intro node explicitly skipped (skip_email_step logged)",
        skipEvents.some(
          (e) => (e.payload as { action?: string })?.action === "skip_email_step",
        ),
      );
    }

    console.log(
      "\nCase 2: 3 mixed contacts all enroll BEFORE any dispatch (company stays new)",
    );
    const [contactA] = await db
      .insert(contacts)
      .values({
        companyId: multiCompany!.id,
        name: "Probe HR Director",
        title: "HR Director",
        email: PROBE_EMAIL_A,
        phone: PROBE_PHONE_A,
        imessageCapable: true,
      })
      .returning();
    const [contactB] = await db
      .insert(contacts)
      .values({
        companyId: multiCompany!.id,
        name: "Probe CEO",
        title: "CEO",
        email: PROBE_EMAIL_B,
        imessageCapable: false,
      })
      .returning();
    const [contactC] = await db
      .insert(contacts)
      .values({
        companyId: multiCompany!.id,
        name: "Probe Office Manager",
        title: "Office Manager",
        phone: PROBE_PHONE_C,
        imessageCapable: false,
      })
      .returning();

    const summary = await enrollCompanyContacts({
      companyId: multiCompany!.id,
      primaryContactId: contactA!.id,
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    check(
      "all 3 contacts attempted",
      summary.outcomes.length === 3,
      `attempted: ${summary.outcomes.length}`,
    );
    check(
      "all 3 contacts enrolled",
      summary.enrolledCount === 3,
      summary.outcomes
        .map((o) =>
          o.result.enrolled
            ? `${o.contactName}: ok`
            : `${o.contactName}: ${o.result.reason}`,
        )
        .join("; "),
    );
    check(
      "primary contact stays first",
      summary.outcomes[0]?.contactId === contactA!.id,
    );

    const planOf = (contactId: string) => {
      const o = summary.outcomes.find((x) => x.contactId === contactId);
      return o?.result.enrolled ? o.result.channelPlan : "not enrolled";
    };
    check("email+phone contact → email_and_text", planOf(contactA!.id) === "email_and_text", planOf(contactA!.id));
    check("email-only contact → email_only", planOf(contactB!.id) === "email_only", planOf(contactB!.id));
    check("phone-only contact → text_only", planOf(contactC!.id) === "text_only", planOf(contactC!.id));

    const [companyAfter] = await db
      .select({ status: companies.status })
      .from(companies)
      .where(eq(companies.id, multiCompany!.id))
      .limit(1);
    check(
      "company still 'new' after all enrolls (no dispatch ran in dry-run)",
      companyAfter?.status === "new",
      companyAfter?.status,
    );
    check("dispatched=false in dry-run", summary.dispatched === false);

    const multiEnrollments = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.companyId, multiCompany!.id));
    check(
      "3 enrollments exist for the company",
      multiEnrollments.length === 3,
      String(multiEnrollments.length),
    );
    const enrollmentIds = multiEnrollments.map((e) => e.id);
    const multiMsgs = enrollmentIds.length
      ? await db
          .select()
          .from(outreachMessages)
          .where(inArray(outreachMessages.enrollmentId, enrollmentIds))
      : [];
    const countFor = (contactId: string) => {
      const enr = multiEnrollments.find((e) => e.contactId === contactId);
      return multiMsgs.filter((m) => m.enrollmentId === enr?.id).length;
    };
    check("email_and_text drafted 6 steps", countFor(contactA!.id) === 6, String(countFor(contactA!.id)));
    check("email_only drafted 3 steps", countFor(contactB!.id) === 3, String(countFor(contactB!.id)));
    check("text_only drafted 3 steps", countFor(contactC!.id) === 3, String(countFor(contactC!.id)));

    console.log("\nCase 3: re-add of the same company is idempotent");
    const again = await enrollCompanyContacts({
      companyId: multiCompany!.id,
      primaryContactId: contactA!.id,
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    check(
      "second multi-enroll attempts nothing (everyone enrolled / cap reached)",
      again.outcomes.length === 0 && again.enrolledCount === 0,
      `attempted: ${again.outcomes.length}`,
    );
    const enrollmentsAfter = await db
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.companyId, multiCompany!.id));
    check(
      "no duplicate enrollments",
      enrollmentsAfter.length === 3,
      String(enrollmentsAfter.length),
    );
    const soloAgain = await enrollContact(soloContact!.id, {
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    check(
      "direct re-enroll of the phone-only contact refuses",
      soloAgain.enrolled === false &&
        soloAgain.reason === "already enrolled previously",
      soloAgain.enrolled ? "enrolled twice!" : soloAgain.reason,
    );
  } finally {
    const enrollmentRows = await db
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(inArray(sequenceEnrollments.companyId, companyIds));
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
      .where(inArray(callListEntries.companyId, companyIds));
    await db
      .delete(companyActivities)
      .where(inArray(companyActivities.companyId, companyIds));
    await db.delete(contacts).where(inArray(contacts.companyId, companyIds));
    await db.delete(companies).where(inArray(companies.id, companyIds));
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
