import { describe, expect, it } from "vitest";
import { defaultFlowGraph } from "@/lib/outreach/default-flow";
import {
  nextNodeId,
  validateFlowGraph,
  type FlowGraph,
} from "@/lib/outreach/flow-types";

describe("default flow (cold cadence as a locked flow)", () => {
  it("validates cleanly", () => {
    expect(validateFlowGraph(defaultFlowGraph())).toEqual([]);
  });

  it("walks intro on day 0, then follow-ups on day 2 and day 6", () => {
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
      "send_followup_1",
      "wait_2",
      "send_followup_2",
      "complete",
    ]);
  });

  /*
   * Cold texting is retired: Apple disabled the operator's iMessage for using
   * a consumer account for business messaging. A consent gated text branch is
   * separate work, so until then no send node in the cold flow may be a text.
   */
  it("has no text send node anywhere", () => {
    const graph = defaultFlowGraph();
    const channels = graph.nodes
      .filter((n) => n.type === "send")
      .map((n) => (n.config as { channel?: string } | undefined)?.channel);
    expect(channels).toEqual(["email", "email", "email"]);
    expect(JSON.stringify(graph)).not.toContain("imessage");
    expect(JSON.stringify(graph)).not.toContain("text_");
  });

  it("waits the day 2 and day 6 gaps in calendar days", () => {
    const waits = defaultFlowGraph()
      .nodes.filter((n) => n.type === "wait")
      .map((n) => n.config);
    expect(waits).toEqual([
      { days: 2, businessDays: false },
      { days: 4, businessDays: false },
    ]);
  });

  /*
   * advanceOnQueue existed so the day-0 text queued in the same pass as the
   * intro. With nothing following the intro on day 0, the flow must wait for
   * the send instead, or the day 2 gap starts counting from the queue.
   */
  it("makes the intro wait for its own send", () => {
    const intro = defaultFlowGraph().nodes.find((n) => n.id === "send_intro");
    expect(intro?.config).toEqual({ channel: "email", stepKind: "intro" });
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
