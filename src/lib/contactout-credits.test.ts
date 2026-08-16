import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let exhaustedAt: Date | null = null;

vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

vi.mock("@/lib/db/schema", () => ({ pipelineSettings: { id: "id" } }));

vi.mock("@/lib/pipeline-config", () => ({
  getOrCreateSettings: async () => ({
    id: "settings",
    contactoutCreditsExhaustedAt: exhaustedAt,
  }),
}));

const HOUR = 60 * 60 * 1000;

describe("ContactOut credits lock", () => {
  beforeEach(() => {
    exhaustedAt = null;
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is available when nothing has locked it", async () => {
    const { isContactOutCreditsAvailable } = await import(
      "@/lib/contactout-credits"
    );
    await expect(isContactOutCreditsAvailable("key")).resolves.toBe(true);
  });

  it("stays locked inside the 24h window", async () => {
    exhaustedAt = new Date();
    const { isContactOutCreditsAvailable } = await import(
      "@/lib/contactout-credits"
    );

    await expect(isContactOutCreditsAvailable("key")).resolves.toBe(false);
    vi.advanceTimersByTime(23 * HOUR);
    await expect(isContactOutCreditsAvailable("key")).resolves.toBe(false);
  });

  /*
   * The shipped bug: the in-process memo was checked BEFORE the timestamp, so
   * once a warm instance cached `false` it never re-read the clock and
   * ContactOut stayed switched off long past the 24h expiry.
   */
  it("unlocks after 24h without needing a process restart", async () => {
    exhaustedAt = new Date();
    const { isContactOutCreditsAvailable } = await import(
      "@/lib/contactout-credits"
    );

    await expect(isContactOutCreditsAvailable("key")).resolves.toBe(false);

    vi.advanceTimersByTime(25 * HOUR);
    exhaustedAt = new Date(Date.now() - 25 * HOUR);

    await expect(isContactOutCreditsAvailable("key")).resolves.toBe(true);
  });

  it("re-evaluates when the API key changes", async () => {
    exhaustedAt = new Date();
    const { isContactOutCreditsAvailable } = await import(
      "@/lib/contactout-credits"
    );

    await expect(isContactOutCreditsAvailable("old-key")).resolves.toBe(false);

    exhaustedAt = null;
    await expect(isContactOutCreditsAvailable("new-key")).resolves.toBe(true);
  });

  it("marking exhausted locks it immediately", async () => {
    const { isContactOutCreditsAvailable, markContactOutCreditsExhausted } =
      await import("@/lib/contactout-credits");

    await expect(isContactOutCreditsAvailable("key")).resolves.toBe(true);
    await markContactOutCreditsExhausted();
    await expect(isContactOutCreditsAvailable("key")).resolves.toBe(false);
  });
});
