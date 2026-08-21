import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachFlows, outreachFlowVersions } from "@/lib/db/schema";
import type { FlowGraph } from "@/lib/outreach/flow-types";

export const DEFAULT_FLOW_NAME = "Default 10-day sequence";

/**
 * The cold cadence as a locked linear flow, so launch day on the flow builder
 * is migration-free:
 * Day 0 intro email · Day 2 follow-up 1 · Day 6 follow-up 2. Waits are
 * calendar days, not business days.
 *
 * Email only, deliberately. The day 0 / day 4 / day 8 text steps this graph
 * used to carry were cold texts from a consumer iMessage account, which is
 * what got the operator's Apple account disabled after three days of use. A
 * consent gated text branch is separate work and will be added back once
 * consent records exist; nothing here may text a contact who never asked.
 */
export function defaultFlowGraph(): FlowGraph {
  return {
    nodes: [
      { id: "trigger", type: "trigger", label: "Enrolled", position: { x: 0, y: 0 } },
      {
        id: "send_intro",
        type: "send",
        label: "Intro email (day 0)",
        position: { x: 0, y: 110 },
        config: { channel: "email", stepKind: "intro" },
      },
      {
        id: "wait_1",
        type: "wait",
        label: "Wait 2 days",
        position: { x: 0, y: 220 },
        config: { days: 2, businessDays: false },
      },
      {
        id: "send_followup_1",
        type: "send",
        label: "Follow-up email 1 (day 2)",
        position: { x: 0, y: 330 },
        config: { channel: "email", stepKind: "followup_1" },
      },
      {
        id: "wait_2",
        type: "wait",
        label: "Wait 4 days",
        position: { x: 0, y: 440 },
        config: { days: 4, businessDays: false },
      },
      {
        id: "send_followup_2",
        type: "send",
        label: "Follow-up email 2 (day 6)",
        position: { x: 0, y: 550 },
        config: { channel: "email", stepKind: "followup_2" },
      },
      {
        id: "complete",
        type: "action",
        label: "Sequence complete",
        position: { x: 0, y: 660 },
        config: { action: "note", params: { summary: "Sequence completed without reply" } },
      },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "send_intro" },
      { id: "e2", from: "send_intro", to: "wait_1" },
      { id: "e3", from: "wait_1", to: "send_followup_1" },
      { id: "e4", from: "send_followup_1", to: "wait_2" },
      { id: "e5", from: "wait_2", to: "send_followup_2" },
      { id: "e6", from: "send_followup_2", to: "complete" },
    ],
  };
}

function graphsEqual(a: FlowGraph, b: FlowGraph): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Idempotent: ensure the locked default flow + current graph version exist.
 *
 * A changed graph is a NEW immutable version, never an edit of the old one,
 * and enrollments keep the flowVersionId they were created with. So the live
 * sequences that started on the version with text steps keep walking that
 * graph to the end; what stops those steps from texting is the text channel
 * switch, checked when the flow reaches the node.
 */
export async function ensureDefaultFlow(): Promise<{
  flowId: string;
  versionId: string;
}> {
  let [flow] = await db
    .select()
    .from(outreachFlows)
    .where(eq(outreachFlows.name, DEFAULT_FLOW_NAME))
    .limit(1);

  if (!flow) {
    [flow] = await db
      .insert(outreachFlows)
      .values({ name: DEFAULT_FLOW_NAME, status: "active", isLocked: true })
      .returning();
  }

  const desired = defaultFlowGraph();
  const [latest] = await db
    .select()
    .from(outreachFlowVersions)
    .where(eq(outreachFlowVersions.flowId, flow.id))
    .orderBy(desc(outreachFlowVersions.version))
    .limit(1);

  if (latest && graphsEqual(latest.graph as FlowGraph, desired)) {
    return { flowId: flow.id, versionId: latest.id };
  }

  const [version] = await db
    .insert(outreachFlowVersions)
    .values({
      flowId: flow.id,
      version: (latest?.version ?? 0) + 1,
      graph: desired,
    })
    .returning();
  return { flowId: flow.id, versionId: version.id };
}
