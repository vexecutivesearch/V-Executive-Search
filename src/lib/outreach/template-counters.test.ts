import { describe, expect, it } from "vitest";
import {
  attributeInboundToSend,
  attributeTemplateCounters,
  isOptOutIntent,
  isPositiveIntent,
  isReplyIntent,
  rate,
  type InboundRecord,
  type SentMessageRecord,
} from "@/lib/outreach/template-counters";

const T_EMAIL = "template-email";
const T_TEXT = "template-text";
const E1 = "enrollment-1";

function send(partial: Partial<SentMessageRecord> & { id: string }): SentMessageRecord {
  return {
    enrollmentId: E1,
    channel: "email",
    templateId: T_EMAIL,
    sentAt: new Date("2026-07-30T12:00:00Z"),
    ...partial,
  };
}

function inbound(partial: Partial<InboundRecord> = {}): InboundRecord {
  return {
    enrollmentId: E1,
    channel: "email",
    receivedAt: new Date("2026-07-30T13:00:00Z"),
    intent: "positive",
    ...partial,
  };
}

describe("rate math", () => {
  it("returns null rather than dividing by zero", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(3, 0)).toBeNull();
  });

  it("computes the ordinary case", () => {
    expect(rate(1, 2)).toBe(0.5);
    expect(rate(0, 7)).toBe(0);
  });

  it("never renders a rate above 100%, whatever it is handed", () => {
    // 31 replies on 2 sends is what produced the 1550% the admin table showed.
    expect(rate(31, 2)).toBe(1);
    expect(rate(-4, 5)).toBe(0);
  });
});

describe("intent classification for counters", () => {
  it("treats automated noise as neither reply nor opt out", () => {
    for (const intent of ["ooo", "bounce_hard", "bounce_soft"]) {
      expect(isReplyIntent(intent)).toBe(false);
      expect(isOptOutIntent(intent)).toBe(false);
    }
  });

  it("counts a complaint as an opt out but not a reply", () => {
    expect(isReplyIntent("complaint")).toBe(false);
    expect(isOptOutIntent("complaint")).toBe(true);
  });

  it("counts an unclassified inbound as a reply", () => {
    expect(isReplyIntent(null)).toBe(true);
    expect(isReplyIntent("unknown")).toBe(true);
  });

  it("recognises a positive", () => {
    expect(isPositiveIntent("positive")).toBe(true);
    expect(isPositiveIntent("negative")).toBe(false);
    expect(isPositiveIntent(null)).toBe(false);
  });
});

describe("attributing an inbound message to the send it answers", () => {
  const emailSend = send({
    id: "m-email",
    channel: "email",
    sentAt: new Date("2026-07-30T12:00:00Z"),
  });
  const textSend = send({
    id: "m-text",
    channel: "imessage",
    templateId: T_TEXT,
    sentAt: new Date("2026-07-30T12:30:00Z"),
  });

  it("ignores an inbound that arrived before anything was sent", () => {
    // The chat.db scan backfills whole conversations, including texts that
    // predate the outreach by days.
    expect(
      attributeInboundToSend(
        inbound({ receivedAt: new Date("2026-07-19T03:00:00Z") }),
        [emailSend, textSend],
      ),
    ).toBeNull();
  });

  it("ignores an inbound with no enrollment", () => {
    expect(
      attributeInboundToSend(inbound({ enrollmentId: null }), [emailSend]),
    ).toBeNull();
  });

  it("ignores an inbound belonging to another enrollment", () => {
    expect(
      attributeInboundToSend(inbound({ enrollmentId: "other" }), [emailSend]),
    ).toBeNull();
  });

  it("credits the channel the reply came back on, not the newest send", () => {
    const replyByEmail = attributeInboundToSend(
      inbound({ channel: "email", receivedAt: new Date("2026-07-30T14:00:00Z") }),
      [emailSend, textSend],
    );
    expect(replyByEmail?.id).toBe("m-email");

    const replyByText = attributeInboundToSend(
      inbound({ channel: "imessage", receivedAt: new Date("2026-07-30T14:00:00Z") }),
      [emailSend, textSend],
    );
    expect(replyByText?.id).toBe("m-text");
  });

  it("falls back to the latest send when that channel sent nothing", () => {
    const result = attributeInboundToSend(
      inbound({ channel: "imessage", receivedAt: new Date("2026-07-30T14:00:00Z") }),
      [emailSend],
    );
    expect(result?.id).toBe("m-email");
  });

  it("credits the most recent send of that channel", () => {
    const first = send({ id: "m1", sentAt: new Date("2026-07-30T09:00:00Z") });
    const second = send({ id: "m2", sentAt: new Date("2026-07-30T11:00:00Z") });
    const result = attributeInboundToSend(
      inbound({ receivedAt: new Date("2026-07-30T12:00:00Z") }),
      [first, second],
    );
    expect(result?.id).toBe("m2");
  });
});

describe("rolling message history up per template", () => {
  it("counts sends per template", () => {
    const counters = attributeTemplateCounters(
      [
        send({ id: "m1" }),
        send({ id: "m2" }),
        send({ id: "m3", templateId: T_TEXT, channel: "imessage" }),
        send({ id: "m4", templateId: null }),
      ],
      [],
    );
    expect(counters.get(T_EMAIL)?.sends).toBe(2);
    expect(counters.get(T_TEXT)?.sends).toBe(1);
  });

  it("counts a send as replied once however long the thread runs", () => {
    // The bug: 25 inbound messages on one thread scored 25 replies against a
    // template with 2 sends, so the rate read 1550%.
    const sends = [send({ id: "m1" })];
    const thread = Array.from({ length: 25 }, (_, i) =>
      inbound({
        intent: "unknown",
        receivedAt: new Date(`2026-07-30T14:${String(i).padStart(2, "0")}:00Z`),
      }),
    );
    const counters = attributeTemplateCounters(sends, thread);
    expect(counters.get(T_EMAIL)).toEqual({
      sends: 1,
      replies: 1,
      positives: 0,
      optOuts: 0,
    });
  });

  it("credits only the template that was replied to, not every one used", () => {
    // The bug: one reply bumped every template the enrollment had ever sent.
    const counters = attributeTemplateCounters(
      [
        send({ id: "m-email", channel: "email", templateId: T_EMAIL }),
        send({
          id: "m-text",
          channel: "imessage",
          templateId: T_TEXT,
          sentAt: new Date("2026-07-30T12:30:00Z"),
        }),
      ],
      [inbound({ channel: "imessage", receivedAt: new Date("2026-07-30T13:00:00Z") })],
    );
    expect(counters.get(T_TEXT)?.replies).toBe(1);
    expect(counters.get(T_EMAIL)?.replies).toBe(0);
  });

  it("keeps replies within sends for every template", () => {
    const sends = [
      send({ id: "m1" }),
      send({ id: "m2", enrollmentId: "e2" }),
      send({ id: "m3", enrollmentId: "e3", templateId: T_TEXT, channel: "imessage" }),
    ];
    const inbounds = [
      ...Array.from({ length: 40 }, () => inbound()),
      ...Array.from({ length: 12 }, () => inbound({ enrollmentId: "e2" })),
      ...Array.from({ length: 8 }, () =>
        inbound({ enrollmentId: "e3", channel: "imessage" }),
      ),
    ];
    for (const [, counts] of attributeTemplateCounters(sends, inbounds)) {
      expect(counts.replies).toBeLessThanOrEqual(counts.sends);
      expect(counts.positives).toBeLessThanOrEqual(counts.replies);
      expect(rate(counts.replies, counts.sends)).toBeLessThanOrEqual(1);
    }
  });

  it("separates replies, positives and opt outs", () => {
    const counters = attributeTemplateCounters(
      [
        send({ id: "m1" }),
        send({ id: "m2", enrollmentId: "e2" }),
        send({ id: "m3", enrollmentId: "e3" }),
      ],
      [
        inbound({ intent: "positive" }),
        inbound({ enrollmentId: "e2", intent: "opt_out" }),
        inbound({ enrollmentId: "e3", intent: "complaint" }),
      ],
    );
    expect(counters.get(T_EMAIL)).toEqual({
      sends: 3,
      replies: 2,
      positives: 1,
      optOuts: 2,
    });
  });

  it("does not count out of office or bounces as replies", () => {
    const counters = attributeTemplateCounters(
      [send({ id: "m1" }), send({ id: "m2", enrollmentId: "e2" })],
      [
        inbound({ intent: "ooo" }),
        inbound({ enrollmentId: "e2", intent: "bounce_soft" }),
      ],
    );
    expect(counters.get(T_EMAIL)?.replies).toBe(0);
  });

  it("is idempotent when the same conversation is ingested twice", () => {
    const sends = [send({ id: "m1" })];
    const once = attributeTemplateCounters(sends, [inbound()]);
    const twice = attributeTemplateCounters(sends, [inbound(), inbound()]);
    expect(twice.get(T_EMAIL)).toEqual(once.get(T_EMAIL));
  });

  it("reports nothing for a template that has never been sent", () => {
    const counters = attributeTemplateCounters([], [inbound()]);
    expect(counters.size).toBe(0);
  });
});
