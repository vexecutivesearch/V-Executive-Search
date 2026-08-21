import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { threadHeaders } from "@/lib/outreach/resend-send";

/**
 * Follow-ups used to send with fresh headers and their own subject, so every
 * step of the sequence arrived as an unrelated cold email. "Following up on my
 * note" then landed in an inbox with no note above it to follow up on, which
 * is a plausible reason for a zero reply rate that has nothing to do with the
 * copy. In-Reply-To and References come off the intro's stored message id.
 */

type Row = Record<string, unknown>;

const selectQueues = new Map<string, Row[][]>();
const inserts: Array<{ table: string; values: Row }> = [];
const updates: Array<{ table: string; set: Row }> = [];

function enqueue(table: string, rows: Row[]): void {
  const existing = selectQueues.get(table);
  if (existing) existing.push(rows);
  else selectQueues.set(table, [rows]);
}

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
      from: (table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table);
        return thenable(selectQueues.get(name)?.shift() ?? []);
      },
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
        updates.push({ table: getTableName(table), set });
        return thenable([]);
      },
    }),
  },
}));

type SendArgs = {
  subject: string;
  inReplyTo: string | null;
  references: string | null;
};

const sendOutreachEmail = vi.fn<
  (options: SendArgs) => Promise<{
    ok: true;
    resendId: string;
    messageId: string;
  }>
>(async () => ({
  ok: true,
  resendId: "re_2",
  messageId: "<followup@vexecsearch.com>",
}));
vi.mock("@/lib/outreach/resend-send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/outreach/resend-send")>()),
  defaultFromAddress: () => "odv@vexecsearch.com",
  emailFooter: () => "\nAlejandro",
  resolveProfileApiKey: () => "re_test_key",
  sendOutreachEmail: (options: SendArgs) => sendOutreachEmail(options),
}));

vi.mock("@/lib/outreach/settings", () => ({
  getOrCreateOutreachSettings: async () => ({
    enabled: true,
    dryRun: false,
    requireApproval: false,
    textEnabled: false,
    dailySendCap: 100,
    physicalAddress: "869 Donald Ross Rd, Juno Beach, FL 33408",
    replyToAddress: "odv@vexecutivesearch.com",
  }),
}));
vi.mock("@/lib/outreach/profiles", () => ({
  bumpProfileCounters: async () => {},
  pickSendingProfile: async () => ({ profile: null }),
  tickWarmupStateMachine: async () => {},
}));
vi.mock("@/lib/outreach/sending-domains", () => ({
  ensureCatalogSendingProfiles: async () => ({ created: [], existing: [] }),
}));
vi.mock("@/lib/outreach/send-caps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/outreach/send-caps")>()),
  sentTodayOnChannel: async () => 0,
}));
vi.mock("@/lib/outreach/suppression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/outreach/suppression")>()),
  isSuppressed: async () => ({ suppressed: false, reason: null }),
}));
vi.mock("@/lib/outreach/flow-engine", () => ({
  advanceEnrollment: async () => ({ transitions: 0 }),
}));
vi.mock("@/lib/outreach/phone-backfill", () => ({
  backfillEnrollmentPhones: async () => ({ attached: 0 }),
}));
vi.mock("@/lib/outreach/call-list-sync", () => ({
  recordCallListOutreachEvent: async () => {},
}));
vi.mock("@/lib/alert-email", () => ({ sendAlertEmail: async () => {} }));

const INTRO_MESSAGE_ID = "<intro@vexecsearch.com>";

const enrollment = {
  id: "enr-1",
  contactId: "contact-1",
  companyId: "company-1",
  status: "active",
  emailAddress: "stacy@pluspower.test",
  timezone: "America/New_York",
};

/**
 * Queue the reads runOutreachDispatch makes, in order: the enrollments to
 * advance, the due messages, the enrollment behind the message, the sending
 * profiles, the contact, the thread's earlier sends, and the stale sweep.
 */
function seedDispatch(priorSends: Row[]): void {
  enqueue("sequence_enrollments", []);
  enqueue("outreach_messages", [
    {
      id: "msg-followup",
      enrollmentId: "enr-1",
      stepKind: "followup_1",
      channel: "email",
      status: "queued",
      subject: "Your SCADA Controls Engineer role, still open after 34 days",
      body: "Your posting went back up last week.",
      attemptCount: 0,
      approvedAt: new Date(),
      scheduledFor: new Date(),
    },
  ]);
  enqueue("sequence_enrollments", [enrollment as Row]);
  enqueue("sending_profiles", []);
  enqueue("contacts", [{ name: "Stacy Boyd" }]);
  enqueue("outreach_messages", priorSends);
  enqueue("companies", [{ status: "contacted" }]);
  enqueue("outreach_messages", []);
}

const sentIntro = (over: Row = {}) => ({
  messageId: INTRO_MESSAGE_ID,
  subject: "Support for Your Battery Storage Engineering Hires",
  sentAt: new Date("2026-08-01T13:00:00.000Z"),
  ...over,
});

const sendArgs = () => sendOutreachEmail.mock.calls[0]?.[0] as SendArgs;

beforeEach(() => {
  vi.clearAllMocks();
  selectQueues.clear();
  inserts.length = 0;
  updates.length = 0;
});

describe("threadHeaders", () => {
  it("replies to the newest send and references the whole chain", () => {
    expect(
      threadHeaders([
        sentIntro(),
        {
          messageId: "<followup1@vexecsearch.com>",
          subject: "Re: Support for Your Battery Storage Engineering Hires",
          sentAt: new Date("2026-08-03T13:00:00.000Z"),
        },
      ]),
    ).toEqual({
      inReplyTo: "<followup1@vexecsearch.com>",
      references: `${INTRO_MESSAGE_ID} <followup1@vexecsearch.com>`,
      subject: "Re: Support for Your Battery Storage Engineering Hires",
    });
  });

  it("keeps the thread's first subject, not the newest one's", () => {
    expect(
      threadHeaders([
        sentIntro({ subject: "Named open roles" }),
        {
          messageId: "<m2@vexecsearch.com>",
          subject: "Something else entirely",
          sentAt: new Date("2026-08-03T13:00:00.000Z"),
        },
      ]).subject,
    ).toBe("Re: Named open roles");
  });

  it("never stacks a second Re: prefix", () => {
    expect(
      threadHeaders([sentIntro({ subject: "Re: Re: Named open roles" })])
        .subject,
    ).toBe("Re: Named open roles");
  });

  it("starts a new thread when nothing has sent yet", () => {
    expect(threadHeaders([])).toEqual({
      inReplyTo: null,
      references: null,
      subject: null,
    });
    // A send with no stored message id cannot be threaded onto.
    expect(threadHeaders([sentIntro({ messageId: null })]).inReplyTo).toBeNull();
  });
});

describe("dispatching a follow-up", () => {
  it("threads it onto the intro instead of starting a new conversation", async () => {
    seedDispatch([sentIntro()]);
    const { runOutreachDispatch } = await import("@/lib/outreach/dispatch");
    const summary = await runOutreachDispatch(new Date());

    expect(summary.sent).toBe(1);
    expect(sendArgs().inReplyTo).toBe(INTRO_MESSAGE_ID);
    expect(sendArgs().references).toBe(INTRO_MESSAGE_ID);
    expect(sendArgs().subject).toBe(
      "Re: Support for Your Battery Storage Engineering Hires",
    );
  });

  it("records the subject the contact actually received", async () => {
    seedDispatch([sentIntro()]);
    const { runOutreachDispatch } = await import("@/lib/outreach/dispatch");
    await runOutreachDispatch(new Date());

    const sent = updates.find(
      (u) => u.table === "outreach_messages" && u.set.status === "sent",
    );
    expect(sent?.set.subject).toBe(
      "Re: Support for Your Battery Storage Engineering Hires",
    );
  });

  it("sends the intro itself as a fresh thread with its own subject", async () => {
    seedDispatch([]);
    const { runOutreachDispatch } = await import("@/lib/outreach/dispatch");
    await runOutreachDispatch(new Date());

    expect(sendArgs().inReplyTo).toBeNull();
    expect(sendArgs().subject).toBe(
      "Your SCADA Controls Engineer role, still open after 34 days",
    );
  });
});
