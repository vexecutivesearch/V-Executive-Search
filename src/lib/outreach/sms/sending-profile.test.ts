import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasViolation,
  profileHealth,
  rampCap,
} from "@/lib/outreach/profiles";

/**
 * Registering the Twilio number as a sending_profiles row is the whole point:
 * ramp stages, daily caps, health scoring and throttling already exist and key
 * on kind + status, so an SMS profile inherits them instead of growing a second
 * copy. What it must NOT do is become sendable on its own — pickSendingProfile
 * only draws from warming/active/throttled, so the row ships as `new` until the
 * A2P campaign is approved and the flag is flipped.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
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
        return {
          returning: () => Promise.resolve([{ id: "profile-new", ...values }]),
          then: (onFulfilled?: (value: Row[]) => unknown) =>
            Promise.resolve([{ id: "profile-new" }]).then(onFulfilled),
        };
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

const ensure = async (env: Record<string, string | undefined>) => {
  const { ensureSmsSendingProfile } = await import(
    "@/lib/outreach/sms/sending-profile"
  );
  return ensureSmsSendingProfile(env, new Date("2026-08-21T12:00:00Z"));
};

const SERVICE = { TWILIO_MESSAGING_SERVICE_SID: "MG0000000000000000000000000000003" };

beforeEach(() => {
  selectResults.clear();
  inserts.length = 0;
  updates.length = 0;
  selectResults.set("sending_profiles", []);
});

describe("registering the Twilio identity", () => {
  it("creates an imessage_number profile that cannot send yet", async () => {
    const result = await ensure(SERVICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.activated).toBe(false);

    const row = inserts.find((i) => i.table === "sending_profiles")?.values;
    expect(row).toMatchObject({
      kind: "imessage_number",
      // `new` is excluded from pickSendingProfile's pool.
      status: "new",
      rampStage: 0,
      dailyLimit: rampCap(0),
    });
    expect(row?.warmingStartedAt).toBeNull();
  });

  it("starts warm-up only when the enable flag is on", async () => {
    const result = await ensure({ ...SERVICE, OUTREACH_SMS_ENABLED: "true" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activated).toBe(true);
    const row = inserts.find((i) => i.table === "sending_profiles")?.values;
    expect(row).toMatchObject({ status: "warming", dailyLimit: rampCap(0) });
    expect(row?.warmingStartedAt).toBeInstanceOf(Date);
  });

  it("stores the messaging service SID as the sending identity", async () => {
    // The A2P campaign hangs off the service, so that — not a number — is what
    // the profile represents when one is configured.
    await ensure(SERVICE);
    const row = inserts.find((i) => i.table === "sending_profiles")?.values;
    expect(row?.appleIdLabel).toBe(SERVICE.TWILIO_MESSAGING_SERVICE_SID);
    expect(row?.phoneNumber).toBeNull();
  });

  it("stores a bare number in phone_number", async () => {
    await ensure({ TWILIO_FROM_NUMBER: "+15615550999" });
    const row = inserts.find((i) => i.table === "sending_profiles")?.values;
    expect(row?.phoneNumber).toBe("+15615550999");
  });

  it("is idempotent — a second call neither duplicates nor rewinds warm-up", async () => {
    selectResults.set("sending_profiles", [
      {
        id: "profile-1",
        kind: "imessage_number",
        label: "SMS via MG0000000000000000000000000000003",
        status: "warming",
        rampStage: 4,
        dailyLimit: 25,
        warmingStartedAt: new Date("2026-07-01T00:00:00Z"),
        cleanSince: new Date("2026-08-14T00:00:00Z"),
      },
    ]);
    const result = await ensure({ ...SERVICE, OUTREACH_SMS_ENABLED: "true" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.profileId).toBe("profile-1");
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("promotes an already-registered profile once the flag goes on", async () => {
    selectResults.set("sending_profiles", [
      {
        id: "profile-1",
        kind: "imessage_number",
        label: "SMS via MG0000000000000000000000000000003",
        status: "new",
        rampStage: 0,
        dailyLimit: 5,
        warmingStartedAt: null,
        cleanSince: null,
      },
    ]);
    await ensure({ ...SERVICE, OUTREACH_SMS_ENABLED: "true" });
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ status: "warming" });
  });

  it("reports the misconfiguration instead of registering a half-identity", async () => {
    const result = await ensure({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("TWILIO_MESSAGING_SERVICE_SID");
    expect(inserts).toHaveLength(0);
  });
});

describe("the warm-up machinery on a non-email profile", () => {
  it("caps and throttles on counters that have nothing to do with email", () => {
    // rampCap and the health/violation calls read ramp stage and the delivery
    // counters only — no domain, no DNS, no Resend key.
    expect(rampCap(0)).toBe(5);
    expect(rampCap(3)).toBe(20);
    expect(rampCap(20)).toBe(50);

    const smsProfile = {
      totalSent: 100,
      totalDelivered: 98,
      totalBounced: 2,
      totalComplaints: 0,
      totalReplies: 4,
    };
    expect(profileHealth(smsProfile)).toBeGreaterThan(0.5);
    expect(hasViolation(smsProfile)).toBe(false);
    // Carrier rejections land in total_bounced, so the same line throttles SMS.
    expect(hasViolation({ ...smsProfile, totalBounced: 9 })).toBe(true);
  });
});
