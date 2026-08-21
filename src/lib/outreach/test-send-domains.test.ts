import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_SENDING_DOMAINS } from "@/lib/outreach/sending-domains-catalog";

const sendOutreachEmail = vi.fn();

vi.mock("@/lib/outreach/resend-send", () => ({
  resolveProfileApiKey: () => "re_test",
  sendOutreachEmail: (...args: unknown[]) => sendOutreachEmail(...args),
}));

describe("sendCatalogTestEmails", () => {
  beforeEach(() => {
    sendOutreachEmail.mockReset();
    sendOutreachEmail.mockImplementation(async (options: { from: string }) => ({
      ok: true,
      resendId: `re_${options.from.split("@")[1]}`,
      messageId: `<test@${options.from.split("@")[1]}>`,
    }));
  });

  it("sends one email from each new domain to the given inbox", async () => {
    const { sendCatalogTestEmails } = await import(
      "@/lib/outreach/test-send-domains"
    );
    const results = await sendCatalogTestEmails({
      to: "hello@proventheory.co",
    });

    expect(results).toHaveLength(5);
    expect(results.every((row) => row.ok)).toBe(true);
    expect(sendOutreachEmail).toHaveBeenCalledTimes(5);
    expect(sendOutreachEmail.mock.calls.map((call) => call[0].from)).toEqual([
      "V Executive Search <odv@vexecutivetalent.com>",
      "V Executive Search <odv@vexecutiverecruit.us>",
      "V Executive Search <odv@vexecutives.com>",
      "V Executive Search <odv@vexecutiverecruit.work>",
      "V Executive Search <odv@villatororecruiting.us>",
    ]);
    expect(
      sendOutreachEmail.mock.calls.every(
        (call) => call[0].to === "hello@proventheory.co",
      ),
    ).toBe(true);
    expect(NEW_SENDING_DOMAINS).toHaveLength(5);
  });
});
