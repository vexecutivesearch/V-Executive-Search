import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SequenceEnrollment } from "@/lib/db/schema";
import { sanitizeOutreachBody } from "@/lib/outreach/sanitizer";

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
const inserts: Array<{ table: string; values: Row }> = [];
const updates: Array<{ table: string; set: Row }> = [];

function thenable(result: Row[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    where: self,
    orderBy: self,
    limit: self,
    returning: () => Promise.resolve(result),
    then: (
      onFulfilled?: (value: Row[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  });
  return chain;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) =>
        thenable(selectResults.get(getTableName(table)) ?? []),
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Row) => {
        const name = getTableName(table);
        inserts.push({ table: name, values });
        return thenable([{ id: `${name}-inserted` }]);
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Row) => {
        const name = getTableName(table);
        updates.push({ table: name, set });
        return thenable([{ id: "cancelled-confirmation" }]);
      },
    }),
  },
}));

const settings = { textEnabled: true };
vi.mock("@/lib/outreach/settings", () => ({
  getOrCreateOutreachSettings: async () => settings,
}));

const enrollment = {
  id: "enr-1",
  contactId: "contact-1",
  companyId: "company-1",
  status: "replied_positive",
  emailAddress: "info@cultura.company",
  phoneNumber: "+17864083193",
  timezone: "America/New_York",
} as unknown as SequenceEnrollment;

/** Mon Aug 3 2026, 9:00 AM ET — tonight's v8 booking. */
const bookedAt = new Date("2026-08-03T13:00:00.000Z");

const texts = () =>
  inserts.filter(
    (i) => i.table === "outreach_messages" && i.values.channel === "imessage",
  );
const events = () =>
  inserts
    .filter((i) => i.table === "enrollment_events")
    .map((i) => i.values as { eventType: string; payload: Row });

beforeEach(() => {
  vi.clearAllMocks();
  settings.textEnabled = true;
  selectResults.clear();
  inserts.length = 0;
  updates.length = 0;
});

describe("confirmation copy", () => {
  it("states the meeting time in a texting voice", async () => {
    const { bookingConfirmationText, formatBookingWhen } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    expect(formatBookingWhen(bookedAt)).toBe("Monday Aug 3 at 9 AM ET");
    expect(bookingConfirmationText(formatBookingWhen(bookedAt))).toBe(
      "Great, your meeting is booked for Monday Aug 3 at 9 AM ET. Looking forward to speaking.",
    );
  });

  it("keeps the minutes when the meeting is not on the hour", async () => {
    const { formatBookingWhen } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    expect(formatBookingWhen(new Date("2026-08-03T13:15:00.000Z"))).toBe(
      "Monday Aug 3 at 9:15 AM ET",
    );
  });

  it("falls back to a timeless confirmation", async () => {
    const { bookingConfirmationText } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    expect(bookingConfirmationText(null)).toBe(
      "Great, your meeting is booked. Looking forward to speaking.",
    );
  });

  it("passes the sanitizer, dashes included", async () => {
    const { bookingConfirmationText, formatBookingWhen } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    for (const when of [
      formatBookingWhen(bookedAt),
      formatBookingWhen(bookedAt, "America/Los_Angeles"),
      formatBookingWhen(bookedAt, "America/Chicago"),
      null,
    ]) {
      const result = sanitizeOutreachBody(bookingConfirmationText(when), {
        channel: "imessage",
      });
      expect(result.violations, `for "${when}"`).toEqual([]);
    }
  });
});

describe("which channel the conversation runs on", () => {
  const seedInbound = (channels: Array<"imessage" | "email">) =>
    selectResults.set(
      "inbound_messages",
      channels.map((channel) => ({ channel })),
    );

  it("is SMS when they only ever texted", async () => {
    seedInbound(["imessage"]);
    const { conversationChannel } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    expect(await conversationChannel("enr-1")).toBe("imessage");
  });

  it("is email when they only ever emailed", async () => {
    seedInbound(["email"]);
    const { conversationChannel } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    expect(await conversationChannel("enr-1")).toBe("email");
  });

  it("resolves a mixed thread to SMS", async () => {
    seedInbound(["email", "imessage"]);
    const { conversationChannel } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    expect(await conversationChannel("enr-1")).toBe("imessage");
  });

  it("is nothing at all when they never replied", async () => {
    seedInbound([]);
    const { conversationChannel } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    expect(await conversationChannel("enr-1")).toBeNull();
  });
});

describe("queueing the confirmation", () => {
  const queue = async (over: Partial<SequenceEnrollment> = {}) => {
    const { queueBookingConfirmationText } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    return queueBookingConfirmationText({
      enrollment: { ...enrollment, ...over } as SequenceEnrollment,
      startTime: bookedAt,
      actor: "calendly_email",
      bookingKey: "evt-1",
    });
  };

  it("texts a confirmation when the conversation was over SMS", async () => {
    selectResults.set("inbound_messages", [{ channel: "imessage" }]);
    const result = await queue();

    expect(result.queued).toBe(true);
    expect(texts()).toHaveLength(1);
    expect(texts()[0].values).toMatchObject({
      stepKind: "booking_confirmation",
      channel: "imessage",
      status: "queued",
    });
    expect(texts()[0].values.body).toBe(
      "Great, your meeting is booked for Monday Aug 3 at 9 AM ET. Looking forward to speaking.",
    );
    expect(texts()[0].values.approvedAt).toBeInstanceOf(Date);
    expect(
      (texts()[0].values.scheduledFor as Date).getTime(),
    ).toBeLessThanOrEqual(Date.now());
  });

  it("stays quiet when the conversation was over email", async () => {
    selectResults.set("inbound_messages", [{ channel: "email" }]);
    const result = await queue();

    expect(result.queued).toBe(false);
    expect(result.reason).toContain("Calendly");
    expect(texts()).toHaveLength(0);
  });

  it("stays quiet when they never replied at all", async () => {
    selectResults.set("inbound_messages", []);
    const result = await queue();
    expect(result.queued).toBe(false);
    expect(texts()).toHaveLength(0);
  });

  it("sends once, however many times Calendly tells us", async () => {
    selectResults.set("inbound_messages", [{ channel: "imessage" }]);
    const first = await queue();
    expect(first.queued).toBe(true);

    // Second notification for the same booking, or a reschedule.
    selectResults.set("outreach_messages", [
      { id: "already", status: "queued" },
    ]);
    const second = await queue();
    expect(second.queued).toBe(false);
    expect(second.reason).toContain("already");
    expect(texts()).toHaveLength(1);
  });

  it("needs a phone number", async () => {
    selectResults.set("inbound_messages", [{ channel: "imessage" }]);
    const result = await queue({ phoneNumber: null });
    expect(result.queued).toBe(false);
    expect(result.reason).toContain("phone");
    expect(texts()).toHaveLength(0);
  });

  /*
   * The booking confirmation is the one text nobody thinks of as outreach, so
   * it is the one most likely to slip past a channel switch. Calendly emails
   * its own confirmation regardless, so staying quiet loses nothing.
   */
  it("stays quiet while the text channel is switched off", async () => {
    settings.textEnabled = false;
    selectResults.set("inbound_messages", [{ channel: "imessage" }]);
    const result = await queue();

    expect(result.queued).toBe(false);
    expect(result.reason).toContain("switched off");
    expect(texts()).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("refuses to queue where the worker will never look", async () => {
    selectResults.set("inbound_messages", [{ channel: "imessage" }]);
    const result = await queue({ status: "completed" as never });

    expect(result.queued).toBe(false);
    expect(texts()).toHaveLength(0);
    const failure = events().find((e) => e.payload.failed === true);
    expect(failure?.eventType).toBe("error");
    expect(failure?.payload.manual_note).toBeTruthy();
  });
});

describe("a booking that gets cancelled", () => {
  it("drops a confirmation the worker has not sent yet", async () => {
    const { cancelPendingBookingConfirmation } = await import(
      "@/lib/outreach/booking-confirmation"
    );
    const cancelled = await cancelPendingBookingConfirmation(
      "enr-1",
      "calendly_email",
    );
    expect(cancelled).toBe(1);
    expect(updates).toContainEqual(
      expect.objectContaining({
        table: "outreach_messages",
        set: expect.objectContaining({ status: "cancelled" }),
      }),
    );
  });
});
