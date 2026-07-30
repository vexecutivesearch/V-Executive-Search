import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  companyActivities,
  inboundMessages,
  outreachFlowVersions,
  outreachMessages,
  sequenceEnrollments,
  type EnrollmentNodeState,
  type OutreachTemplateKind,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import type {
  ActionNodeConfig,
  ConditionNodeConfig,
  FlowGraph,
  FlowNode,
  SendNodeConfig,
  SplitNodeConfig,
  WaitManualNodeConfig,
  WaitNodeConfig,
} from "@/lib/outreach/flow-types";
import { nextNodeId, nodeById, triggerNode } from "@/lib/outreach/flow-types";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { addSuppression } from "@/lib/outreach/suppression";
import { addBusinessDays, scheduleSendAt } from "@/lib/outreach/timezone-infer";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";

/**
 * Flow execution engine — a graph walk over immutable flow versions.
 * All state lives in Postgres (enrollment.current_node_id + node_state), so
 * a crash or redeploy mid-walk resumes exactly where it left off.
 *
 * Condition nodes consume intents already computed asynchronously by the
 * reply pipeline — no LLM call ever happens inside the graph walk.
 */

const MAX_TRANSITIONS_PER_PASS = 25;
const MAX_NODE_RETRIES = 3;

export type AdvanceResult = {
  enrollmentId: string;
  transitions: number;
  haltedAt: string | null;
  completed: boolean;
};

const flowGraphCache = new Map<string, FlowGraph>();

export async function loadFlowGraph(versionId: string): Promise<FlowGraph | null> {
  const cached = flowGraphCache.get(versionId);
  if (cached) return cached;
  const [row] = await db
    .select()
    .from(outreachFlowVersions)
    .where(eq(outreachFlowVersions.id, versionId))
    .limit(1);
  if (!row) return null;
  flowGraphCache.set(versionId, row.graph);
  return row.graph;
}

async function saveState(
  enrollment: SequenceEnrollment,
  patch: Partial<{
    currentNodeId: string | null;
    nodeState: EnrollmentNodeState;
    nextStepAt: Date | null;
    status: SequenceEnrollment["status"];
    stopReason: string | null;
    stoppedBy: string | null;
  }>,
): Promise<void> {
  await db
    .update(sequenceEnrollments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sequenceEnrollments.id, enrollment.id));
  Object.assign(enrollment, patch);
}

async function transitionTo(
  enrollment: SequenceEnrollment,
  from: string | null,
  to: string | null,
  extra?: Record<string, unknown>,
): Promise<void> {
  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "node_transition",
    payload: { from, to, ...extra },
  });
}

async function completeEnrollment(
  enrollment: SequenceEnrollment,
  reason: string,
): Promise<void> {
  await saveState(enrollment, {
    status: "completed",
    stopReason: reason,
    nextStepAt: null,
  });
  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "cancelled",
    actor: "system",
    payload: { completed: true, reason },
  });
}

async function pauseWithError(
  enrollment: SequenceEnrollment,
  nodeId: string,
  error: string,
): Promise<void> {
  await saveState(enrollment, { status: "paused", stopReason: error });
  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "error",
    payload: { node: nodeId, error, action: "paused for admin review" },
  });
}

/** Latest classified inbound intent for the enrollment (or null). */
async function latestIntent(enrollmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ intent: inboundMessages.classifiedIntent })
    .from(inboundMessages)
    .where(eq(inboundMessages.enrollmentId, enrollmentId))
    .orderBy(desc(inboundMessages.receivedAt))
    .limit(1);
  return row?.intent ?? null;
}

async function lastSentAt(enrollmentId: string): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: outreachMessages.sentAt })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollmentId),
        eq(outreachMessages.status, "sent"),
      ),
    )
    .orderBy(desc(outreachMessages.sentAt))
    .limit(1);
  return row?.sentAt ?? null;
}

/** Handle a send node: schedule the pre-drafted message, or draft at node
 * entry (flow-built sends), or skip channel-ineligible steps. Returns:
 * "waiting" (message scheduled/queued), "advance", or "halt". */
async function handleSendNode(
  enrollment: SequenceEnrollment,
  node: FlowNode,
  now: Date,
): Promise<"waiting" | "advance" | "halt"> {
  const config = (node.config ?? {}) as SendNodeConfig;
  const settings = await getOrCreateOutreachSettings();

  if (config.channel === "imessage" && !enrollment.phoneNumber) {
    // Text steps are skipped for contacts without a verified iMessage number.
    const [existing] = await db
      .select()
      .from(outreachMessages)
      .where(
        and(
          eq(outreachMessages.enrollmentId, enrollment.id),
          eq(outreachMessages.stepKind, config.stepKind),
          inArray(outreachMessages.status, ["drafted", "queued"]),
        ),
      )
      .limit(1);
    if (existing) {
      await db
        .update(outreachMessages)
        .set({ status: "skipped", updatedAt: now })
        .where(eq(outreachMessages.id, existing.id));
    }
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "rule_action",
      payload: { node: node.id, action: "skip_text_step", reason: "no verified iMessage number" },
    });
    return "advance";
  }

  const [message] = await db
    .select()
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollment.id),
        eq(outreachMessages.stepKind, config.stepKind as OutreachTemplateKind),
      ),
    )
    .orderBy(desc(outreachMessages.createdAt))
    .limit(1);

  if (message?.status === "sent" || message?.status === "skipped" || message?.status === "cancelled") {
    return "advance";
  }
  if (message?.status === "failed") {
    await pauseWithError(enrollment, node.id, `step ${config.stepKind} failed permanently`);
    return "halt";
  }

  if (message && message.status === "queued") {
    // Already scheduled — wait for dispatch to send it.
    await saveState(enrollment, { nextStepAt: message.scheduledFor ?? now });
    return "waiting";
  }

  if (message && message.status === "drafted") {
    const scheduledFor = scheduleSendAt({
      base: now,
      offsetDays: 0,
      timeZone: enrollment.timezone,
      windowStartHour: settings.sendWindowStartHour,
      windowEndHour: settings.sendWindowEndHour,
    });
    await db
      .update(outreachMessages)
      .set({ status: "queued", scheduledFor, nodeId: node.id, updatedAt: now })
      .where(eq(outreachMessages.id, message.id));
    await saveState(enrollment, { nextStepAt: scheduledFor });
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "rule_action",
      payload: {
        node: node.id,
        action: "queued",
        step: config.stepKind,
        scheduled_for: scheduledFor.toISOString(),
      },
    });
    return "waiting";
  }

  // No pre-drafted message (flow-built send): draft at node entry.
  const state = { ...(enrollment.nodeState ?? {}) } as EnrollmentNodeState;
  const retries = Number(state.retry_count ?? 0);
  try {
    const { draftStepForEnrollment } = await import("@/lib/outreach/node-draft");
    const drafted = await draftStepForEnrollment(enrollment, config);
    if (!drafted) throw new Error("draft failed sanitization");
    const scheduledFor = scheduleSendAt({
      base: now,
      offsetDays: 0,
      timeZone: enrollment.timezone,
      windowStartHour: settings.sendWindowStartHour,
      windowEndHour: settings.sendWindowEndHour,
    });
    await db.insert(outreachMessages).values({
      enrollmentId: enrollment.id,
      stepKind: config.stepKind as OutreachTemplateKind,
      channel: config.channel,
      status: "queued",
      scheduledFor,
      nodeId: node.id,
      subject: drafted.subject,
      body: drafted.body,
      templateId: config.templateId ?? drafted.templateId,
    });
    state.retry_count = 0;
    await saveState(enrollment, { nodeState: state, nextStepAt: scheduledFor });
    return "waiting";
  } catch (error) {
    const nextRetries = retries + 1;
    if (nextRetries >= MAX_NODE_RETRIES) {
      await pauseWithError(
        enrollment,
        node.id,
        `draft failed ${nextRetries}x: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return "halt";
    }
    // Retry with backoff (next cron windows).
    state.retry_count = nextRetries;
    const backoffMinutes = 15 * 2 ** (nextRetries - 1);
    await saveState(enrollment, {
      nodeState: state,
      nextStepAt: new Date(now.getTime() + backoffMinutes * 60_000),
    });
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "retry",
      payload: { node: node.id, attempt: nextRetries, backoff_minutes: backoffMinutes },
    });
    return "halt";
  }
}

async function handleActionNode(
  enrollment: SequenceEnrollment,
  node: FlowNode,
): Promise<void> {
  const config = (node.config ?? {}) as ActionNodeConfig;
  const params = config.params ?? {};

  if (config.action === "suppress") {
    await addSuppression({
      email: enrollment.emailAddress,
      phone: enrollment.phoneNumber,
      channel: (String(params.channel ?? "all") as "email" | "imessage" | "all"),
      reason: String(params.reason ?? `flow action (${node.id})`),
      contactId: enrollment.contactId,
    });
  } else if (config.action === "set_company_status") {
    const status = String(params.status ?? "contacted");
    if (["new", "contacted", "meeting", "client", "skipped"].includes(status)) {
      await db
        .update(companies)
        .set({ status: status as "new" | "contacted" | "meeting" | "client" | "skipped", updatedAt: new Date() })
        .where(eq(companies.id, enrollment.companyId));
    }
  } else if (config.action === "note") {
    await db.insert(companyActivities).values({
      companyId: enrollment.companyId,
      contactId: enrollment.contactId,
      type: "note",
      summary: String(params.summary ?? `Outreach flow note (${node.id})`),
      source: "outreach",
    });
  } else if (config.action === "notify") {
    const { notifyReply } = await import("@/lib/outreach/notifications");
    await notifyReply({
      intent: String(params.intent ?? "flow_notify"),
      contactId: enrollment.contactId,
      companyId: enrollment.companyId,
      snippet: String(params.message ?? `Flow ${node.id} checkpoint reached`),
      notifyEmail: null,
    });
  }

  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "rule_action",
    payload: { node: node.id, action: config.action, params },
  });
}

/**
 * Advance one enrollment through its flow graph as far as it can go in this
 * pass. Every transition and retry writes to enrollment_events.
 */
export async function advanceEnrollment(
  enrollment: SequenceEnrollment,
  now = new Date(),
  random: () => number = Math.random,
): Promise<AdvanceResult> {
  const result: AdvanceResult = {
    enrollmentId: enrollment.id,
    transitions: 0,
    haltedAt: null,
    completed: false,
  };

  if (!enrollment.flowVersionId) return result;
  const graph = await loadFlowGraph(enrollment.flowVersionId);
  if (!graph) {
    await pauseWithError(enrollment, "?", "flow version not found");
    return result;
  }

  // Manual-wait timeout: fall through the timeout/default edge.
  if (enrollment.status === "waiting_on_manual") {
    const deadline = enrollment.nodeState?.manual_deadline;
    if (!deadline || new Date(String(deadline)) > now) return result;
    const to = enrollment.currentNodeId
      ? nextNodeId(graph, enrollment.currentNodeId, "timeout")
      : null;
    await saveState(enrollment, {
      status: "active",
      currentNodeId: to,
      nodeState: { ...(enrollment.nodeState ?? {}), manual_deadline: undefined },
    });
    await transitionTo(enrollment, enrollment.currentNodeId, to, { via: "manual_timeout" });
    if (!to) {
      await completeEnrollment(enrollment, "flow completed (manual wait timeout, no edge)");
      result.completed = true;
      return result;
    }
  }

  if (enrollment.status !== "active") return result;
  if (enrollment.nextStepAt && enrollment.nextStepAt > now) return result;

  for (let i = 0; i < MAX_TRANSITIONS_PER_PASS; i += 1) {
    let node: FlowNode | null;
    if (!enrollment.currentNodeId) {
      node = triggerNode(graph);
      if (!node) {
        await pauseWithError(enrollment, "?", "flow has no trigger node");
        result.haltedAt = "no_trigger";
        return result;
      }
      await saveState(enrollment, { currentNodeId: node.id });
    } else {
      node = nodeById(graph, enrollment.currentNodeId);
      if (!node) {
        await pauseWithError(enrollment, enrollment.currentNodeId, "current node missing from graph");
        result.haltedAt = "missing_node";
        return result;
      }
    }

    const state = { ...(enrollment.nodeState ?? {}) } as EnrollmentNodeState;

    if (node.type === "trigger") {
      // Enrollment stagger (intro delay for 2nd/3rd contact) uses wait_until.
      if (state.wait_until && new Date(String(state.wait_until)) > now) {
        await saveState(enrollment, { nextStepAt: new Date(String(state.wait_until)) });
        result.haltedAt = node.id;
        return result;
      }
      const to = nextNodeId(graph, node.id);
      await saveState(enrollment, {
        currentNodeId: to,
        nodeState: { ...state, wait_until: undefined },
      });
      await transitionTo(enrollment, node.id, to);
      result.transitions += 1;
      if (!to) break;
      continue;
    }

    if (node.type === "wait") {
      const config = (node.config ?? {}) as WaitNodeConfig;
      if (!state.wait_until) {
        const businessDays = config.businessDays !== false;
        let deadline: Date;
        if (config.days && businessDays) {
          deadline = addBusinessDays(now, config.days, enrollment.timezone);
        } else {
          deadline = new Date(
            now.getTime() + (config.days ?? 0) * 86_400_000 + (config.hours ?? 0) * 3_600_000,
          );
        }
        state.wait_until = deadline.toISOString();
        await saveState(enrollment, { nodeState: state, nextStepAt: deadline });
        result.haltedAt = node.id;
        return result;
      }
      if (new Date(String(state.wait_until)) > now) {
        await saveState(enrollment, { nextStepAt: new Date(String(state.wait_until)) });
        result.haltedAt = node.id;
        return result;
      }
      const to = nextNodeId(graph, node.id);
      await saveState(enrollment, {
        currentNodeId: to,
        nodeState: { ...state, wait_until: undefined },
      });
      await transitionTo(enrollment, node.id, to);
      result.transitions += 1;
      if (!to) break;
      continue;
    }

    if (node.type === "send") {
      const outcome = await handleSendNode(enrollment, node, now);
      if (outcome === "waiting" || outcome === "halt") {
        result.haltedAt = node.id;
        return result;
      }
      const to = nextNodeId(graph, node.id);
      await saveState(enrollment, { currentNodeId: to });
      await transitionTo(enrollment, node.id, to);
      result.transitions += 1;
      if (!to) break;
      continue;
    }

    if (node.type === "condition") {
      const config = (node.config ?? {}) as ConditionNodeConfig;
      let label: string | undefined;

      if (config.kind === "reply_intent") {
        const intent = await latestIntent(enrollment.id);
        label = intent ?? "no_reply";
      } else if (config.kind === "no_reply_timeout") {
        const intent = await latestIntent(enrollment.id);
        if (intent) {
          label = "reply";
        } else {
          const sentAt = (await lastSentAt(enrollment.id)) ?? enrollment.enrolledAt;
          const deadline = new Date(
            sentAt.getTime() + (config.timeoutDays ?? 3) * 86_400_000,
          );
          if (deadline > now) {
            await saveState(enrollment, { nextStepAt: deadline });
            result.haltedAt = node.id;
            return result;
          }
          label = "timeout";
        }
      } else {
        // contact_property — evaluated against company ICP score or title.
        const { evaluateContactProperty } = await import("@/lib/outreach/node-draft");
        const matched = await evaluateContactProperty(enrollment, config);
        label = matched ? "match" : "no_match";
      }

      const to = nextNodeId(graph, node.id, label);
      await saveState(enrollment, { currentNodeId: to });
      await transitionTo(enrollment, node.id, to, { condition: config.kind, label });
      result.transitions += 1;
      if (!to) break;
      continue;
    }

    if (node.type === "split") {
      const config = (node.config ?? {}) as SplitNodeConfig;
      const assignments = { ...(state.split_assignments ?? {}) };
      let key = assignments[node.id];
      if (!key) {
        const total = config.branches.reduce((sum, b) => sum + b.weight, 0);
        let roll = random() * total;
        key = config.branches[config.branches.length - 1].key;
        for (const branch of config.branches) {
          roll -= branch.weight;
          if (roll <= 0) {
            key = branch.key;
            break;
          }
        }
        assignments[node.id] = key;
      }
      const to = nextNodeId(graph, node.id, key);
      await saveState(enrollment, {
        currentNodeId: to,
        nodeState: { ...state, split_assignments: assignments },
      });
      await transitionTo(enrollment, node.id, to, { split: node.id, branch: key });
      result.transitions += 1;
      if (!to) break;
      continue;
    }

    if (node.type === "wait_manual") {
      const config = (node.config ?? {}) as WaitManualNodeConfig;
      const deadline = new Date(now.getTime() + (config.timeoutDays ?? 3) * 86_400_000);
      await saveState(enrollment, {
        status: "waiting_on_manual",
        nodeState: { ...state, manual_deadline: deadline.toISOString() },
        nextStepAt: deadline,
      });
      const { notifyReply } = await import("@/lib/outreach/notifications");
      await notifyReply({
        intent: "waiting_on_manual",
        contactId: enrollment.contactId,
        companyId: enrollment.companyId,
        snippet: config.note ?? `Flow paused at ${node.label ?? node.id} — action needed`,
        notifyEmail: null,
      });
      result.haltedAt = node.id;
      return result;
    }

    if (node.type === "action") {
      await handleActionNode(enrollment, node);
      const to = nextNodeId(graph, node.id);
      await saveState(enrollment, { currentNodeId: to });
      await transitionTo(enrollment, node.id, to);
      result.transitions += 1;
      if (!to) break;
      continue;
    }

    if (node.type === "outcome") {
      const outcome = String((node.config as { outcome?: string })?.outcome ?? "outcome");
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "outcome",
        payload: {
          outcome,
          node: node.id,
          flow_version_id: enrollment.flowVersionId,
          split_assignments: state.split_assignments ?? {},
        },
      });
      break;
    }

    break;
  }

  await completeEnrollment(enrollment, "flow completed");
  result.completed = true;
  return result;
}

/** Resume a waiting_on_manual enrollment down a chosen edge (admin action). */
export async function resolveManualWait(
  enrollmentId: string,
  edgeLabel: "done" | "timeout",
  actor: string,
): Promise<boolean> {
  const [enrollment] = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, enrollmentId))
    .limit(1);
  if (!enrollment || enrollment.status !== "waiting_on_manual") return false;
  if (!enrollment.flowVersionId || !enrollment.currentNodeId) return false;
  const graph = await loadFlowGraph(enrollment.flowVersionId);
  if (!graph) return false;

  const to = nextNodeId(graph, enrollment.currentNodeId, edgeLabel);
  await db
    .update(sequenceEnrollments)
    .set({
      status: "active",
      currentNodeId: to,
      nodeState: { ...(enrollment.nodeState ?? {}), manual_deadline: undefined },
      nextStepAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sequenceEnrollments.id, enrollmentId));
  await logEnrollmentEvent({
    enrollmentId,
    eventType: "manual_intervention",
    actor,
    payload: { from: enrollment.currentNodeId, to, edge: edgeLabel },
  });
  return true;
}

/**
 * Force-migrate enrollments to a new flow version. Only legal when the
 * current node id exists at an equivalent position in the target version;
 * otherwise callers should migrate-at-next-wait.
 */
export async function migrateEnrollmentVersion(
  enrollmentId: string,
  targetVersionId: string,
  actor: string,
): Promise<{ ok: boolean; error?: string }> {
  const [enrollment] = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, enrollmentId))
    .limit(1);
  if (!enrollment) return { ok: false, error: "enrollment not found" };

  const target = await loadFlowGraph(targetVersionId);
  if (!target) return { ok: false, error: "target version not found" };

  if (enrollment.currentNodeId && !nodeById(target, enrollment.currentNodeId)) {
    return {
      ok: false,
      error: `node ${enrollment.currentNodeId} does not exist in the target version — migrate at next wait instead`,
    };
  }

  await db
    .update(sequenceEnrollments)
    .set({ flowVersionId: targetVersionId, updatedAt: new Date() })
    .where(eq(sequenceEnrollments.id, enrollmentId));
  await logEnrollmentEvent({
    enrollmentId,
    eventType: "migrated_version",
    actor,
    payload: { from: enrollment.flowVersionId, to: targetVersionId },
  });
  return { ok: true };
}
