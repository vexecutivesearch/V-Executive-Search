import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOptOutMessage,
  parseTwilioWebhook,
} from "@/lib/outreach/sms/webhook";

/**
 * What the Twilio callbacks do to our data.
 *
 * The STOP path is the one that has to be right: Twilio stops the traffic at
 * their edge whatever we do, but our suppression table is what the CRM and any
 * audit read, and the rule engine only writes one when the reply matched a live
 * enrollment — a STOP from a number whose enrollment was retired would
 * otherwise leave us with no record of the opt-out at all.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
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
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Row) => {
        updates.push({ table: getTableName(table), set });
        return thenable([]);
      },
    }),
  },
}));

type IngestOptions = Parameters<
  typeof import("@/lib/outreach/inbound").ingestInboundMessage
>[0];
type IngestResult = Awaited<
  ReturnType<typeof import("@/lib/outreach/inbound").ingestInboundMessage>
>;
type SuppressionModule = typeof import("@/lib/outreach/suppression");
type ProfilesModule = typeof import("@/lib/outreach/profiles");
type EventsModule = typeof import("@/lib/outreach/events");

const ingestInboundMessage =
  vi.fn<(options: IngestOptions) => Promise<IngestResult>>();
const addSuppression = vi.fn<SuppressionModule["addSuppression"]>();
const isSuppressed = vi.fn<SuppressionModule["isSuppressed"]>();
const bumpProfileCounters = vi.fn<ProfilesModule["bumpProfileCounters"]>();
const logEnrollmentEvent = vi.fn<EventsModule["logEnrollmentEvent"]>();

vi.mock("@/lib/outreach/inbound", () => ({
  ingestInboundMessage: (options: IngestOptions) => ingestInboundMessage(options),
}));
vi.mock("@/lib/outreach/suppression", () => ({
  addSuppression: (options: Parameters<SuppressionModule["addSuppression"]>[0]) =>
    addSuppression(options),
  isSuppressed: (options: Parameters<SuppressionModule["isSuppressed"]>[0]) =>
    isSuppressed(options),
}));
vi.mock("@/lib/outreach/profiles", () => ({
  bumpProfileCounters: (...args: Parameters<ProfilesModule["bumpProfileCounters"]>) =>
    bumpProfileCounters(...args),
}));
vi.mock("@/lib/outreach/events", () => ({
  logEnrollmentEvent: (options: Parameters<EventsModule["logEnrollmentEvent"]>[0]) =>
    logEnrollmentEvent(options),
}));

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.clear();
  updates.length = 0;
  ingestInboundMessage.mockResolvedValue({
    id: "inbound-1",
    duplicate: false,
    matched: true,
    intent: "opt_out",
  });
  addSuppression.mockResolvedValue({ id: "supp-1" } as Awaited<
    ReturnType<SuppressionModule["addSuppression"]>
  >);
  isSuppressed.mockResolvedValue({ suppressed: false });
  bumpProfileCounters.mockResolvedValue();
  logEnrollmentEvent.mockResolvedValue();
});

const inbound = async (payload: Parameters<
  typeof import("@/lib/outreach/sms/webhook").handleTwilioInbound
>[0]) => {
  const { handleTwilioInbound } = await import("@/lib/outreach/sms/webhook");
  return handleTwilioInbound(payload);
};

const status = async (payload: Parameters<
  typeof import("@/lib/outreach/sms/webhook").handleTwilioStatus
>[0]) => {
  const { handleTwilioStatus } = await import("@/lib/outreach/sms/webhook");
  return handleTwilioStatus(payload);
};

describe("telling the two callback shapes apart", () => {
  it("reads an inbound reply", () => {
    const event = parseTwilioWebhook(
      new URLSearchParams({
        MessageSid: "SM1",
        SmsStatus: "received",
        From: "+15615550123",
        To: "+15615550999",
        Body: "sounds good",
        NumMedia: "0",
      }),
    );
    expect(event.kind).toBe("inbound");
    if (event.kind !== "inbound") return;
    expect(event.payload.from).toBe("+15615550123");
    expect(event.payload.body).toBe("sounds good");
  });

  it("reads a delivery-status transition, error code included", () => {
    const event = parseTwilioWebhook(
      new URLSearchParams({
        MessageSid: "SM2",
        MessageStatus: "undelivered",
        ErrorCode: "30007",
        ErrorMessage: "Message filtered",
        To: "+15615550123",
      }),
    );
    expect(event.kind).toBe("status");
    if (event.kind !== "status") return;
    expect(event.payload).toMatchObject({
      status: "undelivered",
      errorCode: 30007,
    });
  });

  it("ignores a payload with no MessageSid", () => {
    expect(parseTwilioWebhook(new URLSearchParams({ Body: "hi" })).kind).toBe("ignored");
  });
});

describe("opt-out keyword matching", () => {
  it("matches the carrier keywords whatever the case or trailing punctuation", () => {
    for (const body of ["STOP", "stop", " Stop. ", "unsubscribe", "QUIT!", "End", "cancel"]) {
      expect(isOptOutMessage(body)).toBe(true);
    }
  });

  it("does not match a keyword used in a sentence", () => {
    // Substring matching here would suppress a live conversation.
    for (const body of [
      "Can we cancel Thursday and move to Friday?",
      "stop by the office anytime",
      "Please end the thread with Dana instead",
      "",
    ]) {
      expect(isOptOutMessage(body)).toBe(false);
    }
  });
});

describe("an inbound STOP", () => {
  it("writes a suppression on the imessage channel", async () => {
    const result = await inbound({
      messageSid: "SM10",
      from: "+15615550123",
      to: "+15615550999",
      body: "STOP",
      numMedia: 0,
    });

    expect(result.optOut).toBe(true);
    expect(result.suppressed).toBe(true);
    expect(addSuppression).toHaveBeenCalledTimes(1);
    expect(addSuppression.mock.calls[0][0]).toMatchObject({
      phone: "+15615550123",
      channel: "imessage",
    });
  });

  it("goes through the shared inbound ingest, deduped on the Twilio SID", async () => {
    await inbound({
      messageSid: "SM11",
      from: "+15615550123",
      to: "+15615550999",
      body: "STOP",
      numMedia: 0,
    });
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage.mock.calls[0][0]).toMatchObject({
      channel: "imessage",
      externalId: "twilio:SM11",
      fromAddress: "+15615550123",
    });
  });

  it("does not write a second row when the rule engine already suppressed", async () => {
    isSuppressed.mockResolvedValue({ suppressed: true, reason: "opt-out reply" });
    const result = await inbound({
      messageSid: "SM12",
      from: "+15615550123",
      to: "+15615550999",
      body: "STOP",
      numMedia: 0,
    });
    expect(result.suppressed).toBe(false);
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("still suppresses when the STOP arrives twice", async () => {
    ingestInboundMessage.mockResolvedValue({
      id: "inbound-1",
      duplicate: true,
      matched: false,
      intent: "opt_out",
    });
    const result = await inbound({
      messageSid: "SM13",
      from: "+15615550123",
      to: "+15615550999",
      body: "STOP",
      numMedia: 0,
    });
    expect(result.duplicate).toBe(true);
    expect(result.suppressed).toBe(true);
  });
});

describe("an ordinary inbound reply", () => {
  it("suppresses nothing", async () => {
    const result = await inbound({
      messageSid: "SM20",
      from: "+15615550123",
      to: "+15615550999",
      body: "Yes — Thursday at 2 works",
      numMedia: 0,
    });
    expect(result.optOut).toBe(false);
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("gives an MMS with no text a body the classifier can store", async () => {
    await inbound({
      messageSid: "SM21",
      from: "+15615550123",
      to: "+15615550999",
      body: "",
      numMedia: 2,
    });
    expect(ingestInboundMessage.mock.calls[0][0].body).toContain("media");
  });
});

describe("delivery-status callbacks", () => {
  const message = {
    id: "msg-1",
    enrollmentId: "enr-1",
    status: "queued",
    sentAt: null,
    sendingProfileId: "profile-1",
    messageId: "SM30",
    resendId: null,
  };

  it("marks an undelivered message failed and counts it against the profile", async () => {
    selectResults.set("outreach_messages", [message]);
    const result = await status({
      messageSid: "SM30",
      status: "undelivered",
      errorCode: 30007,
      errorMessage: "Message filtered",
      to: "+15615550123",
    });

    expect(result.applied).toBe("failed");
    const update = updates.find((u) => u.table === "outreach_messages");
    expect(update?.set.status).toBe("failed");
    expect(String(update?.set.error)).toContain("30007");
    expect(bumpProfileCounters).toHaveBeenCalledWith("profile-1", { totalBounced: 1 });
  });

  it("suppresses the number when the failure is a 21610 opt-out", async () => {
    selectResults.set("outreach_messages", [message]);
    selectResults.set("sequence_enrollments", [
      { contactId: "contact-1", phoneNumber: "+15615550123" },
    ]);
    await status({
      messageSid: "SM30",
      status: "failed",
      errorCode: 21610,
      errorMessage: "unsubscribed recipient",
      to: "+15615550123",
    });
    expect(addSuppression).toHaveBeenCalledTimes(1);
    expect(addSuppression.mock.calls[0][0]).toMatchObject({
      phone: "+15615550123",
      channel: "imessage",
      contactId: "contact-1",
    });
  });

  it("records a delivery against the profile's delivered counter", async () => {
    selectResults.set("outreach_messages", [{ ...message, status: "sent" }]);
    const result = await status({
      messageSid: "SM30",
      status: "delivered",
      errorCode: null,
      errorMessage: null,
      to: "+15615550123",
    });
    expect(result.applied).toBe("delivered");
    expect(bumpProfileCounters).toHaveBeenCalledWith("profile-1", { totalDelivered: 1 });
  });

  it("does not resurrect a failed row from a late sent callback", async () => {
    selectResults.set("outreach_messages", [{ ...message, status: "failed" }]);
    const result = await status({
      messageSid: "SM30",
      status: "sent",
      errorCode: null,
      errorMessage: null,
      to: "+15615550123",
    });
    expect(result.applied).toBe("noop");
    expect(updates).toHaveLength(0);
  });

  it("ignores a callback for a message we have no record of", async () => {
    selectResults.set("outreach_messages", []);
    const result = await status({
      messageSid: "SM-unknown",
      status: "delivered",
      errorCode: null,
      errorMessage: null,
      to: "+15615550123",
    });
    expect(result.applied).toBe("unmatched");
    expect(updates).toHaveLength(0);
    expect(bumpProfileCounters).not.toHaveBeenCalled();
  });
});
