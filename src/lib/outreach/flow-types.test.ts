import { describe, expect, it } from "vitest";
import { defaultFlowGraph } from "@/lib/outreach/default-flow";
import {
  nextNodeId,
  validateFlowGraph,
  type FlowGraph,
} from "@/lib/outreach/flow-types";

describe("default flow (phase-1 cadence as a locked flow)", () => {
  it("validates cleanly", () => {
    expect(validateFlowGraph(defaultFlowGraph())).toEqual([]);
  });

  it("walks day 0→2→4→6→8→10: intro, text1, fu1, text2, fu2, text3", () => {
    const graph = defaultFlowGraph();
    const order: string[] = [];
    let node: string | null = "trigger";
    while (node) {
      order.push(node);
      node = nextNodeId(graph, node);
    }
    expect(order).toEqual([
      "trigger",
      "send_intro",
      "wait_1",
      "send_text_1",
      "wait_2",
      "send_followup_1",
      "wait_3",
      "send_text_2",
      "wait_4",
      "send_followup_2",
      "wait_5",
      "send_text_3",
      "complete",
    ]);
  });
});

describe("validateFlowGraph (strict schema — graphs are data, never code)", () => {
  it("requires exactly one trigger", () => {
    const graph: FlowGraph = { nodes: [], edges: [] };
    expect(validateFlowGraph(graph).join(" ")).toContain("exactly 1 trigger");
  });

  it("rejects unknown node types, bad sends, zero waits, dangling edges", () => {
    const graph = {
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "bad", type: "evil_eval" },
        { id: "send1", type: "send", config: { channel: "carrier_pigeon", stepKind: "intro" } },
        { id: "wait1", type: "wait", config: { days: 0 } },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "missing_node" },
        { id: "e2", from: "send1", to: "wait1" },
        { id: "e3", from: "wait1", to: "send1" },
      ],
    } as unknown as FlowGraph;
    const problems = validateFlowGraph(graph);
    expect(problems.some((p) => p.includes("unknown type"))).toBe(true);
    expect(problems.some((p) => p.includes("send.channel"))).toBe(true);
    expect(problems.some((p) => p.includes("wait must be > 0"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown to missing_node"))).toBe(true);
  });

  it("requires an edge per split branch", () => {
    const graph = {
      nodes: [
        { id: "trigger", type: "trigger" },
        {
          id: "split1",
          type: "split",
          config: { branches: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }] },
        },
        { id: "done", type: "outcome", config: { outcome: "meeting_booked" } },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "split1" },
        { id: "e2", from: "split1", to: "done", label: "a" },
      ],
    } as unknown as FlowGraph;
    const problems = validateFlowGraph(graph);
    expect(problems.some((p) => p.includes("no edge for split branch b"))).toBe(true);
  });

  it("condition branching follows edge labels with default fallback", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "cond", type: "condition", config: { kind: "reply_intent" } },
        { id: "yes", type: "outcome", config: { outcome: "meeting_booked" } },
        { id: "no", type: "outcome", config: { outcome: "no_interest" } },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "cond" },
        { id: "e2", from: "cond", to: "yes", label: "positive" },
        { id: "e3", from: "cond", to: "no", label: "default" },
      ],
    };
    expect(nextNodeId(graph, "cond", "positive")).toBe("yes");
    expect(nextNodeId(graph, "cond", "negative")).toBe("no");
    expect(nextNodeId(graph, "cond")).toBe("no");
  });
});
