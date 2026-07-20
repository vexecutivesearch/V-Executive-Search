/**
 * Outreach flow graphs — declarative JSON interpreted by the engine.
 * NEVER evaluated as code; validated against this strict schema on save.
 */

import type { OutreachChannel, OutreachTemplateKind } from "@/lib/db/schema";

export type FlowNodeType =
  | "trigger"
  | "wait"
  | "send"
  | "condition"
  | "split"
  | "wait_manual"
  | "action"
  | "outcome";

export type WaitNodeConfig = {
  days?: number;
  hours?: number;
  /** Skip weekends when computing the deadline (default true). */
  businessDays?: boolean;
};

export type SendNodeConfig = {
  channel: OutreachChannel;
  stepKind: OutreachTemplateKind;
  /** Optional template binding; default picks active templates of the kind. */
  templateId?: string;
};

export type ConditionNodeConfig = {
  kind: "reply_intent" | "no_reply_timeout" | "contact_property";
  /** For no_reply_timeout: days since last outbound send. */
  timeoutDays?: number;
  /** For contact_property: property path (icp_score, contact_title…). */
  property?: string;
  op?: "eq" | "neq" | "gte" | "lte" | "contains";
  value?: string | number | boolean;
};

export type SplitNodeConfig = {
  /** Weighted A/B branches; edge labels must match branch keys. */
  branches: Array<{ key: string; weight: number }>;
};

export type WaitManualNodeConfig = {
  /** Falls through the "timeout" (or default) edge after N days. */
  timeoutDays?: number;
  note?: string;
};

export type ActionNodeConfig = {
  action: "suppress" | "set_company_status" | "notify" | "note";
  params?: Record<string, string | number | boolean>;
};

export type OutcomeNodeConfig = {
  /** Conversion marker: meeting_booked, deal_opened… feeds ROI analytics. */
  outcome: string;
};

export type FlowNodeConfig =
  | WaitNodeConfig
  | SendNodeConfig
  | ConditionNodeConfig
  | SplitNodeConfig
  | WaitManualNodeConfig
  | ActionNodeConfig
  | OutcomeNodeConfig
  | Record<string, never>;

export type FlowNode = {
  id: string;
  type: FlowNodeType;
  label?: string;
  /** Canvas position (builder only — engine ignores). */
  position?: { x: number; y: number };
  config?: FlowNodeConfig;
};

export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  /**
   * Branch label. Condition nodes: intent name / "match" / "no_match" /
   * "timeout" / "default". Split nodes: branch key. Wait-manual: "done" /
   * "timeout". Linear nodes: omitted.
   */
  label?: string;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

const NODE_TYPES: ReadonlySet<string> = new Set([
  "trigger",
  "wait",
  "send",
  "condition",
  "split",
  "wait_manual",
  "action",
  "outcome",
]);

const SEND_CHANNELS = new Set(["email", "imessage"]);
const STEP_KINDS = new Set([
  "intro",
  "followup_1",
  "followup_2",
  "text_1",
  "text_2",
  "text_3",
  "reply_positive",
  "reply_info_request",
]);

/** Strict structural validation — returns human-readable problems. */
export function validateFlowGraph(graph: unknown): string[] {
  const problems: string[] = [];
  const g = graph as FlowGraph;

  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    return ["graph must have nodes[] and edges[]"];
  }

  const ids = new Set<string>();
  let triggers = 0;
  for (const node of g.nodes) {
    if (!node?.id || typeof node.id !== "string") {
      problems.push("node missing id");
      continue;
    }
    if (ids.has(node.id)) problems.push(`duplicate node id ${node.id}`);
    ids.add(node.id);
    if (!NODE_TYPES.has(node.type)) {
      problems.push(`node ${node.id}: unknown type ${String(node.type)}`);
      continue;
    }
    if (node.type === "trigger") triggers += 1;

    const config = (node.config ?? {}) as Record<string, unknown>;
    if (node.type === "send") {
      if (!SEND_CHANNELS.has(String(config.channel))) {
        problems.push(`node ${node.id}: send.channel must be email|imessage`);
      }
      if (!STEP_KINDS.has(String(config.stepKind))) {
        problems.push(`node ${node.id}: send.stepKind invalid`);
      }
    }
    if (node.type === "wait") {
      const days = Number(config.days ?? 0);
      const hours = Number(config.hours ?? 0);
      if (!Number.isFinite(days) || !Number.isFinite(hours) || days < 0 || hours < 0) {
        problems.push(`node ${node.id}: wait duration invalid`);
      }
      if (days === 0 && hours === 0) {
        problems.push(`node ${node.id}: wait must be > 0`);
      }
    }
    if (node.type === "split") {
      const branches = config.branches as SplitNodeConfig["branches"] | undefined;
      if (!Array.isArray(branches) || branches.length < 2) {
        problems.push(`node ${node.id}: split needs >= 2 branches`);
      } else {
        const total = branches.reduce((sum, b) => sum + Number(b.weight || 0), 0);
        if (total <= 0) problems.push(`node ${node.id}: split weights must sum > 0`);
      }
    }
    if (node.type === "condition") {
      const kind = String(config.kind ?? "");
      if (!["reply_intent", "no_reply_timeout", "contact_property"].includes(kind)) {
        problems.push(`node ${node.id}: condition.kind invalid`);
      }
    }
    if (node.type === "action") {
      const action = String(config.action ?? "");
      if (!["suppress", "set_company_status", "notify", "note"].includes(action)) {
        problems.push(`node ${node.id}: action invalid`);
      }
    }
    if (node.type === "outcome" && !String(config.outcome ?? "").trim()) {
      problems.push(`node ${node.id}: outcome label required`);
    }
  }

  if (triggers !== 1) problems.push(`graph needs exactly 1 trigger (found ${triggers})`);

  const edgeIds = new Set<string>();
  for (const edge of g.edges) {
    if (!edge?.id) {
      problems.push("edge missing id");
      continue;
    }
    if (edgeIds.has(edge.id)) problems.push(`duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.from)) problems.push(`edge ${edge.id}: unknown from ${edge.from}`);
    if (!ids.has(edge.to)) problems.push(`edge ${edge.id}: unknown to ${edge.to}`);
  }

  // Split branch keys must have matching edges.
  for (const node of g.nodes) {
    if (node.type !== "split") continue;
    const branches = ((node.config ?? {}) as SplitNodeConfig).branches ?? [];
    for (const branch of branches) {
      if (!g.edges.some((e) => e.from === node.id && e.label === branch.key)) {
        problems.push(`node ${node.id}: no edge for split branch ${branch.key}`);
      }
    }
  }

  // Every non-terminal node should have at least one outgoing edge.
  for (const node of g.nodes) {
    if (node.type === "outcome") continue;
    if (!g.edges.some((e) => e.from === node.id)) {
      if (node.type !== "action") {
        problems.push(`node ${node.id} (${node.type}) has no outgoing edge`);
      }
    }
  }

  return problems;
}

export function triggerNode(graph: FlowGraph): FlowNode | null {
  return graph.nodes.find((n) => n.type === "trigger") ?? null;
}

export function nodeById(graph: FlowGraph, id: string): FlowNode | null {
  return graph.nodes.find((n) => n.id === id) ?? null;
}

export function edgesFrom(graph: FlowGraph, nodeId: string): FlowEdge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

/** Follow the edge matching a label, falling back to default/unlabeled. */
export function nextNodeId(
  graph: FlowGraph,
  nodeId: string,
  label?: string,
): string | null {
  const edges = edgesFrom(graph, nodeId);
  if (label) {
    const exact = edges.find((e) => e.label === label);
    if (exact) return exact.to;
  }
  const fallback =
    edges.find((e) => !e.label || e.label === "default") ?? edges[0];
  return fallback?.to ?? null;
}
