import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedCalendlyBooking } from "@/lib/outreach/calendly-booking";

/**
 * The bug these cover, one branch on from the reply-path fix in 09d1eeb.
 *
 * Tonight's v8 contact texted a positive reply at 8:23:41 PM and booked on
 * Calendly at 8:26. The reply queued an SMS auto-reply for the Mac worker,
 * which polls once every five minutes, so at 8:26 that reply was still sitting
 * in the queue unclaimed. The booking's cancel sweep took every drafted or
 * queued row on the enrollment, auto-reply included, and the worker's next
 * tick at 8:28 found nothing to send. The contact texted us and heard nothing.
 *
 * Cancelling the remaining sequence steps on a booking is still right: nobody
 * who just booked should keep getting follow ups. Only the messages that
 * answer the person survive.
 */

type Row = Record<string, unknown>;

const selectQueues = new Map<string, Row[][]>();
const inserts: Array<{ table: string; values: Row }> = [];
const updates: Array<{ table: string; set: Row; where: SQL | undefined }> = [];
/** Insert/update order, so "queued after the sweep" is assertable. */
const writeLog: string[] = [];

function enqueue(table: string, rows: Row[]): void {
  const existing = selectQueues.get(table);
  if (existing) existing.push(rows);
  else selectQueues.set(table, [rows]);
}

vi.mock("@/lib/db", () => {
  const readChain = (rows: Row[]) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      where: self,
      orderBy: self,
      limit: () => Promise.resolve(rows),
      returning: () => Promise.resolve(rows),
      then: (
        onFulfilled?: (value: Row[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    });
    return chain;
  };

  return {
    db: {
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) => {
          const name = getTableName(table);
          return readChain(selectQueues.get(name)?.shift() ?? []);
        },
      }),
      insert: (table: Parameters<typeof getTableName>[0]) => ({
        values: (values: Row) => {
          const name = getTableName(table);
          inserts.push({ table: name, values });
          writeLog.push(`insert:${name}:${String(values.stepKind ?? "")}`);
          return readChain([{ id: `${name}-inserted` }]);
        },
      }),
      update: (table: Parameters<typeof getTableName>[0]) => ({
        set: (set: Row) => {
          const name = getTableName(table);
          const chain: Record<string, unknown> = {};
          Object.assign(chain, {
            where: (clause: SQL | undefined) => {
              updates.push({ table: name, set, where: clause });
              writeLog.push(`update:${name}`);
              return chain;
            },
            returning: () => Promise.resolve([{ id: "cancelled-step" }]),
            then: (
              onFulfilled?: (value: Row[]) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) => Promise.resolve([]).then(onFulfilled, onRejected),
          });
          return chain;
        },
      }),
    },
  };
});

vi.mock("@/lib/outreach/call-list-sync", () => ({
  recordCallListOutreachEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/outreach/enroll", () => ({
  cancelSiblingEnrollments: vi.fn(async () => 0),
}));

const ENROLLMENT_ID = "c02d9a1b-58c1-4314-9505-3375ec45b52a";

const enrollment = {
  id: ENROLLMENT_ID,
  contactId: "contact-1",
  companyId: "company-1",
  status: "replied_positive",
  emailAddress: "miguel@proventheory.company",
  phoneNumber: "+17864083193",
  timezone: "America/New_York",
  enrolledAt: new Date("2026-07-28T14:00:00.000Z"),
};

/** Mon Aug 3 2026, 9:00 AM ET. */
const bookedFor = new Date("2026-08-03T13:00:00.000Z");

const booking: ParsedCalendlyBooking = {
  event: "invitee.created",
  email: "miguel@proventheory.company",
  name: "Miguel Lozano",
  phone: null,
  timezone: "America/New_York",
  startTime: bookedFor,
  endTime: new Date("2026-08-03T13:30:00.000Z"),
  scheduledEventUri: "https://api.calendly.com/scheduled_events/abc",
  inviteeUri: "https://api.calendly.com/scheduled_events/abc/invitees/xyz",
  cancelUrl: null,
  rawPayload: {},
  source: "email",
  notifiedAt: new Date("2026-07-31T00:26:00.000Z"), // 8:26 PM ET
};

/** The 8:23:43 PM auto-reply, still queued when the booking lands at 8:26. */
const QUEUED_AUTO_REPLY = {
  id: "msg-auto-reply",
  enrollmentId: ENROLLMENT_ID,
  stepKind: "reply_positive",
  channel: "imessage",
  status: "queued",
};

beforeEach(() => {
  vi.clearAllMocks();
  selectQueues.clear();
  inserts.length = 0;
  updates.length = 0;
  writeLog.length = 0;

  // The match cascade: enrollment by email, then its contact.
  enqueue("sequence_enrollments", [enrollment as Row]);
  enqueue("contacts", [{ id: "contact-1", name: "Miguel Lozano", companyId: "company-1" }]);
  enqueue("companies", [{ id: "company-1", name: "Proven Theory LLC v8", status: "outreach" }]);
  // The conversation lives on SMS — he texted first.
  enqueue("inbound_messages", [{ channel: "imessage" }]);
  // No confirmation queued yet for this booking.
  enqueue("outreach_messages", []);
});

const dialect = new PgDialect();

const sweepOf = (index = 0) => {
  const sweeps = updates.filter(
    (u) => u.table === "outreach_messages" && u.set.status === "cancelled",
  );
  const sweep = sweeps[index];
  expect(sweep, "expected a cancel sweep on outreach_messages").toBeDefined();
  return dialect.sqlToQuery(sweep.where!);
};

const events = () =>
  inserts
    .filter((i) => i.table === "enrollment_events")
    .map((i) => i.values as { eventType: string; payload: Row });

describe("a booking that lands while an auto-reply is still queued", () => {
  it("spares the queued auto-reply", async () => {
    const { applyCalendlyBooking } = await import(
      "@/lib/outreach/calendly-booking"
    );
    await applyCalendlyBooking(booking);

    const { sql, params } = sweepOf();
    expect(sql).toContain("step_kind");
    expect(sql).toMatch(/not in/i);
    expect(params).toContain(QUEUED_AUTO_REPLY.stepKind);
  });

  it("spares every reply kind, not just the positive one", async () => {
    const { applyCalendlyBooking } = await import(
      "@/lib/outreach/calendly-booking"
    );
    await applyCalendlyBooking(booking);

    const { params } = sweepOf();
    for (const kind of [
      "reply_positive",
      "reply_info_request",
      "reply_decline",
    ]) {
      expect(params, `${kind} must survive a booking`).toContain(kind);
    }
  });

  it("still cancels the remaining sequence steps", async () => {
    const { applyCalendlyBooking } = await import(
      "@/lib/outreach/calendly-booking"
    );
    await applyCalendlyBooking(booking);

    // Someone who just booked must not keep getting follow ups: the sweep
    // still runs, and still narrows to the rows the worker has not sent.
    const { params } = sweepOf();
    expect(params).toContain("drafted");
    expect(params).toContain("queued");
    expect(params).not.toContain("intro");
    expect(params).not.toContain("followup_1");

    const booked = events().find((e) => e.eventType === "calendly_booking");
    expect(booked?.payload.steps_cancelled).toBe(1);
  });

  it("says out loud that it kept the auto-replies", async () => {
    const { applyCalendlyBooking } = await import(
      "@/lib/outreach/calendly-booking"
    );
    await applyCalendlyBooking(booking);

    const cancelled = events().find((e) => e.eventType === "cancelled");
    expect(cancelled?.payload).toMatchObject({
      messages_cancelled: 1,
      kept_auto_replies: true,
    });
  });
});

describe("the booking confirmation text", () => {
  it("is queued after the sweep, and the sweep would not have taken it", async () => {
    const { applyCalendlyBooking } = await import(
      "@/lib/outreach/calendly-booking"
    );
    await applyCalendlyBooking(booking);

    const confirmation = inserts.find(
      (i) =>
        i.table === "outreach_messages" &&
        i.values.stepKind === "booking_confirmation",
    );
    expect(confirmation).toBeDefined();

    const sweptAt = writeLog.indexOf("update:outreach_messages");
    const queuedAt = writeLog.indexOf(
      "insert:outreach_messages:booking_confirmation",
    );
    expect(sweptAt).toBeGreaterThanOrEqual(0);
    expect(queuedAt).toBeGreaterThan(sweptAt);

    // Ordering alone kept it safe. Now the filter does too, so the second
    // notification for one booking (IMAP poll and webhook both deliver it)
    // leaves the first confirmation queued instead of recreating it.
    expect(sweepOf().params).toContain("booking_confirmation");
  });
});

describe("the sweep rule itself", () => {
  it("is the same rule the reply paths use", async () => {
    const { pendingStepsCancelFilter } = await import(
      "@/lib/outreach/pending-messages"
    );
    const { applyCalendlyBooking } = await import(
      "@/lib/outreach/calendly-booking"
    );
    await applyCalendlyBooking(booking);

    const shared = dialect.sqlToQuery(
      pendingStepsCancelFilter(ENROLLMENT_ID, true)!,
    );
    expect(sweepOf().sql).toBe(shared.sql);
    expect(sweepOf().params).toEqual(shared.params);
  });

  it("takes everything when a stop request turns it off", async () => {
    const { pendingStepsCancelFilter } = await import(
      "@/lib/outreach/pending-messages"
    );
    // Opt out, complaint, wrong person, admin stop: a pending message must
    // never survive one of those, so no kind is spared.
    const { sql } = dialect.sqlToQuery(
      pendingStepsCancelFilter(ENROLLMENT_ID, false)!,
    );
    expect(sql).not.toContain("step_kind");
  });
});
