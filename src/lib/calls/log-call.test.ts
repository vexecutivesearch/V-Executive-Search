import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dial gate is a server-side rule, not a UI affordance.
 *
 * The call screen makes a mobile unclickable, but a logged call is a claim that
 * we dialed a number. If the endpoint accepted that claim for a mobile, the
 * request the UI refuses to make would still succeed, and the audit trail would
 * record a call we were not permitted to place.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
const inserts: Array<{ table: string; values: Row }> = [];
const syncCalls: Array<Record<string, unknown>> = [];

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
  },
}));

vi.mock("@/lib/outreach/call-list-sync", () => ({
  recordCallListOutreachEvent: (options: Record<string, unknown>) => {
    syncCalls.push(options);
    return Promise.resolve({ id: "entry-1", callStatus: "called_no_answer" });
  },
}));

const { logCall } = await import("@/lib/calls/log-call");

const BUSINESS_LINE = "+1 561-555-0100";
const MOBILE = "+1 561-555-0222";

function seed(options?: {
  contactPhones?: Row[];
  contactClassification?: string | null;
}) {
  selectResults.set("call_list_entries", [
    {
      id: "entry-1",
      companyId: "company-1",
      primaryContactId: "contact-1",
      callStatus: "ready_to_call",
      attempts: 0,
      notes: null,
    },
  ]);
  selectResults.set("companies", [
    {
      name: "Palm Harbor Logistics",
      phone: BUSINESS_LINE,
      phoneClassification: "business_line",
    },
  ]);
  selectResults.set("contacts", [
    {
      id: "contact-1",
      name: "Dana Reyes",
      phones:
        options?.contactPhones ??
        [{ number: MOBILE, source: "contactout", kind: "mobile" }],
      phoneClassification:
        options?.contactClassification === undefined
          ? "mobile"
          : options.contactClassification,
    },
  ]);
}

beforeEach(() => {
  selectResults.clear();
  inserts.length = 0;
  syncCalls.length = 0;
});

describe("logCall — the dial gate", () => {
  it("refuses a mobile even though it is on file", async () => {
    seed();
    const result = await logCall({
      entryId: "entry-1",
      outcome: "connected",
      phone: MOBILE,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(422);
    expect(result.error).toMatch(/mobile/i);
    expect(inserts.filter((i) => i.table === "call_outcomes")).toHaveLength(0);
  });

  /*
   * An unverified number type is treated as a mobile: absence of evidence that
   * a line is a landline is not evidence that it is one.
   */
  it("refuses an unclassified number", async () => {
    // An Apollo "work" direct dial on a contact with no stored class: as
    // likely to be a cell as a desk line, so it stays unknown.
    seed({
      contactPhones: [
        { number: "+1 561-555-0333", source: "apollo", kind: "work" },
      ],
      contactClassification: null,
    });
    const result = await logCall({
      entryId: "entry-1",
      outcome: "placed",
      phone: "+1 561-555-0333",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(422);
    expect(result.error).toMatch(/unverified/i);
  });

  it("refuses a number that is not on file for the company", async () => {
    seed();
    const result = await logCall({
      entryId: "entry-1",
      outcome: "connected",
      phone: "+1 305-555-9999",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toMatch(/not on file/i);
  });

  it("accepts the company main line and records the class it was dialed under", async () => {
    seed();
    const result = await logCall({
      entryId: "entry-1",
      outcome: "no_answer",
      phone: BUSINESS_LINE,
      notes: "Receptionist said to try Tuesday",
    });

    expect(result.ok).toBe(true);
    const written = inserts.find((i) => i.table === "call_outcomes");
    expect(written?.values.outcome).toBe("no_answer");
    expect(written?.values.phoneClassification).toBe("business_line");
    expect(written?.values.notes).toBe("Receptionist said to try Tuesday");
  });
});

describe("logCall — funnel effects", () => {
  it("bumps attempts and advances the status a no-answer implies", async () => {
    seed();
    await logCall({
      entryId: "entry-1",
      outcome: "no_answer",
      phone: BUSINESS_LINE,
    });

    expect(syncCalls[0]).toMatchObject({
      bumpAttempt: true,
      callStatus: "called_no_answer",
      activityType: "call",
    });
  });

  /*
   * callStatusEnum has no honest value for a gatekeeper pickup, so the status
   * is left alone. Stamping "Called — No Answer" on a call a receptionist
   * answered would misreport what happened.
   */
  it("leaves the status alone for a gatekeeper", async () => {
    seed();
    await logCall({
      entryId: "entry-1",
      outcome: "gatekeeper",
      phone: BUSINESS_LINE,
    });

    expect(syncCalls[0].callStatus).toBeUndefined();
    expect(syncCalls[0].bumpAttempt).toBe(true);
  });

  it("logs an outcome with no number at all", async () => {
    seed();
    const result = await logCall({ entryId: "entry-1", outcome: "placed" });
    expect(result.ok).toBe(true);
    const written = inserts.find((i) => i.table === "call_outcomes");
    expect(written?.values.phone).toBeNull();
    expect(written?.values.phoneClassification).toBeNull();
  });

  it("404s when the entry does not exist", async () => {
    selectResults.set("call_list_entries", []);
    const result = await logCall({ entryId: "nope", outcome: "placed" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(404);
  });
});
