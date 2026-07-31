import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import {
  formatCallBookedNote,
  parseCalendlyWebhookBody,
  verifyCalendlySignature,
} from "@/lib/outreach/calendly-booking";

describe("parseCalendlyWebhookBody", () => {
  it("parses invitee.created with nested scheduled_event", () => {
    const parsed = parseCalendlyWebhookBody({
      event: "invitee.created",
      payload: {
        email: "Miguel@Cultura.company",
        name: "Miguel",
        timezone: "America/New_York",
        uri: "https://api.calendly.com/scheduled_events/abc/invitees/xyz",
        text_reminder_number: "+1 (305) 555-0100",
        scheduled_event: {
          uri: "https://api.calendly.com/scheduled_events/abc",
          start_time: "2026-07-31T13:00:00.000000Z",
          end_time: "2026-07-31T13:30:00.000000Z",
        },
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.event).toBe("invitee.created");
    expect(parsed!.email).toBe("miguel@cultura.company");
    expect(parsed!.phone).toBe("3055550100");
    expect(parsed!.startTime?.toISOString()).toBe("2026-07-31T13:00:00.000Z");
    expect(parsed!.endTime?.toISOString()).toBe("2026-07-31T13:30:00.000Z");
  });

  it("accepts URI-only scheduled_event", () => {
    const parsed = parseCalendlyWebhookBody({
      event: "invitee.canceled",
      payload: {
        email: "a@b.com",
        scheduled_event: "https://api.calendly.com/scheduled_events/abc",
      },
    });
    expect(parsed!.scheduledEventUri).toContain("scheduled_events/abc");
    expect(parsed!.startTime).toBeNull();
  });
});

describe("formatCallBookedNote", () => {
  it("formats Eastern window for the Jul 31 booking", () => {
    const start = new Date("2026-07-31T13:00:00.000Z"); // 9:00 AM ET
    const end = new Date("2026-07-31T13:30:00.000Z");
    expect(formatCallBookedNote(start, end)).toBe(
      "Call Booked: Fri Jul 31, 2026 9:00–9:30 AM ET",
    );
  });

  it("formats the 15 minute Aug 3 booking", () => {
    const start = new Date("2026-08-03T13:00:00.000Z"); // 9:00 AM ET
    const end = new Date("2026-08-03T13:15:00.000Z");
    expect(formatCallBookedNote(start, end)).toBe(
      "Call Booked: Mon Aug 3, 2026 9:00–9:15 AM ET",
    );
  });
});

describe("verifyCalendlySignature", () => {
  it("accepts a valid t=,v1= HMAC", () => {
    const rawBody = '{"event":"invitee.created"}';
    const signingKey = "test-signing-key";
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", signingKey)
      .update(`${t}.${rawBody}`, "utf8")
      .digest("hex");
    expect(
      verifyCalendlySignature({
        rawBody,
        signatureHeader: `t=${t},v1=${v1}`,
        signingKey,
      }),
    ).toBe(true);
  });

  it("rejects a bad signature", () => {
    expect(
      verifyCalendlySignature({
        rawBody: "{}",
        signatureHeader: "t=1,v1=deadbeef",
        signingKey: "key",
      }),
    ).toBe(false);
  });
});
