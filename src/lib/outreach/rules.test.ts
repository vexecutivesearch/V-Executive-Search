import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InboundMessage,
  OutreachMessage,
  SequenceEnrollment,
} from "@/lib/db/schema";

/**
 * The bug these cover: a contact answered by text and by email seven seconds
 * apart. The text queued an SMS auto-reply for the Mac worker; the email ran
 * the same positive branch and its cancel sweep deleted that queued reply
 * before the worker's next five minute poll, so nothing was ever texted back.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
const updateReturning = new Map<string, Row[]>();
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
        return thenable([{ id: `${name}-inserted` }]);
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Row) => {
        const name = getTableName(table);
        updates.push({ table: name, set });
        return thenable(updateReturning.get(name) ?? []);
      },
    }),
  },
}));

const draftEnrollmentReply = vi.fn(
  async () =>
    "Great, thanks Miguel. Grab 30 min here:\n\nhttps://calendly.com/odv-vexecutivesearch/30min",
);
const sendOutreachEmail = vi.fn(async () => ({
  ok: true as const,
  resendId: "re_1",
  messageId: "<m1@vexecsearch.com>",
}));

vi.mock("@/lib/outreach-draft", () => ({
  draftEnrollmentReply: (...args: unknown[]) => draftEnrollmentReply(...args),
  getLastDraftFailureReason: () => "sanitizer_rejected",
}));
vi.mock("@/lib/outreach/node-draft", () => ({
  contextForEnrollment: async () => ({
    contactName: "Miguel Lozano",
    companyName: "Proven Theory LLC",
    jobTitles: ["Recruiting Job Assistant"],
    jobDetails: [],
    relatedJobTitles: [],
    hiringSignals: [],
    senderName: "Alejandro O Delgado",
    senderFirm: "Villatoro Executive Search",
  }),
}));
vi.mock("@/lib/outreach/calendar", () => ({
  suggestAvailability: async () => ({ lines: [], fromCalendar: false }),
}));
vi.mock("@/lib/outreach/settings", () => ({
  getOrCreateOutreachSettings: async () => ({
    physicalAddress: "869 Donald Ross Rd, Juno Beach, FL 33408",
    replyToAddress: "odv@vexecutivesearch.com",
  }),
}));
vi.mock("@/lib/outreach/enroll", () => ({
  cancelSiblingEnrollments: async () => 0,
}));
vi.mock("@/lib/outreach/notifications", () => ({ notifyReply: async () => {} }));
vi.mock("@/lib/outreach/suppression", () => ({ addSuppression: async () => {} }));
vi.mock("@/lib/outreach/profiles", () => ({
  pickSendingProfile: async () => ({ profile: null }),
}));
vi.mock("@/lib/outreach/resend-send", () => ({
  defaultFromAddress: () => "odv@vexecsearch.com",
  emailFooter: () => "\nAlejandro",
  resolveProfileApiKey: () => "re_test_key",
  sendOutreachEmail: (...args: unknown[]) => sendOutreachEmail(...args),
}));

const enrollment = {
  id: "enr-1",
  contactId: "contact-1",
  companyId: "company-1",
  status: "active",
  emailAddress: "info@cultura.company",
  phoneNumber: "+17864083193",
  timezone: "America/New_York",
  nodeState: {},
  nextStepAt: null,
} as unknown as SequenceEnrollment;

function inboundOn(channel: "imessage" | "email"): InboundMessage {
  return {
    id: `in-${channel}`,
    channel,
    rawBody: "Yes ! I'm interested",
  } as unknown as InboundMessage;
}

function queuedSmsReply(createdAt: Date): Row {
  return {
    id: "queued-sms-reply",
    channel: "imessage",
    status: "queued",
    stepKind: "reply_positive",
    createdAt,
  } satisfies Partial<OutreachMessage> as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.clear();
  updateReturning.clear();
  inserts.length = 0;
  updates.length = 0;
  selectResults.set("contacts", [{ id: "contact-1", name: "Miguel Lozano" }]);
  selectResults.set("companies", [{ id: "company-1", name: "Proven Theory LLC" }]);
  updateReturning.set("outreach_messages", [{ id: "cancelled-step" }]);
});

const events = () =>
  inserts
    .filter((i) => i.table === "enrollment_events")
    .map((i) => i.values as { eventType: string; actor: string; payload: Row });

const queuedTexts = () =>
  inserts.filter(
    (i) => i.table === "outreach_messages" && i.values.channel === "imessage",
  );

describe("cancel sweep after a reply", () => {
  const dialect = new PgDialect();
  const sqlFor = async (keepAutoReplies: boolean) => {
    const { pendingStepsCancelFilter } = await import(
      "@/lib/outreach/pending-messages"
    );
    return dialect.sqlToQuery(pendingStepsCancelFilter("enr-1", keepAutoReplies)!)
      .sql;
  };

  it("spares queued auto-replies when stopping the remaining sequence steps", async () => {
    const sql = await sqlFor(true);
    expect(sql).toContain("step_kind");
    expect(sql).toMatch(/not in/i);
  });

  it("cancels everything, replies included, on suppression paths", async () => {
    const sql = await sqlFor(false);
    expect(sql).not.toContain("step_kind");
  });
});

describe("positive reply arriving by text", () => {
  it("queues an SMS auto-reply with the scheduling link", async () => {
    const { applyReplyRules } = await import("@/lib/outreach/rules");
    const outcome = await applyReplyRules(
      enrollment,
      inboundOn("imessage"),
      "positive",
    );

    const texts = queuedTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0].values).toMatchObject({
      stepKind: "reply_positive",
      channel: "imessage",
      status: "queued",
    });
    expect(texts[0].values.body).toContain(
      "https://calendly.com/odv-vexecutivesearch/30min",
    );
    // The worker only claims approved messages that are already due.
    expect(texts[0].values.approvedAt).toBeInstanceOf(Date);
    expect(
      (texts[0].values.scheduledFor as Date).getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(sendOutreachEmail).not.toHaveBeenCalled();
    expect(outcome.actionTaken).toContain("queued SMS");
  });

  it("drafts the reply for the texting channel", async () => {
    const { applyReplyRules } = await import("@/lib/outreach/rules");
    await applyReplyRules(enrollment, inboundOn("imessage"), "positive");
    expect(draftEnrollmentReply).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "imessage", replyKind: "reply_positive" }),
    );
  });

  it("queues the reply before flipping the enrollment to replied_positive", async () => {
    const { applyReplyRules } = await import("@/lib/outreach/rules");
    await applyReplyRules(enrollment, inboundOn("imessage"), "positive");
    const flip = updates.findIndex(
      (u) => u.table === "sequence_enrollments" && u.set.status === "replied_positive",
    );
    expect(flip).toBeGreaterThanOrEqual(0);
    expect(queuedTexts()).toHaveLength(1);
    // The insert must already have happened by the time the status changes.
    expect(inserts.some((i) => i.values.channel === "imessage")).toBe(true);
  });

  it("keeps the queued text when the same reply also lands by email", async () => {
    selectResults.set("outreach_messages", [queuedSmsReply(new Date())]);
    const { applyReplyRules } = await import("@/lib/outreach/rules");
    const outcome = await applyReplyRules(
      enrollment,
      inboundOn("email"),
      "positive",
    );

    expect(draftEnrollmentReply).not.toHaveBeenCalled();
    expect(sendOutreachEmail).not.toHaveBeenCalled();
    expect(outcome.actionTaken).toContain("skipped");
    const skip = events().find((e) => e.payload.auto_reply_skipped === true);
    expect(skip?.payload).toMatchObject({
      existing_channel: "imessage",
      existing_status: "queued",
    });
  });

  it("still replies when the earlier auto-reply is older than the cooldown", async () => {
    selectResults.set("outreach_messages", []);
    const { applyReplyRules } = await import("@/lib/outreach/rules");
    await applyReplyRules(enrollment, inboundOn("email"), "positive");
    expect(sendOutreachEmail).toHaveBeenCalledTimes(1);
  });
});

describe("an auto-reply that cannot go out", () => {
  it("records a loud error event instead of silently doing nothing", async () => {
    draftEnrollmentReply.mockResolvedValueOnce(null as never);
    const { applyReplyRules } = await import("@/lib/outreach/rules");
    const outcome = await applyReplyRules(
      enrollment,
      inboundOn("imessage"),
      "positive",
    );

    expect(queuedTexts()).toHaveLength(0);
    const failure = events().find((e) => e.payload.auto_reply_failed === true);
    expect(failure).toBeDefined();
    expect(failure!.eventType).toBe("error");
    expect(String(failure!.payload.reason)).toContain("sanitizer");
    expect(failure!.payload.manual_note).toBeTruthy();
    expect(outcome.actionTaken).toContain("FAILED");
  });
});
