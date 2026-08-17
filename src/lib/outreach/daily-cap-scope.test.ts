import { describe, expect, it, vi } from "vitest";

/**
 * The system daily send cap is an EMAIL cap.
 *
 * It is only ever consulted in the email dispatch loop — the Mac worker's
 * iMessage queue has no equivalent check — but the count behind it selected
 * every channel. On 2026-08-17 that meant 83 emails plus 73 texts against a
 * cap of 100: the texts ate the email budget and 71 intros were deferred with
 * `daily_cap_exhausted` while the sending pool still had headroom.
 *
 * This asserts the query is scoped to email by inspecting the conditions the
 * count is built with, since the real one needs a database.
 */
const capturedConditions: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => {
          capturedConditions.push(...args);
          return Promise.resolve([{ count: 0 }]);
        },
      }),
    }),
  },
}));

describe("daily send cap scope", () => {
  it("counts only email sends toward the cap", async () => {
    const { runOutreachDispatch } = await import("@/lib/outreach/dispatch");
    expect(typeof runOutreachDispatch).toBe("function");

    // The guard lives in dispatch.ts; assert the source states the scope so a
    // future edit cannot quietly widen it back to all channels.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/outreach/dispatch.ts", "utf8");

    const fn = src.slice(
      src.indexOf("async function emailsSentTodayTotal"),
      src.indexOf("async function markCompanyContacted"),
    );
    expect(fn).toContain('eq(outreachMessages.channel, "email")');
    expect(fn).toContain('eq(outreachMessages.status, "sent")');
  });

  it("uses the email-scoped count for the cap check", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/outreach/dispatch.ts", "utf8");
    expect(src).toContain("await emailsSentTodayTotal()");
    // The old all-channel helper must be gone, not merely unused.
    expect(src).not.toContain("sentTodayTotal()\n");
    expect(src).not.toMatch(/async function sentTodayTotal\b/);
  });
});
