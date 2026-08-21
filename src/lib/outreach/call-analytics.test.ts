import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opt-in conversion is the number that decides whether calling is worth doing,
 * so its denominator has to be honest: companies sent a link, not links sent.
 * A second link after a follow-up call is one prospect chased twice, and
 * counting it twice would understate the rate.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();

function thenable(result: Row[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    where: self,
    orderBy: self,
    groupBy: self,
    innerJoin: self,
    limit: self,
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
  },
}));

const { callStats, consentSourceStats } = await import(
  "@/lib/outreach/analytics"
);

const SENT = new Date("2026-08-10T14:00:00.000Z");

beforeEach(() => {
  selectResults.clear();
});

describe("callStats — the call funnel", () => {
  it("reports a connect rate over every logged dial", async () => {
    selectResults.set("call_outcomes", [
      { companyId: "c1", outcome: "connected" },
      { companyId: "c1", outcome: "no_answer" },
      { companyId: "c2", outcome: "gatekeeper" },
      { companyId: "c2", outcome: "voicemail" },
    ]);

    const stats = await callStats();
    expect(stats.placed).toBe(4);
    expect(stats.connected).toBe(1);
    expect(stats.connectRate).toBeCloseTo(0.25);
    // A receptionist picking up is a human, but not a connect.
    expect(stats.reachedHuman).toBe(2);
    expect(stats.companiesCalled).toBe(2);
  });

  it("returns a null connect rate with no calls, never 0%", async () => {
    const stats = await callStats();
    expect(stats.placed).toBe(0);
    expect(stats.connectRate).toBeNull();
    expect(stats.optInConversionRate).toBeNull();
  });
});

describe("callStats — opt-in conversion", () => {
  it("counts companies sent a link, not links sent", async () => {
    selectResults.set("opt_in_link_sends", [
      { companyId: "c1", sentAt: SENT, error: null },
      { companyId: "c1", sentAt: new Date("2026-08-12T14:00:00.000Z"), error: null },
      { companyId: "c2", sentAt: SENT, error: null },
    ]);
    selectResults.set("consent_records", [
      {
        companyId: "c1",
        capturedAt: new Date("2026-08-11T09:00:00.000Z"),
        sourceIdentifier: "self-hosted-opt-in:v1",
      },
    ]);

    const stats = await callStats();
    expect(stats.optInLinksSent).toBe(3);
    expect(stats.optInConversions).toBe(1);
    // Two companies were sent links, so one conversion is 50%, not 33%.
    expect(stats.optInConversionRate).toBeCloseTo(0.5);
  });

  it("ignores consent captured before the link was ever sent", async () => {
    selectResults.set("opt_in_link_sends", [
      { companyId: "c1", sentAt: SENT, error: null },
    ]);
    selectResults.set("consent_records", [
      {
        companyId: "c1",
        capturedAt: new Date("2026-07-01T09:00:00.000Z"),
        sourceIdentifier: "self-hosted-opt-in:v1",
      },
    ]);

    const stats = await callStats();
    expect(stats.optInConversions).toBe(0);
  });

  /*
   * The submitted work email can resolve to a different company row than the
   * one that was called, so the src tag on the emailed URL also attributes it.
   */
  it("attributes a conversion by the src tag on the form URL", async () => {
    selectResults.set("opt_in_link_sends", [
      { companyId: "c1", sentAt: SENT, error: null },
    ]);
    selectResults.set("consent_records", [
      {
        companyId: "other-company",
        capturedAt: new Date("2026-08-11T09:00:00.000Z"),
        sourceIdentifier: "self-hosted-opt-in:v1 src=call:c1",
      },
    ]);

    const stats = await callStats();
    expect(stats.optInConversions).toBe(1);
  });

  it("records a failed send as an attempt, not a silent loss", async () => {
    selectResults.set("opt_in_link_sends", [
      { companyId: "c1", sentAt: SENT, error: "Resend HTTP 422" },
    ]);

    const stats = await callStats();
    expect(stats.optInLinksSent).toBe(1);
    expect(stats.optInLinkFailures).toBe(1);
    expect(stats.optInConversions).toBe(0);
  });
});

describe("consentSourceStats", () => {
  it("splits captured, revoked and live-SMS per capture mechanism", async () => {
    selectResults.set("consent_records", [
      { source: "web_form", channelScope: "both", revokedAt: null },
      { source: "web_form", channelScope: "email", revokedAt: null },
      { source: "web_form", channelScope: "both", revokedAt: SENT },
      { source: "meta_lead_ad", channelScope: "sms", revokedAt: null },
    ]);

    const rows = await consentSourceStats();
    const form = rows.find((r) => r.source === "web_form");
    expect(form).toMatchObject({ captured: 3, revoked: 1, liveSms: 1 });
    expect(rows.find((r) => r.source === "meta_lead_ad")).toMatchObject({
      captured: 1,
      liveSms: 1,
    });
  });
});
