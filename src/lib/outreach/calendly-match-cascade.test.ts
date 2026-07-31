import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression battery for the real Jul 30 2026 booking that a human made under a
 * deliberately different name ("Jeff Willson") to test attribution:
 *
 *   From:    notifications@calendly.com
 *   Subject: New Event: Jeff Willson - 09:00am Mon, Aug 3, 2026 - 15 Minute\r\n Meeting
 *
 * Two "Miguel Lozano" leads (Proven Theory LLC and Proven Theory LLC v8) were
 * both replied_positive inside the lookback, so no name signal can separate
 * them. Only the v8 lead had a Calendly link sent minutes before the booking.
 */

const queues = new Map<unknown, Record<string, unknown>[][]>();

function enqueue(table: unknown, rows: Record<string, unknown>[]): void {
  const existing = queues.get(table);
  if (existing) existing.push(rows);
  else queues.set(table, [rows]);
}

vi.mock("@/lib/db", () => {
  type Chain = {
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Promise<unknown[]>;
    then: (
      onFulfilled?: (value: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise<unknown>;
  };
  const from = (table: unknown): Chain => {
    const rows = queues.get(table)?.shift() ?? [];
    const chain: Chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: (onFulfilled, onRejected) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return chain;
  };
  return { db: { select: () => ({ from }) } };
});

import {
  callListEntries,
  companies,
  contacts,
  inboundMessages,
  outreachMessages,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { matchByInviteeName } from "@/lib/outreach/calendly-booking";
import { parseCalendlyNotificationEmail } from "@/lib/outreach/calendly-email";

/** Exactly as IMAP delivered it — folded before the word "Meeting". */
const REAL_SUBJECT =
  "New Event: Jeff Willson - 09:00am Mon, Aug 3, 2026 - 15 Minute\r\n Meeting";

const NOTIFIED_AT = new Date("2026-07-31T00:25:59.000Z"); // 8:25:59 PM ET

const V8_COMPANY = "53b96f06-482d-4b27-9b28-3bbcfac2c287";
const V8_CONTACT = "2c0a28ec-5375-45e1-acc9-9366c57ad36e";
const V8_ENROLLMENT = "c02d9a1b-58c1-4314-9505-3375ec45b52a";
const V7_COMPANY = "647ddd4c-a5bd-4a3d-ab81-0fc60d53160d";
const V7_CONTACT = "7be74a6c-4185-4ca4-97bc-689e9e487cc3";
const V7_ENROLLMENT = "94ac4381-d770-4953-8dfd-be621d06e94e";

function contact(id: string, companyId: string, name = "Miguel Lozano") {
  return { id, companyId, name, email: null, workEmail: null, personalEmail: null };
}

function enrollment(id: string, contactId: string, updatedAt: Date) {
  return {
    id,
    contactId,
    status: "replied_positive",
    enrolledAt: new Date("2026-07-31T00:17:25.499Z"),
    updatedAt,
  };
}

/**
 * Stage the exact query sequence matchByInviteeName runs, in call order:
 * live enrollments → call list → call-list contacts → pool contacts →
 * extra enrollments → companies → positive inbound → Calendly link sends.
 */
function stageWorld(options: {
  liveEnrollments: Record<string, unknown>[];
  poolContacts: Record<string, unknown>[];
  calendlySends: Record<string, unknown>[];
  positiveInbound?: Record<string, unknown>[];
  /** Resolved at the tail of the cascade once a winner is picked. */
  finalContactLookup?: Record<string, unknown>[];
}): void {
  queues.clear();
  enqueue(sequenceEnrollments, options.liveEnrollments);
  enqueue(callListEntries, [
    {
      companyId: V8_COMPANY,
      callStatus: "meeting_scheduled",
      callStatusUpdatedAt: new Date("2026-07-31T00:23:43.272Z"),
      updatedAt: new Date("2026-07-31T00:23:50.271Z"),
    },
    {
      companyId: V7_COMPANY,
      callStatus: "spoke_follow_up",
      callStatusUpdatedAt: new Date("2026-07-30T20:25:00.000Z"),
      updatedAt: new Date("2026-07-30T20:25:00.000Z"),
    },
  ]);
  enqueue(contacts, options.poolContacts);
  enqueue(contacts, options.poolContacts);
  enqueue(sequenceEnrollments, options.liveEnrollments);
  enqueue(companies, [
    { id: V8_COMPANY, status: "meeting" },
    { id: V7_COMPANY, status: "meeting" },
  ]);
  enqueue(inboundMessages, options.positiveInbound ?? []);
  enqueue(outreachMessages, options.calendlySends);
  if (options.finalContactLookup) {
    enqueue(contacts, options.finalContactLookup);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOTIFIED_AT);
});

afterEach(() => {
  vi.useRealTimers();
  queues.clear();
});

describe("the real folded Calendly subject", () => {
  it("survives RFC 5322 header folding", () => {
    const parsed = parseCalendlyNotificationEmail({ subject: REAL_SUBJECT });
    expect(parsed!.kind).toBe("created");
    expect(parsed!.inviteeName).toBe("Jeff Willson");
    expect(parsed!.eventTitle).toBe("15 Minute Meeting");
  });

  it("reads 9:00 AM ET Mon Aug 3 with a 15 minute window", () => {
    const parsed = parseCalendlyNotificationEmail({ subject: REAL_SUBJECT });
    expect(parsed!.startTime?.toISOString()).toBe("2026-08-03T13:00:00.000Z");
    expect(parsed!.endTime?.toISOString()).toBe("2026-08-03T13:15:00.000Z");
  });
});

describe("matchByInviteeName — name matches nobody", () => {
  it("attributes to the lead handed the Calendly link minutes earlier", async () => {
    stageWorld({
      liveEnrollments: [
        enrollment(V8_ENROLLMENT, V8_CONTACT, new Date("2026-07-31T00:23:50.236Z")),
        enrollment(V7_ENROLLMENT, V7_CONTACT, new Date("2026-07-30T20:25:04.646Z")),
      ],
      poolContacts: [contact(V8_CONTACT, V8_COMPANY), contact(V7_CONTACT, V7_COMPANY)],
      calendlySends: [
        { enrollmentId: V8_ENROLLMENT, sentAt: new Date("2026-07-31T00:23:50.223Z") },
        { enrollmentId: V7_ENROLLMENT, sentAt: new Date("2026-07-30T20:14:39.346Z") },
      ],
      finalContactLookup: [contact(V8_CONTACT, V8_COMPANY)],
    });

    const result = await matchByInviteeName("Jeff Willson", {
      notifiedAt: NOTIFIED_AT,
    });

    expect(result.contact?.id).toBe(V8_CONTACT);
    expect(result.enrollment?.id).toBe(V8_ENROLLMENT);
    expect(result.matchVia).toBe("latest_recent_positive");
    expect(result.reason).toContain("Jeff Willson");
  });

  it("stays unmatched when two leads go positive minutes apart", async () => {
    stageWorld({
      liveEnrollments: [
        enrollment(V8_ENROLLMENT, V8_CONTACT, new Date("2026-07-31T00:23:50.236Z")),
        enrollment(V7_ENROLLMENT, V7_CONTACT, new Date("2026-07-31T00:19:00.000Z")),
      ],
      poolContacts: [contact(V8_CONTACT, V8_COMPANY), contact(V7_CONTACT, V7_COMPANY)],
      calendlySends: [
        { enrollmentId: V8_ENROLLMENT, sentAt: new Date("2026-07-31T00:23:50.223Z") },
        { enrollmentId: V7_ENROLLMENT, sentAt: new Date("2026-07-31T00:19:05.000Z") },
      ],
    });

    const result = await matchByInviteeName("Jeff Willson", {
      notifiedAt: NOTIFIED_AT,
    });

    expect(result.contact).toBeNull();
    expect(result.reason).toContain("await a booking");
  });

  it("ignores a positive that landed after the booking notification", async () => {
    stageWorld({
      liveEnrollments: [
        enrollment(V8_ENROLLMENT, V8_CONTACT, new Date("2026-07-31T00:23:50.236Z")),
        enrollment(V7_ENROLLMENT, V7_CONTACT, new Date("2026-07-31T02:00:00.000Z")),
      ],
      poolContacts: [contact(V8_CONTACT, V8_COMPANY), contact(V7_CONTACT, V7_COMPANY)],
      calendlySends: [
        { enrollmentId: V8_ENROLLMENT, sentAt: new Date("2026-07-31T00:23:50.223Z") },
        { enrollmentId: V7_ENROLLMENT, sentAt: new Date("2026-07-31T02:00:05.000Z") },
      ],
      finalContactLookup: [contact(V8_CONTACT, V8_COMPANY)],
    });

    const result = await matchByInviteeName("Jeff Willson", {
      notifiedAt: NOTIFIED_AT,
    });

    expect(result.contact?.id).toBe(V8_CONTACT);
    expect(result.matchVia).toBe("latest_recent_positive");
  });

  it("takes the sole lead awaiting a booking", async () => {
    stageWorld({
      liveEnrollments: [
        enrollment(V8_ENROLLMENT, V8_CONTACT, new Date("2026-07-31T00:23:50.236Z")),
      ],
      poolContacts: [contact(V8_CONTACT, V8_COMPANY)],
      calendlySends: [
        { enrollmentId: V8_ENROLLMENT, sentAt: new Date("2026-07-31T00:23:50.223Z") },
      ],
      finalContactLookup: [contact(V8_CONTACT, V8_COMPANY)],
    });

    const result = await matchByInviteeName("Jeff Willson", {
      notifiedAt: NOTIFIED_AT,
    });

    expect(result.contact?.id).toBe(V8_CONTACT);
    expect(result.matchVia).toBe("sole_recent_positive");
  });
});

describe("matchByInviteeName — name still wins when it is there", () => {
  it("prefers the exact name hit over recency", async () => {
    stageWorld({
      liveEnrollments: [
        enrollment(V8_ENROLLMENT, V8_CONTACT, new Date("2026-07-31T00:23:50.236Z")),
        enrollment(V7_ENROLLMENT, V7_CONTACT, new Date("2026-07-30T20:25:04.646Z")),
      ],
      poolContacts: [
        contact(V8_CONTACT, V8_COMPANY, "Dana Reyes"),
        contact(V7_CONTACT, V7_COMPANY, "Miguel Lozano"),
      ],
      calendlySends: [
        { enrollmentId: V8_ENROLLMENT, sentAt: new Date("2026-07-31T00:23:50.223Z") },
        { enrollmentId: V7_ENROLLMENT, sentAt: new Date("2026-07-30T20:14:39.346Z") },
      ],
    });

    const result = await matchByInviteeName("Miguel Lozano", {
      notifiedAt: NOTIFIED_AT,
    });

    expect(result.contact?.id).toBe(V7_CONTACT);
    expect(result.matchVia).toBe("name_exact");
  });
});
