import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachFlows, outreachFlowVersions } from "@/lib/db/schema";
import type { FlowGraph } from "@/lib/outreach/flow-types";

export const DEFAULT_FLOW_NAME = "Default 10-day sequence";

/**
 * Phase-1 cadence expressed as a locked linear flow, so launch day on the
 * flow builder is migration-free:
 * Day 0 intro email · Day 2 text 1 · Day 4 follow-up 1 · Day 6 text 2 ·
 * Day 8 follow-up 2 · Day 10 text 3 (final).
 * Text steps are skipped at runtime for contacts without a verified
 * iMessage-capable number; waits are business-hours aware.
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
        id: "send_text_1",
        type: "send",
        label: "Text 1 (day 2)",
        position: { x: 0, y: 330 },
        config: { channel: "imessage", stepKind: "text_1" },
      },
      {
        id: "wait_2",
        type: "wait",
        label: "Wait 2 days",
        position: { x: 0, y: 440 },
        config: { days: 2, businessDays: false },
      },
      {
        id: "send_followup_1",
        type: "send",
        label: "Follow-up email 1 (day 4)",
        position: { x: 0, y: 550 },
        config: { channel: "email", stepKind: "followup_1" },
      },
      {
        id: "wait_3",
        type: "wait",
        label: "Wait 2 days",
        position: { x: 0, y: 660 },
        config: { days: 2, businessDays: false },
      },
      {
        id: "send_text_2",
        type: "send",
        label: "Text 2 (day 6)",
        position: { x: 0, y: 770 },
        config: { channel: "imessage", stepKind: "text_2" },
      },
      {
        id: "wait_4",
        type: "wait",
        label: "Wait 2 days",
        position: { x: 0, y: 880 },
        config: { days: 2, businessDays: false },
      },
      {
        id: "send_followup_2",
        type: "send",
        label: "Follow-up email 2 (day 8)",
        position: { x: 0, y: 990 },
        config: { channel: "email", stepKind: "followup_2" },
      },
      {
        id: "wait_5",
        type: "wait",
        label: "Wait 2 days",
        position: { x: 0, y: 1100 },
        config: { days: 2, businessDays: false },
      },
      {
        id: "send_text_3",
        type: "send",
        label: "Text 3 — final (day 10)",
        position: { x: 0, y: 1210 },
        config: { channel: "imessage", stepKind: "text_3" },
      },
      {
        id: "complete",
        type: "action",
        label: "Sequence complete",
        position: { x: 0, y: 1320 },
        config: { action: "note", params: { summary: "Sequence completed without reply" } },
      },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "send_intro" },
      { id: "e2", from: "send_intro", to: "wait_1" },
      { id: "e3", from: "wait_1", to: "send_text_1" },
      { id: "e4", from: "send_text_1", to: "wait_2" },
      { id: "e5", from: "wait_2", to: "send_followup_1" },
      { id: "e6", from: "send_followup_1", to: "wait_3" },
      { id: "e7", from: "wait_3", to: "send_text_2" },
      { id: "e8", from: "send_text_2", to: "wait_4" },
      { id: "e9", from: "wait_4", to: "send_followup_2" },
      { id: "e10", from: "send_followup_2", to: "wait_5" },
      { id: "e11", from: "wait_5", to: "send_text_3" },
      { id: "e12", from: "send_text_3", to: "complete" },
    ],
  };
}

/** Idempotent: ensure the locked default flow + v1 exist; returns version id. */
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

  const [latest] = await db
    .select()
    .from(outreachFlowVersions)
    .where(eq(outreachFlowVersions.flowId, flow.id))
    .orderBy(desc(outreachFlowVersions.version))
    .limit(1);
  if (latest) return { flowId: flow.id, versionId: latest.id };

  const [version] = await db
    .insert(outreachFlowVersions)
    .values({ flowId: flow.id, version: 1, graph: defaultFlowGraph() })
    .returning();
  return { flowId: flow.id, versionId: version.id };
}
