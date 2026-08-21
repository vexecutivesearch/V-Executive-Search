import { describe, expect, it } from "vitest";

import { defaultFlowGraph } from "@/lib/outreach/default-flow";
import type { FlowGraph, SendNodeConfig } from "@/lib/outreach/flow-types";
import { nextNodeId, triggerNode } from "@/lib/outreach/flow-types";

/**
 * Recovering the day-0 text for an enrollment that skipped it.
 *
 * text_1 is the introduction ("my name is Alejandro... I've just emailed
 * you") and text_2 opens with "Alejandro again", so resuming at text_2 greets
 * a stranger as a repeat contact. The backfill therefore rewinds to the day-0
 * text node — but a rewind that moved an enrollment *forward* would jump an
 * unsent intro and drop the email entirely, so the direction guard matters.
 *
 * The current default flow has no text nodes at all, so the guard is exercised
 * here against the graph the pinned versions still carry: enrollments keep the
 * flow version they started on, and those are the only ones the rewind can
 * still reach.
 */
function textCadenceGraph(): FlowGraph {
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
      { id: "wait_2", type: "wait", config: { days: 2, businessDays: false } },
      {
        id: "send_text_2",
        type: "send",
        config: { channel: "imessage", stepKind: "text_2" },
      },
      { id: "wait_3", type: "wait", config: { days: 2, businessDays: false } },
      {
        id: "send_followup_2",
        type: "send",
        config: { channel: "email", stepKind: "followup_2" },
      },
      { id: "wait_4", type: "wait", config: { days: 2, businessDays: false } },
      {
        id: "send_text_3",
        type: "send",
        config: { channel: "imessage", stepKind: "text_3" },
      },
      {
        id: "complete",
        type: "action",
        config: { action: "note", params: { summary: "done" } },
      },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "send_intro" },
      { id: "e2", from: "send_intro", to: "send_text_1" },
      { id: "e3", from: "send_text_1", to: "wait_1" },
      { id: "e4", from: "wait_1", to: "send_followup_1" },
      { id: "e5", from: "send_followup_1", to: "wait_2" },
      { id: "e6", from: "wait_2", to: "send_text_2" },
      { id: "e7", from: "send_text_2", to: "wait_3" },
      { id: "e8", from: "wait_3", to: "send_followup_2" },
      { id: "e9", from: "send_followup_2", to: "wait_4" },
      { id: "e10", from: "wait_4", to: "send_text_3" },
      { id: "e11", from: "send_text_3", to: "complete" },
    ],
  };
}

function nodeOrder(graph: FlowGraph) {
  const order = new Map<string, number>();
  let cursor: string | null = triggerNode(graph)?.id ?? null;
  for (let i = 0; cursor && !order.has(cursor); i += 1) {
    order.set(cursor, i);
    cursor = nextNodeId(graph, cursor);
  }
  return order;
}

function dayZeroTextNodeId(graph: FlowGraph) {
  return graph.nodes.find(
    (n) =>
      n.type === "send" &&
      (n.config as SendNodeConfig | undefined)?.channel === "imessage",
  )?.id;
}

/** Mirrors the guard in phone-backfill: rewind only, never skip forward. */
function shouldRewind(currentNodeId: string, graph = textCadenceGraph()): boolean {
  const order = nodeOrder(graph);
  const target = order.get(dayZeroTextNodeId(graph)!);
  const here = order.get(currentNodeId);
  if (here === undefined || target === undefined) return false;
  return here > target;
}

describe("day-zero text rewind", () => {
  it("targets text_1, the introduction, not a later text", () => {
    expect(dayZeroTextNodeId(textCadenceGraph())).toBe("send_text_1");
  });

  it("walks the whole locked flow, so every node has a position", () => {
    const graph = defaultFlowGraph();
    const order = nodeOrder(graph);
    expect(order.size).toBe(graph.nodes.length);
  });

  /*
   * The real case: the text node was skipped at enroll time and the flow
   * parked at the first wait.
   */
  it("rewinds an enrollment parked past the text step", () => {
    expect(shouldRewind("wait_1")).toBe(true);
    expect(shouldRewind("send_followup_1")).toBe(true);
    expect(shouldRewind("send_text_3")).toBe(true);
  });

  it("never jumps an enrollment forward over an unsent intro", () => {
    // Rewinding from send_intro would skip the email entirely.
    expect(shouldRewind("send_intro")).toBe(false);
    expect(shouldRewind("trigger")).toBe(false);
  });

  it("does nothing when already sitting on the text step", () => {
    expect(shouldRewind("send_text_1")).toBe(false);
  });

  it("ignores a node that is not in the flow at all", () => {
    expect(shouldRewind("node_from_another_flow")).toBe(false);
  });

  /* Nothing to rewind to in the cold flow any more: it never texts. */
  it("is a no-op on the current default flow", () => {
    const graph = defaultFlowGraph();
    expect(dayZeroTextNodeId(graph)).toBeUndefined();
    for (const node of graph.nodes) {
      expect(shouldRewind(node.id, graph)).toBe(false);
    }
  });
});
