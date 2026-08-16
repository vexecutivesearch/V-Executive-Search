import { describe, expect, it } from "vitest";

import { defaultFlowGraph } from "@/lib/outreach/default-flow";
import type { SendNodeConfig } from "@/lib/outreach/flow-types";
import { nextNodeId, triggerNode } from "@/lib/outreach/flow-types";

/**
 * Recovering the day-0 text for an enrollment that skipped it.
 *
 * text_1 is the introduction ("my name is Alejandro... I've just emailed
 * you") and text_2 opens with "Alejandro again", so resuming at text_2 greets
 * a stranger as a repeat contact. The backfill therefore rewinds to the day-0
 * text node — but a rewind that moved an enrollment *forward* would jump an
 * unsent intro and drop the email entirely, so the direction guard matters.
 */
function nodeOrder(graph: ReturnType<typeof defaultFlowGraph>) {
  const order = new Map<string, number>();
  let cursor: string | null = triggerNode(graph)?.id ?? null;
  for (let i = 0; cursor && !order.has(cursor); i += 1) {
    order.set(cursor, i);
    cursor = nextNodeId(graph, cursor);
  }
  return order;
}

function dayZeroTextNodeId(graph: ReturnType<typeof defaultFlowGraph>) {
  return graph.nodes.find(
    (n) =>
      n.type === "send" &&
      (n.config as SendNodeConfig | undefined)?.channel === "imessage",
  )?.id;
}

/** Mirrors the guard in phone-backfill: rewind only, never skip forward. */
function shouldRewind(currentNodeId: string): boolean {
  const graph = defaultFlowGraph();
  const order = nodeOrder(graph);
  const target = order.get(dayZeroTextNodeId(graph)!);
  const here = order.get(currentNodeId);
  if (here === undefined || target === undefined) return false;
  return here > target;
}

describe("day-zero text rewind", () => {
  it("targets text_1, the introduction, not a later text", () => {
    const graph = defaultFlowGraph();
    expect(dayZeroTextNodeId(graph)).toBe("send_text_1");
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
});
