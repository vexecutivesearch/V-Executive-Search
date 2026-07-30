"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { OutreachFlow } from "@/lib/db/schema";
import type { FlowEdge, FlowGraph, FlowNode, FlowNodeType } from "@/lib/outreach/flow-types";
import { api, Badge, btn, btnPrimary, input, label as labelCls, statusTone } from "./shared";

type VersionRow = {
  id: string;
  version: number;
  graph: FlowGraph;
  enrollments: number;
  createdAt: string;
};

type SimulationStep = {
  nodeId: string;
  type: string;
  label?: string;
  detail: string;
  draftedSubject?: string | null;
  draftedBody?: string | null;
};

const NODE_PALETTE: Array<{ type: FlowNodeType; label: string; config: Record<string, unknown> }> = [
  { type: "wait", label: "Wait", config: { days: 2, businessDays: true } },
  { type: "send", label: "Send email", config: { channel: "email", stepKind: "followup_1" } },
  { type: "send", label: "Send text", config: { channel: "imessage", stepKind: "text_1" } },
  { type: "condition", label: "Condition", config: { kind: "no_reply_timeout", timeoutDays: 3 } },
  { type: "split", label: "A/B split", config: { branches: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }] } },
  { type: "wait_manual", label: "Wait for manual", config: { timeoutDays: 3 } },
  { type: "action", label: "Action", config: { action: "note", params: { summary: "" } } },
  { type: "outcome", label: "Outcome", config: { outcome: "meeting_booked" } },
];

const NODE_COLORS: Record<string, string> = {
  trigger: "#0ea5e9",
  wait: "#a78bfa",
  send: "#22c55e",
  condition: "#f59e0b",
  split: "#ec4899",
  wait_manual: "#f97316",
  action: "#64748b",
  outcome: "#14b8a6",
};

function toReactFlow(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((node, i) => ({
      id: node.id,
      position: node.position ?? { x: 80, y: i * 100 },
      data: {
        label: `${node.label ?? node.type}`,
        flowType: node.type,
        config: node.config ?? {},
      },
      style: {
        border: `2px solid ${NODE_COLORS[node.type] ?? "#999"}`,
        borderRadius: 10,
        padding: 6,
        fontSize: 12,
        background: "var(--background, white)",
      },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      animated: false,
    })),
  };
}

function fromReactFlow(nodes: Node[], edges: Edge[]): FlowGraph {
  return {
    nodes: nodes.map((node): FlowNode => ({
      id: node.id,
      type: (node.data as { flowType: FlowNodeType }).flowType,
      label: String((node.data as { label?: string }).label ?? ""),
      position: { x: node.position.x, y: node.position.y },
      config: (node.data as { config?: FlowNode["config"] }).config ?? {},
    })),
    edges: edges.map((edge): FlowEdge => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      label: edge.label ? String(edge.label) : undefined,
    })),
  };
}

export function FlowBuilder() {
  const [flows, setFlows] = useState<OutreachFlow[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<OutreachFlow | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<SimulationStep[] | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simDraft, setSimDraft] = useState(false);
  const [simIntent, setSimIntent] = useState("");
  const [newFlowName, setNewFlowName] = useState("");
  const nodeSeq = useRef(1);

  const loadFlows = useCallback(async () => {
    const data = await api<{ flows: OutreachFlow[] }>("/api/admin/outreach/flows");
    setFlows(data.flows);
    return data.flows;
  }, []);

  useEffect(() => {
    loadFlows().catch((e) => setMessage(String(e)));
  }, [loadFlows]);

  const openFlow = async (flow: OutreachFlow) => {
    setSelectedFlow(flow);
    setSimulation(null);
    const data = await api<{ versions: VersionRow[] }>(
      `/api/admin/outreach/flows?flowId=${flow.id}`,
    );
    setVersions(data.versions);
    const latest = data.versions[0];
    if (latest) {
      const rf = toReactFlow(latest.graph);
      setNodes(rf.nodes);
      setEdges(rf.edges);
    } else {
      setNodes([
        {
          id: "trigger",
          position: { x: 80, y: 40 },
          data: { label: "Enrolled", flowType: "trigger", config: {} },
          style: { border: `2px solid ${NODE_COLORS.trigger}`, borderRadius: 10, padding: 6 },
        },
      ]);
      setEdges([]);
    }
  };

  const addNode = (palette: (typeof NODE_PALETTE)[number]) => {
    let id: string;
    do {
      nodeSeq.current += 1;
      id = `${palette.type}_${nodeSeq.current}`;
    } while (nodes.some((n) => n.id === id));
    setNodes((current) => [
      ...current,
      {
        id,
        position: { x: 320, y: 60 + current.length * 40 },
        data: { label: palette.label, flowType: palette.type, config: { ...palette.config } },
        style: {
          border: `2px solid ${NODE_COLORS[palette.type] ?? "#999"}`,
          borderRadius: 10,
          padding: 6,
          fontSize: 12,
        },
      },
    ]);
  };

  const onConnect = useCallback(
    (connection: Connection) => {
      nodeSeq.current += 1;
      const id = `e_new_${nodeSeq.current}`;
      setEdges((current) =>
        addEdge({ ...connection, id }, current.filter((e) => e.id !== id)),
      );
    },
    [setEdges],
  );

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const updateSelectedNode = (patch: {
    label?: string;
    config?: Record<string, unknown>;
  }) => {
    if (!selectedNodeId) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId
          ? {
              ...node,
              data: {
                ...node.data,
                ...(patch.label !== undefined ? { label: patch.label } : {}),
                ...(patch.config !== undefined
                  ? { config: { ...(node.data as { config?: Record<string, unknown> }).config, ...patch.config } }
                  : {}),
              },
            }
          : node,
      ),
    );
  };

  const saveVersion = async () => {
    if (!selectedFlow) return;
    setMessage(null);
    try {
      const graph = fromReactFlow(nodes, edges);
      const result = await api<{ version?: { version: number }; problems?: string[] }>(
        "/api/admin/outreach/flows",
        {
          method: "POST",
          body: JSON.stringify({ action: "save_version", flowId: selectedFlow.id, graph }),
        },
      );
      setMessage(`Saved as v${result.version?.version} (versions are immutable — running enrollments stay pinned).`);
      await openFlow(selectedFlow);
    } catch (e) {
      setMessage(String(e));
    }
  };

  const simulate = async () => {
    setSimulating(true);
    setMessage(null);
    try {
      const graph = fromReactFlow(nodes, edges);
      const result = await api<{ steps: SimulationStep[]; problems?: string[] }>(
        "/api/admin/outreach/flows",
        {
          method: "POST",
          body: JSON.stringify({
            action: "simulate",
            graph,
            draft: simDraft,
            assumeIntent: simIntent || null,
          }),
        },
      );
      setSimulation(result.steps);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSimulating(false);
    }
  };

  const createFlow = async () => {
    const result = await api<{ flow: OutreachFlow }>("/api/admin/outreach/flows", {
      method: "POST",
      body: JSON.stringify({ action: "create", name: newFlowName }),
    });
    setNewFlowName("");
    await loadFlows();
    await openFlow(result.flow);
  };

  const config = (selectedNode?.data as { config?: Record<string, unknown> })?.config ?? {};
  const flowType = (selectedNode?.data as { flowType?: string })?.flowType;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Flow builder</h1>
          <p className="text-xs text-gray-500 max-w-2xl">
            Flows are the single source of truth for sequence logic; templates bind per Send
            node; cadence lives in Wait nodes. The global kill switch, daily caps, warm-up and
            suppressions stay OUTSIDE the flow as system-level overrides.
          </p>
        </div>
        <Link href="/admin/outreach" className={btn}>
          ← Outreach
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {flows.map((flow) => (
          <button
            key={flow.id}
            onClick={() => openFlow(flow)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
              selectedFlow?.id === flow.id
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 border-transparent"
                : "border-gray-300 dark:border-gray-700"
            }`}
          >
            {flow.name} {flow.isLocked && "🔒"}{" "}
            <Badge tone={statusTone(flow.status)}>{flow.status}</Badge>
          </button>
        ))}
        <div className="flex gap-1">
          <input
            className={input}
            placeholder="New flow name"
            value={newFlowName}
            onChange={(e) => setNewFlowName(e.target.value)}
          />
          <button className={btn} disabled={!newFlowName.trim()} onClick={createFlow}>
            Create
          </button>
        </div>
      </div>

      {selectedFlow && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs text-gray-500">Palette:</span>
            {NODE_PALETTE.map((palette) => (
              <button
                key={palette.label}
                className={btn}
                disabled={selectedFlow.isLocked}
                onClick={() => addNode(palette)}
              >
                + {palette.label}
              </button>
            ))}
            <span className="flex-1" />
            <button className={btnPrimary} disabled={selectedFlow.isLocked} onClick={saveVersion}>
              Save as new version
            </button>
            {selectedFlow.status !== "active" && (
              <button
                className={btn}
                onClick={async () => {
                  await api("/api/admin/outreach/flows", {
                    method: "POST",
                    body: JSON.stringify({ action: "activate", flowId: selectedFlow.id }),
                  });
                  await loadFlows();
                }}
              >
                Activate
              </button>
            )}
            <label className="text-xs flex items-center gap-1">
              <input
                type="checkbox"
                checked={simDraft}
                onChange={(e) => setSimDraft(e.target.checked)}
              />
              draft with LLM
            </label>
            <select className={input} style={{ width: "auto" }} value={simIntent} onChange={(e) => setSimIntent(e.target.value)}>
              <option value="">simulate: no reply</option>
              {["positive", "positive_link_request", "info_request", "negative", "opt_out", "ooo"].map((intent) => (
                <option key={intent} value={intent}>
                  simulate: {intent} reply
                </option>
              ))}
            </select>
            <button className={btn} disabled={simulating} onClick={simulate}>
              {simulating ? "Simulating…" : "▶ Simulate"}
            </button>
          </div>
          {selectedFlow.isLocked && (
            <p className="text-xs text-amber-600 mb-2">
              This is the locked phase-1 cadence — view + simulate only. Create a new flow to
              build variants.
            </p>
          )}
          {message && <p className="text-xs text-sky-700 mb-2">{message}</p>}

          <div className="grid lg:grid-cols-[1fr_320px] gap-4">
            <div
              className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden"
              style={{ height: 560 }}
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={selectedFlow.isLocked ? undefined : onNodesChange}
                onEdgesChange={selectedFlow.isLocked ? undefined : onEdgesChange}
                onConnect={selectedFlow.isLocked ? undefined : onConnect}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                fitView
              >
                <Background />
                <Controls />
              </ReactFlow>
            </div>

            <div className="space-y-4">
              <div className="border border-gray-200 dark:border-gray-800 rounded-xl p-4">
                <h3 className="text-sm font-semibold mb-2">Properties</h3>
                {!selectedNode ? (
                  <p className="text-xs text-gray-400">Click a node to edit it.</p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs">
                      <Badge tone="blue">{flowType}</Badge>{" "}
                      <span className="font-mono">{selectedNode.id}</span>
                    </p>
                    <div>
                      <label className={labelCls}>Label</label>
                      <input
                        className={input}
                        value={String((selectedNode.data as { label?: string }).label ?? "")}
                        disabled={selectedFlow.isLocked}
                        onChange={(e) => updateSelectedNode({ label: e.target.value })}
                      />
                    </div>
                    {flowType === "wait" && (
                      <div>
                        <label className={labelCls}>Days</label>
                        <input
                          className={input}
                          type="number"
                          value={Number(config.days ?? 0)}
                          disabled={selectedFlow.isLocked}
                          onChange={(e) => updateSelectedNode({ config: { days: Number(e.target.value) } })}
                        />
                      </div>
                    )}
                    {flowType === "send" && (
                      <>
                        <div>
                          <label className={labelCls}>Channel</label>
                          <select
                            className={input}
                            value={String(config.channel ?? "email")}
                            disabled={selectedFlow.isLocked}
                            onChange={(e) => updateSelectedNode({ config: { channel: e.target.value } })}
                          >
                            <option value="email">email</option>
                            <option value="imessage">imessage</option>
                          </select>
                        </div>
                        <div>
                          <label className={labelCls}>Step kind (template binding)</label>
                          <select
                            className={input}
                            value={String(config.stepKind ?? "intro")}
                            disabled={selectedFlow.isLocked}
                            onChange={(e) => updateSelectedNode({ config: { stepKind: e.target.value } })}
                          >
                            {["intro", "followup_1", "followup_2", "text_1", "text_2", "text_3"].map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </select>
                        </div>
                      </>
                    )}
                    {flowType === "condition" && (
                      <>
                        <div>
                          <label className={labelCls}>Condition kind</label>
                          <select
                            className={input}
                            value={String(config.kind ?? "no_reply_timeout")}
                            disabled={selectedFlow.isLocked}
                            onChange={(e) => updateSelectedNode({ config: { kind: e.target.value } })}
                          >
                            <option value="reply_intent">reply intent</option>
                            <option value="no_reply_timeout">no-reply timeout</option>
                            <option value="contact_property">contact property</option>
                          </select>
                        </div>
                        {String(config.kind) === "no_reply_timeout" && (
                          <div>
                            <label className={labelCls}>Timeout days</label>
                            <input
                              className={input}
                              type="number"
                              value={Number(config.timeoutDays ?? 3)}
                              disabled={selectedFlow.isLocked}
                              onChange={(e) =>
                                updateSelectedNode({ config: { timeoutDays: Number(e.target.value) } })
                              }
                            />
                          </div>
                        )}
                        <p className="text-[10px] text-gray-400">
                          Label outgoing edges with the branch (intent name / timeout / reply /
                          match / no_match / default).
                        </p>
                      </>
                    )}
                    {flowType === "split" && (
                      <div>
                        <label className={labelCls}>Branches (key=weight, comma-sep)</label>
                        <input
                          className={input}
                          defaultValue={((config.branches as Array<{ key: string; weight: number }>) ?? [])
                            .map((b) => `${b.key}=${b.weight}`)
                            .join(", ")}
                          disabled={selectedFlow.isLocked}
                          onBlur={(e) => {
                            const branches = e.target.value
                              .split(",")
                              .map((part) => part.trim().split("="))
                              .filter((pair) => pair[0])
                              .map(([key, weight]) => ({ key, weight: Number(weight ?? 50) }));
                            updateSelectedNode({ config: { branches } });
                          }}
                        />
                        <p className="text-[10px] text-gray-400 mt-1">
                          Label outgoing edges with the branch keys. Assignment is recorded per
                          enrollment for per-branch analytics.
                        </p>
                      </div>
                    )}
                    {flowType === "wait_manual" && (
                      <div>
                        <label className={labelCls}>Timeout days (falls through default edge)</label>
                        <input
                          className={input}
                          type="number"
                          value={Number(config.timeoutDays ?? 3)}
                          disabled={selectedFlow.isLocked}
                          onChange={(e) => updateSelectedNode({ config: { timeoutDays: Number(e.target.value) } })}
                        />
                      </div>
                    )}
                    {flowType === "action" && (
                      <div>
                        <label className={labelCls}>Action</label>
                        <select
                          className={input}
                          value={String(config.action ?? "note")}
                          disabled={selectedFlow.isLocked}
                          onChange={(e) => updateSelectedNode({ config: { action: e.target.value } })}
                        >
                          {["note", "suppress", "set_company_status", "notify"].map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {flowType === "outcome" && (
                      <div>
                        <label className={labelCls}>Outcome (conversion marker)</label>
                        <input
                          className={input}
                          value={String(config.outcome ?? "")}
                          disabled={selectedFlow.isLocked}
                          onChange={(e) => updateSelectedNode({ config: { outcome: e.target.value } })}
                        />
                      </div>
                    )}
                    {!selectedFlow.isLocked && flowType !== "trigger" && (
                      <button
                        className={btn}
                        onClick={() => {
                          setNodes((c) => c.filter((n) => n.id !== selectedNodeId));
                          setEdges((c) =>
                            c.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId),
                          );
                          setSelectedNodeId(null);
                        }}
                      >
                        Delete node
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="border border-gray-200 dark:border-gray-800 rounded-xl p-4">
                <h3 className="text-sm font-semibold mb-2">Versions</h3>
                {versions.length === 0 ? (
                  <p className="text-xs text-gray-400">No versions yet — save one.</p>
                ) : (
                  <div className="space-y-1">
                    {versions.map((version) => (
                      <p key={version.id} className="text-xs">
                        v{version.version} · {version.enrollments} enrollment(s) ·{" "}
                        {new Date(version.createdAt).toLocaleDateString()}
                      </p>
                    ))}
                    <p className="text-[10px] text-gray-400 mt-1">
                      Editing creates version N+1; running enrollments stay pinned to their
                      version. Force-migrate lives on the enrollment (only legal at equivalent
                      node positions).
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {simulation && (
            <div className="mt-4 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-2">
                Simulation — nothing was sent, no state was written
              </h3>
              <div className="space-y-2">
                {simulation.map((step, i) => (
                  <div key={i} className="text-xs border-l-2 pl-3" style={{ borderColor: NODE_COLORS[step.type] ?? "#999" }}>
                    <p>
                      <Badge tone="blue">{step.type}</Badge>{" "}
                      <span className="font-medium">{step.label ?? step.nodeId}</span> —{" "}
                      {step.detail}
                    </p>
                    {step.draftedSubject && (
                      <p className="font-medium mt-1">Subject: {step.draftedSubject}</p>
                    )}
                    {step.draftedBody && (
                      <pre className="whitespace-pre-wrap font-sans text-gray-600 dark:text-gray-400 mt-1 max-h-40 overflow-y-auto">
                        {step.draftedBody}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
