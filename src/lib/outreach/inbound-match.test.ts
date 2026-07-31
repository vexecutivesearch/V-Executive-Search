import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which inbound messages are allowed to count as replies, and to whom.
 *
 * Three separate failures live here. Alison Minoogian answered a Jupiter salon
 * outreach twice from aminoogian@gmail.com; her enrollment stored the address as
 * she had typed it, `Aminoogian@gmail.com`, and the lookup lowercased the inbound
 * then compared it exactly, so both positive replies came back "no matching
 * enrollment" and she was answered on neither channel by email.
 *
 * A first chat.db scan with no watermark then handed over eleven days of personal
 * texts with a test number, every one of which scored as an answer to outreach
 * that had not been sent until eleven days later.
 *
 * And a note the operator texted themselves ("Add Alison as a test …") landed on
 * a stopped v4 test enrollment that still held the number, was classified, and
 * flipped that enrollment back to paused.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
const inserts: Array<{ table: string; values: Row }> = [];
const updates: Array<{ table: string; set: Row }> = [];
const whereSql: string[] = [];

const dialect = new PgDialect();

function thenable(result: Row[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    where: (condition: unknown) => {
      if (condition) {
        try {
          whereSql.push(dialect.sqlToQuery(condition as never).sql);
        } catch {
          /* not every condition compiles standalone */
        }
      }
      return chain;
    },
    orderBy: self,
    limit: self,
    innerJoin: self,
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
        return {
          onConflictDoNothing: () =>
            thenable([{ id: `${name}-inserted`, ...values }]),
          returning: () => Promise.resolve([{ id: `${name}-inserted` }]),
          then: (onFulfilled?: (value: Row[]) => unknown) =>
            Promise.resolve([{ id: `${name}-inserted` }]).then(onFulfilled),
        };
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Row) => {
        updates.push({ table: getTableName(table), set });
        return thenable([]);
      },
    }),
  },
}));

const applyReplyRules = vi.fn(async () => ({
  intent: "positive" as const,
  actionTaken: "stopped; reply_positive via imessage (queued SMS)",
}));

vi.mock("@/lib/outreach/rules", () => ({
  applyReplyRules: (...args: unknown[]) => applyReplyRules(...args),
}));
vi.mock("@/lib/outreach/classify", () => ({
  classifyInbound: async () => ({
    intent: "positive",
    confidence: 0.95,
    via: "llm" as const,
  }),
}));
vi.mock("@/lib/outreach/events", () => ({ logEnrollmentEvent: async () => {} }));
vi.mock("@/lib/outreach/profiles", () => ({
  bumpProfileCounters: async () => {},
}));
vi.mock("@/lib/outreach/template-counters", () => ({
  recomputeTemplateCounters: async () => {},
}));
vi.mock("@/lib/outreach/calendly-email", () => ({
  isCalendlyNotificationAddress: () => false,
  parseCalendlyNotificationEmail: () => null,
}));
vi.mock("@/lib/outreach/calendly-booking", () => ({
  applyCalendlyBooking: async () => ({ matched: false }),
}));

const HER_ENROLLMENT = "b4d41451-0ea5-40dd-8cd3-413dc2bdd133";
const HER_CONTACT = "68878352-fd1c-4598-a955-36b4b0016408";

/** A send that already went out, so an inbound after it is a real reply. */
function sentIntro() {
  return { id: "msg-intro", sentAt: new Date("2026-07-31T01:12:22Z") };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.clear();
  inserts.length = 0;
  updates.length = 0;
  whereSql.length = 0;
  selectResults.set("inbound_messages", []);
});

const ingest = async (options: Parameters<
  typeof import("@/lib/outreach/inbound").ingestInboundMessage
>[0]) => {
  const { ingestInboundMessage } = await import("@/lib/outreach/inbound");
  return ingestInboundMessage(options);
};

describe("matching a reply to an enrollment by email address", () => {
  it("matches when only the stored capitalisation differs", async () => {
    selectResults.set("sequence_enrollments", [
      {
        id: HER_ENROLLMENT,
        contactId: HER_CONTACT,
        status: "replied_positive",
        emailAddress: "Aminoogian@gmail.com",
      },
    ]);
    selectResults.set("outreach_messages", [sentIntro()]);

    const result = await ingest({
      channel: "email",
      fromAddress: "aminoogian@gmail.com",
      subject: "Re: Hair Stylist Placement Support, Jupiter",
      body: "I'm interested in learning more",
      receivedAt: new Date("2026-07-31T01:15:50Z"),
    });

    expect(result.matched).toBe(true);
    expect(applyReplyRules).toHaveBeenCalledTimes(1);
  });

  it("compares both sides case-insensitively in SQL", async () => {
    selectResults.set("sequence_enrollments", []);
    selectResults.set("contacts", []);
    await ingest({
      channel: "email",
      fromAddress: "Aminoogian@Gmail.com",
      body: "How can I book a time to chat with you?",
      receivedAt: new Date("2026-07-31T01:17:32Z"),
    });
    // An exact equality here is what lost her replies.
    expect(whereSql.some((s) => /lower\(/i.test(s))).toBe(true);
  });
});

describe("an inbound that predates everything we sent", () => {
  it("is not treated as a reply", async () => {
    selectResults.set("sequence_enrollments", [
      {
        id: "enr-v1",
        contactId: "contact-v1",
        status: "active",
        phoneNumber: "+13212307946",
      },
    ]);
    // The enrollment's only send happened eleven days after this text.
    selectResults.set("outreach_messages", []);

    const result = await ingest({
      channel: "imessage",
      fromAddress: "+13212307946",
      body: "lmfao how?",
      receivedAt: new Date("2026-07-19T02:57:55Z"),
    });

    expect(result.matched).toBe(false);
    expect(applyReplyRules).not.toHaveBeenCalled();
    expect(result.actionTaken).toContain("predates anything we sent");
  });

  it("still attributes the row to the contact we recognised", async () => {
    selectResults.set("sequence_enrollments", [
      {
        id: "enr-v1",
        contactId: "contact-v1",
        status: "active",
        phoneNumber: "+13212307946",
      },
    ]);
    selectResults.set("outreach_messages", []);

    await ingest({
      channel: "imessage",
      fromAddress: "+13212307946",
      body: "get this money",
      receivedAt: new Date("2026-07-19T02:58:36Z"),
    });

    const row = inserts.find((i) => i.table === "inbound_messages");
    expect(row?.values.contactId).toBe("contact-v1");
    expect(row?.values.enrollmentId).toBeNull();
  });
});

describe("an inbound whose only match is a retired enrollment", () => {
  it("does not let a stopped test enrollment absorb it", async () => {
    selectResults.set("sequence_enrollments", [
      {
        id: "enr-v4",
        contactId: "contact-v4",
        status: "stopped",
        phoneNumber: "+13212307946",
      },
    ]);
    selectResults.set("outreach_messages", [sentIntro()]);

    const result = await ingest({
      channel: "imessage",
      fromAddress: "+13212307946",
      body: "Add Alison as a test\n 561-801-0303\nAminoogian@gmail.com",
      receivedAt: new Date("2026-07-31T00:44:08Z"),
    });

    expect(result.matched).toBe(false);
    expect(applyReplyRules).not.toHaveBeenCalled();
    expect(result.actionTaken).toContain("stopped");
  });

  it("keeps answering on an enrollment we already replied to", async () => {
    // A follow-up on a live thread is the reply we most want to catch, so
    // replied_positive must stay eligible.
    selectResults.set("sequence_enrollments", [
      {
        id: "enr-v10",
        contactId: "contact-v10",
        status: "replied_positive",
        phoneNumber: "+13212307946",
      },
    ]);
    selectResults.set("outreach_messages", [sentIntro()]);

    const result = await ingest({
      channel: "imessage",
      fromAddress: "+13212307946",
      body: "Hi, yes I'm interested 2 pm wednesday?",
      receivedAt: new Date("2026-07-31T01:15:04Z"),
    });

    expect(result.matched).toBe(true);
    expect(applyReplyRules).toHaveBeenCalledTimes(1);
  });
});
