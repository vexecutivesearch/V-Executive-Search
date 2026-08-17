import { describe, expect, it, vi } from "vitest";

import { remainingToday } from "@/lib/outreach/send-caps";

vi.mock("@/lib/db", () => ({ db: {} }));

/**
 * The system daily send cap is enforced PER CHANNEL — the configured number is
 * a ceiling for email and a separate ceiling for text.
 *
 * It used to be one shared all-channel total. On 2026-08-17 that cost 71 intro
 * emails: 83 emails plus 73 texts hit the shared 100 first, so the email loop
 * deferred everything after that while the sending pool still had headroom —
 * and the text channel had no ceiling of its own at all.
 */
describe("remainingToday", () => {
  it("leaves the rest of the channel's allowance", () => {
    expect(remainingToday(100, 83)).toBe(17);
  });

  it("is zero once the channel's own cap is reached", () => {
    expect(remainingToday(100, 100)).toBe(0);
    expect(remainingToday(100, 156)).toBe(0);
  });

  it("treats 0 as uncapped", () => {
    expect(remainingToday(0, 5_000)).toBe(Number.POSITIVE_INFINITY);
  });

  /*
   * The whole point: 83 emails and 73 texts on a cap of 100 leaves headroom on
   * both channels. Under the shared total it left none on either.
   */
  it("keeps the two channels independent", () => {
    const cap = 100;
    expect(remainingToday(cap, 83)).toBe(17); // email
    expect(remainingToday(cap, 73)).toBe(27); // text
    expect(remainingToday(cap, 83 + 73)).toBe(0); // the old shared behaviour
  });
});

describe("cap wiring", () => {
  const read = async (path: string) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(path, "utf8");
  };

  it("counts email sends for the email loop", async () => {
    const src = await read("src/lib/outreach/send-caps.ts");
    expect(src).toContain("eq(outreachMessages.channel, channel)");
    expect(src).toContain('eq(outreachMessages.status, "sent")');

    const dispatch = await read("src/lib/outreach/dispatch.ts");
    expect(dispatch).toContain('sentTodayOnChannel("email")');
    // The old all-channel helper must be gone, not merely unused.
    expect(dispatch).not.toMatch(/async function sentTodayTotal\b/);
  });

  it("applies the cap to the text queue as well", async () => {
    const queue = await read("src/app/api/outreach/imessage-queue/route.ts");
    expect(queue).toContain('sentTodayOnChannel("imessage")');
    expect(queue).toContain("remainingToday(settings.dailySendCap");
    // And actually stops handing the worker more than the allowance.
    expect(queue).toContain("out.length >= textsRemaining");
  });
});
