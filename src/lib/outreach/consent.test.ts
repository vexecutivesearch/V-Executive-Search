import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentRecord } from "@/lib/db/schema";

/**
 * Consent is an artifact, not a boolean, and its default is "no".
 *
 * The pipeline's existing legal posture — legal_basis
 * "legitimate interest — B2B recruitment outreach" — covers cold B2B email and
 * says nothing about texting. A cold lead therefore has no SMS consent no
 * matter how warm the email thread got, and a withdrawn record is treated as
 * if it were never captured even though it stays on the table for retention.
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
          returning: () =>
            Promise.resolve([{ id: `${name}-inserted`, ...values }]),
        };
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Row) => {
        const name = getTableName(table);
        updates.push({ table: name, set });
        return thenable([{ id: "consent-1", ...set }]);
      },
    }),
  },
}));

const {
  consentCoversSms,
  hasSmsConsent,
  isConsentRevoked,
  recordConsent,
  revokeConsent,
  selectGoverningSmsConsent,
} = await import("@/lib/outreach/consent");

const DISCLOSURE =
  "By checking this box, I agree that V Executive Search may send me recurring text messages…";

function record(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: "consent-1",
    contactId: "contact-1",
    companyId: "company-1",
    email: "hiring@example.com",
    phone: "+1 (561) 555-0111",
    channelScope: "both",
    disclosureText: DISCLOSURE,
    source: "web_form",
    sourceIdentifier: "sms-web-form-2026-08",
    capturedAt: new Date("2026-08-01T15:00:00.000Z"),
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    revokedAt: null,
    revokedReason: null,
    createdAt: new Date("2026-08-01T15:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  selectResults.clear();
  inserts.length = 0;
  updates.length = 0;
});

describe("hasSmsConsent — cold leads", () => {
  it("returns null for a cold contact with no consent record", async () => {
    selectResults.set("consent_records", []);
    await expect(
      hasSmsConsent({ contactId: "contact-cold", phone: "+15615550999" }),
    ).resolves.toBeNull();
  });

  /*
   * The B2B email posture is not consent. Even a contact mid-sequence with a
   * warm reply has no SMS permission until a form is submitted.
   */
  it("returns null when asked with no identity at all", async () => {
    selectResults.set("consent_records", [record()]);
    await expect(hasSmsConsent({})).resolves.toBeNull();
    await expect(
      hasSmsConsent({ contactId: null, phone: "  " }),
    ).resolves.toBeNull();
  });

  it("returns the governing record for a consented number", async () => {
    selectResults.set("consent_records", [record()]);
    const got = await hasSmsConsent({
      contactId: "contact-1",
      phone: "561-555-0111",
    });
    expect(got?.id).toBe("consent-1");
    expect(got?.disclosureText).toBe(DISCLOSURE);
  });
});

describe("hasSmsConsent — revoked records", () => {
  it("treats a revoked record as absent", async () => {
    selectResults.set("consent_records", [
      record({ revokedAt: new Date("2026-08-10T00:00:00.000Z"), revokedReason: "STOP" }),
    ]);
    await expect(
      hasSmsConsent({ contactId: "contact-1", phone: "+15615550111" }),
    ).resolves.toBeNull();
  });

  it("does not let an older live record revive a revoked newer one", async () => {
    // Same number, consent given then withdrawn: the withdrawal wins.
    selectResults.set("consent_records", [
      record({
        id: "consent-new",
        capturedAt: new Date("2026-08-05T00:00:00.000Z"),
        revokedAt: new Date("2026-08-06T00:00:00.000Z"),
      }),
    ]);
    await expect(
      hasSmsConsent({ phone: "+15615550111" }),
    ).resolves.toBeNull();
  });
});

describe("selectGoverningSmsConsent", () => {
  it("ignores email-only consent when asked about SMS", () => {
    expect(
      selectGoverningSmsConsent([record({ channelScope: "email" })], {
        phone: "+15615550111",
      }),
    ).toBeNull();
    expect(consentCoversSms(record({ channelScope: "email" }))).toBe(false);
  });

  /*
   * Consent is granted for a specific mobile. A record for the same person's
   * other number must not authorize a different one.
   */
  it("will not apply one number's consent to another number", () => {
    expect(
      selectGoverningSmsConsent([record()], {
        contactId: "contact-1",
        phone: "+15615550222",
      }),
    ).toBeNull();
  });

  it("prefers the most recent live record", () => {
    const older = record({ id: "old", capturedAt: new Date("2026-07-01T00:00:00.000Z") });
    const newer = record({ id: "new", capturedAt: new Date("2026-08-01T00:00:00.000Z") });
    expect(
      selectGoverningSmsConsent([older, newer], { phone: "+15615550111" })?.id,
    ).toBe("new");
  });

  it("falls back to the contact when no number is supplied", () => {
    expect(
      selectGoverningSmsConsent([record({ phone: null })], {
        contactId: "contact-1",
      })?.id,
    ).toBe("consent-1");
  });
});

describe("consent record lifecycle", () => {
  it("stores the disclosure verbatim alongside the capture metadata", async () => {
    await recordConsent({
      contactId: "contact-1",
      companyId: "company-1",
      email: "hiring@example.com",
      phone: "+15615550111",
      channelScope: "both",
      disclosureText: DISCLOSURE,
      source: "web_form",
      sourceIdentifier: "sms-web-form-2026-08",
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    });

    const written = inserts.find((i) => i.table === "consent_records");
    expect(written?.values.disclosureText).toBe(DISCLOSURE);
    expect(written?.values.ipAddress).toBe("203.0.113.7");
    expect(written?.values.userAgent).toBe("Mozilla/5.0");
    expect(written?.values.source).toBe("web_form");
  });

  it("revokes by stamping the row rather than deleting it", async () => {
    const revoked = await revokeConsent({
      consentRecordId: "consent-1",
      reason: "replied STOP",
    });
    const update = updates.find((u) => u.table === "consent_records");
    expect(update?.set.revokedReason).toBe("replied STOP");
    expect(update?.set.revokedAt).toBeInstanceOf(Date);
    expect(isConsentRevoked(revoked!)).toBe(true);
  });
});
