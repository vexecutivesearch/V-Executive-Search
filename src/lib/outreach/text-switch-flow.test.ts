import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SequenceEnrollment } from "@/lib/db/schema";
import type { FlowGraph } from "@/lib/outreach/flow-types";

/**
 * Live enrollments pin an immutable flow version, so the sequences that
 * started before cold texting was retired keep walking a graph with text
 * nodes in it. Dropping the nodes from the default graph therefore does not
 * stop those: the switch has to be read when the flow reaches the node.
 *
 * The node must be walked past rather than skipped in the message sense. A
 * text already queued belongs to the eight sitting in the worker queue, and
 * this pass must not mark them skipped on its way through.
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
    innerJoin: self,
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
        return thenable([{ id: `${name}-inserted` }]);
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

const settings = {
  enabled: true,
  dryRun: false,
  textEnabled: false,
  requireApproval: false,
  sendWindowStartHour: 9,
  sendWindowEndHour: 22,
  testingWindowUntil: null,
  testingWindowStartHour: null,
  testingWindowEndHour: null,
};
vi.mock("@/lib/outreach/settings", () => ({
  getOrCreateOutreachSettings: async () => settings,
}));

const draftStepForEnrollment = vi.fn(async () => ({
  subject: null,
  body: "Hey Stacy, Alejandro again with V Executive Search.",
  templateId: null,
}));
vi.mock("@/lib/outreach/node-draft", () => ({
  draftStepForEnrollment: () => draftStepForEnrollment(),
  contextForEnrollment: async () => null,
  evaluateContactProperty: async () => false,
}));

/** The graph the live enrollments are pinned to: day 0 email plus text. */
function pinnedGraphWithText(): FlowGraph {
  return {
    nodes: [
      { id: "trigger", type: "trigger" },
      {
        id: "send_intro",
        type: "send",
        config: { channel: "email", stepKind: "intro", advanceOnQueue: true },
      },
      {
        id: "send_text_1",
        type: "send",
        config: { channel: "imessage", stepKind: "text_1" },
      },
      { id: "wait_1", type: "wait", config: { days: 2, businessDays: false } },
      {
        id: "send_followup_1",
        type: "send",
        config: { channel: "email", stepKind: "followup_1" },
      },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "send_intro" },
      { id: "e2", from: "send_intro", to: "send_text_1" },
      { id: "e3", from: "send_text_1", to: "wait_1" },
      { id: "e4", from: "wait_1", to: "send_followup_1" },
    ],
  };
}

let versionCounter = 0;

function enrollmentOnTextNode(): SequenceEnrollment {
  // A fresh version id per test: flow graphs are immutable and cached by id.
  versionCounter += 1;
  const flowVersionId = `ver-${versionCounter}`;
  selectResults.set("outreach_flow_versions", [
    { id: flowVersionId, graph: pinnedGraphWithText() },
  ]);
  return {
    id: "enr-1",
    contactId: "contact-1",
    companyId: "company-1",
    status: "active",
    emailAddress: "stacy@pluspower.test",
    phoneNumber: "+17864083193",
    timezone: "America/New_York",
    flowVersionId,
    currentNodeId: "send_text_1",
    nodeState: {},
    nextStepAt: null,
    enrolledAt: new Date(),
  } as unknown as SequenceEnrollment;
}

const events = () =>
  inserts
    .filter((i) => i.table === "enrollment_events")
    .map((i) => i.values as { eventType: string; payload: Row });

beforeEach(() => {
  vi.clearAllMocks();
  settings.textEnabled = false;
  selectResults.clear();
  inserts.length = 0;
  updates.length = 0;
});

describe("a pinned flow reaching a text node with the channel off", () => {
  it("drafts nothing and queues nothing", async () => {
    const { advanceEnrollment } = await import("@/lib/outreach/flow-engine");
    await advanceEnrollment(enrollmentOnTextNode(), new Date());

    expect(draftStepForEnrollment).not.toHaveBeenCalled();
    expect(inserts.filter((i) => i.table === "outreach_messages")).toEqual([]);
  });

  it("leaves an already queued text alone instead of skipping it", async () => {
    selectResults.set("outreach_messages", [
      { id: "msg-1", status: "queued", stepKind: "text_1" },
    ]);
    const { advanceEnrollment } = await import("@/lib/outreach/flow-engine");
    await advanceEnrollment(enrollmentOnTextNode(), new Date());

    expect(
      updates.filter((u) => u.table === "outreach_messages"),
    ).toEqual([]);
  });

  it("walks on to the next step and says why in the audit trail", async () => {
    const { advanceEnrollment } = await import("@/lib/outreach/flow-engine");
    const result = await advanceEnrollment(enrollmentOnTextNode(), new Date());

    expect(result.transitions).toBeGreaterThan(0);
    const skip = events().find(
      (e) => e.payload.action === "skip_text_step",
    );
    expect(skip?.payload.step).toBe("text_1");
    expect(String(skip?.payload.reason)).toContain("switched off");
    // Parked on the wait that follows, not stuck on the text.
    expect(
      updates.some(
        (u) =>
          u.table === "sequence_enrollments" && u.set.currentNodeId === "wait_1",
      ),
    ).toBe(true);
  });

  it("still drafts the text when the channel is switched back on", async () => {
    settings.textEnabled = true;
    const { advanceEnrollment } = await import("@/lib/outreach/flow-engine");
    await advanceEnrollment(enrollmentOnTextNode(), new Date());

    expect(draftStepForEnrollment).toHaveBeenCalledTimes(1);
    expect(
      inserts.filter(
        (i) => i.table === "outreach_messages" && i.values.channel === "imessage",
      ),
    ).toHaveLength(1);
  });
});
