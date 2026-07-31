/**
 * Integration verification for the Jul 30 status-pipeline fixes (704d04b).
 *
 * Walks a SCRATCH lead through tomorrow's exact test path using the real
 * production functions against the live database:
 *
 *   positive reply → Replied — Interested (not Call Booked)
 *   courtesy reply → cannot demote
 *   Calendly booking → Call Booked + SMS confirmation queued
 *   later replies → cannot demote a booked call
 *   Calendly cancel → reverts to Replied — Interested
 *   opt-out → terminal wins from anywhere, then locks
 *
 * Every row it creates is deleted in the finally block; the queued
 * confirmation text is cancelled the instant it is asserted so the Mac
 * worker can never pick it up. Reads/writes only its own scratch rows.
 *
 * Usage: npx tsx scripts/verify-status-pipeline.ts
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
  inboundMessages,
  outreachMessages,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { applyCalendlyBooking } from "@/lib/outreach/calendly-booking";
import {
  callStatusForReplyIntent,
  recordCallListOutreachEvent,
} from "@/lib/outreach/call-list-sync";

const PROBE_EMAIL = "status-probe@verification.invalid";
const PROBE_PHONE = "+15005550100";

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

async function callStatusOf(companyId: string): Promise<string> {
  const [row] = await db
    .select({ callStatus: callListEntries.callStatus })
    .from(callListEntries)
    .where(eq(callListEntries.companyId, companyId))
    .limit(1);
  return row?.callStatus ?? "(no row)";
}

async function main() {
  // Refuse to run if a previous probe left anything behind.
  const leftovers = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, PROBE_EMAIL))
    .limit(1);
  if (leftovers.length) {
    throw new Error("previous probe rows still present — clean up first");
  }

  const [company] = await db
    .insert(companies)
    .values({
      name: "ZZ Status Pipeline Probe (delete me)",
      status: "contacted",
      firstSeen: new Date().toISOString().slice(0, 10),
    })
    .returning();
  const companyId = company!.id;
  let enrollmentId: string | null = null;

  try {
    const [contact] = await db
      .insert(contacts)
      .values({
        companyId,
        name: "Probe Person",
        email: PROBE_EMAIL,
        phone: PROBE_PHONE,
      })
      .returning();

    await db.insert(callListEntries).values({
      companyId,
      callStatus: "email_sent",
      notes: "[probe] scratch row",
    });

    const [enrollment] = await db
      .insert(sequenceEnrollments)
      .values({
        contactId: contact!.id,
        companyId,
        status: "replied_positive",
        emailAddress: PROBE_EMAIL,
        phoneNumber: PROBE_PHONE,
        timezone: "America/New_York",
      })
      .returning();
    enrollmentId = enrollment!.id;

    // The conversation lives on SMS: one inbound iMessage.
    await db.insert(inboundMessages).values({
      channel: "imessage",
      fromAddress: PROBE_PHONE,
      rawBody: "yes lets talk",
      enrollmentId,
      contactId: contact!.id,
      classifiedIntent: "positive",
    });

    console.log("\nH13 positive reply maps to Replied — Interested");
    check(
      "callStatusForReplyIntent('positive') = replied_interested",
      callStatusForReplyIntent("positive") === "replied_interested",
    );
    await recordCallListOutreachEvent({
      companyId,
      contactId: contact!.id,
      summary: "probe: positive reply",
      callStatus: callStatusForReplyIntent("positive"),
    });
    check(
      "email_sent advances to replied_interested",
      (await callStatusOf(companyId)) === "replied_interested",
      await callStatusOf(companyId),
    );

    console.log("\nH14 courtesy reply cannot demote");
    await recordCallListOutreachEvent({
      companyId,
      contactId: contact!.id,
      summary: "probe: courtesy reply",
      callStatus: callStatusForReplyIntent("courtesy"),
    });
    check(
      "replied_interested survives a courtesy reply",
      (await callStatusOf(companyId)) === "replied_interested",
      await callStatusOf(companyId),
    );

    console.log("\nH15 Calendly booking → Call Booked + confirmation text");
    const tomorrow3pm = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow3pm.setHours(15, 0, 0, 0);
    const created = await applyCalendlyBooking({
      event: "invitee.created",
      email: PROBE_EMAIL,
      name: "Completely Different Alias",
      phone: null,
      timezone: "America/New_York",
      startTime: tomorrow3pm,
      endTime: new Date(tomorrow3pm.getTime() + 30 * 60 * 1000),
      scheduledEventUri: null,
      inviteeUri: "https://calendly.invalid/probe-invitee",
      cancelUrl: null,
      rawPayload: {},
      source: "webhook",
    });
    check("booking matched the probe enrollment", created.matched === true);
    check(
      "booking sets meeting_scheduled",
      (await callStatusOf(companyId)) === "meeting_scheduled",
      await callStatusOf(companyId),
    );
    const confirmations = await db
      .select()
      .from(outreachMessages)
      .where(
        and(
          eq(outreachMessages.enrollmentId, enrollmentId),
          eq(outreachMessages.stepKind, "booking_confirmation"),
        ),
      );
    check(
      "SMS booking confirmation queued for an SMS conversation",
      confirmations.length === 1 && confirmations[0]!.status === "queued",
      confirmations.map((c) => c.status).join(",") || "none",
    );
    check(
      "confirmation copy names the meeting time",
      Boolean(confirmations[0]?.body?.includes("your meeting is booked for")),
      confirmations[0]?.body ?? "(none)",
    );
    // Defuse instantly so the real Mac worker can never claim it.
    await db
      .update(outreachMessages)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(outreachMessages.enrollmentId, enrollmentId));

    const [companyAfterBooking] = await db
      .select({ status: companies.status })
      .from(companies)
      .where(eq(companies.id, companyId));
    check(
      "company moves to meeting track only on a real booking",
      companyAfterBooking!.status === "meeting",
      companyAfterBooking!.status,
    );

    console.log("\nH16 nothing demotes a booked call");
    for (const intent of ["courtesy", "info_request", "positive"] as const) {
      await recordCallListOutreachEvent({
        companyId,
        contactId: contact!.id,
        summary: `probe: ${intent} after booking`,
        callStatus: callStatusForReplyIntent(intent),
      });
      check(
        `meeting_scheduled survives a ${intent} reply`,
        (await callStatusOf(companyId)) === "meeting_scheduled",
        await callStatusOf(companyId),
      );
    }

    console.log("\nH17 Calendly cancel reverts to Replied — Interested");
    const canceled = await applyCalendlyBooking({
      event: "invitee.canceled",
      email: PROBE_EMAIL,
      name: "Completely Different Alias",
      phone: null,
      timezone: "America/New_York",
      startTime: tomorrow3pm,
      endTime: null,
      scheduledEventUri: null,
      inviteeUri: "https://calendly.invalid/probe-invitee",
      cancelUrl: null,
      rawPayload: {},
      source: "webhook",
    });
    check("cancel matched the probe enrollment", canceled.matched === true);
    check(
      "cancel reverts meeting_scheduled → replied_interested",
      (await callStatusOf(companyId)) === "replied_interested",
      await callStatusOf(companyId),
    );

    console.log("\nH18 terminal intents still win, then lock");
    await recordCallListOutreachEvent({
      companyId,
      contactId: contact!.id,
      summary: "probe: opt-out",
      callStatus: callStatusForReplyIntent("opt_out"),
    });
    check(
      "opt-out overrides replied_interested",
      (await callStatusOf(companyId)) === "do_not_contact",
      await callStatusOf(companyId),
    );
    await recordCallListOutreachEvent({
      companyId,
      contactId: contact!.id,
      summary: "probe: late positive after DNC",
      callStatus: callStatusForReplyIntent("positive"),
    });
    check(
      "terminal status is locked against later replies",
      (await callStatusOf(companyId)) === "do_not_contact",
      await callStatusOf(companyId),
    );
  } finally {
    // Tear down every trace, children first.
    if (enrollmentId) {
      await db
        .delete(outreachMessages)
        .where(eq(outreachMessages.enrollmentId, enrollmentId));
      await db
        .delete(enrollmentEvents)
        .where(eq(enrollmentEvents.enrollmentId, enrollmentId));
      await db
        .delete(inboundMessages)
        .where(eq(inboundMessages.enrollmentId, enrollmentId));
      await db
        .delete(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, enrollmentId));
    }
    await db
      .delete(companyActivities)
      .where(eq(companyActivities.companyId, companyId));
    await db
      .delete(callListEntries)
      .where(eq(callListEntries.companyId, companyId));
    await db.delete(contacts).where(eq(contacts.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));

    const residue = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.email, [PROBE_EMAIL]))
      .limit(1);
    console.log(
      residue.length === 0
        ? "\nCleanup: no probe rows remain."
        : "\nCleanup WARNING: probe rows remain!",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
