import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";
import { draftStep, type DraftContext } from "@/lib/outreach-draft";
import type {
  ConditionNodeConfig,
  FlowGraph,
  SendNodeConfig,
  SplitNodeConfig,
  WaitNodeConfig,
} from "@/lib/outreach/flow-types";
import { nextNodeId, nodeById, triggerNode } from "@/lib/outreach/flow-types";
import { contextForEnrollment } from "@/lib/outreach/node-draft";

/**
 * Simulation mode: run a synthetic (or real) contact through a flow graph
 * WITHOUT sending or persisting anything. Every node reports its would-be
 * output — drafted text (real LLM draft when a contact is supplied and
 * drafting is requested), wait durations, branch taken.
 */

export type SimulationStep = {
  nodeId: string;
  type: string;
  label?: string;
  detail: string;
  draftedSubject?: string | null;
  draftedBody?: string | null;
};

const SYNTHETIC_CONTEXT: DraftContext = {
  contactName: "Jordan Reeves",
  contactTitle: "Director of Talent Acquisition",
  companyName: "Acme Robotics",
  industry: "Advanced Manufacturing",
  estimatedEmployees: 180,
  jobTitles: ["Senior Controls Engineer", "Plant Operations Manager"],
  jobDetails: [
    "Senior Controls Engineer, location: Charlotte, NC, comp: $140k to $170k",
    "Plant Operations Manager, location: Charlotte, NC",
  ],
  jobLocation: "Charlotte, NC",
  hiringSignals: ["multiple openings", "reposted role"],
  reasonToCall: "Two engineering roles reposted this month",
  market: "Charlotte, NC",
  senderName: process.env.OUTREACH_SENDER_NAME ?? "Alejandro O Delgado",
  senderFirm: process.env.OUTREACH_SENDER_FIRM ?? "Villatoro Executive Search",
};

export async function simulateFlow(options: {
  graph: FlowGraph;
  contactId?: string | null;
  /** Actually call the LLM for send nodes (slower, costs tokens). */
  draft?: boolean;
  /** Intent to assume at reply-condition nodes. */
  assumeIntent?: string | null;
  random?: () => number;
}): Promise<{ steps: SimulationStep[]; completed: boolean; error?: string }> {
  const { graph } = options;
  const random = options.random ?? Math.random;
  const steps: SimulationStep[] = [];

  let context = SYNTHETIC_CONTEXT;
  if (options.contactId) {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, options.contactId))
      .limit(1);
    if (contact) {
      const fake = {
        contactId: contact.id,
        companyId: contact.companyId,
      } as Parameters<typeof contextForEnrollment>[0];
      const real = await contextForEnrollment(fake);
      if (real) context = real;
    }
  }

  let node = triggerNode(graph);
  if (!node) return { steps, completed: false, error: "no trigger node" };
  let simulatedDay = 0;

  for (let i = 0; i < 40 && node; i += 1) {
    if (node.type === "trigger") {
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Day ${simulatedDay}: contact enrolled (${context.contactName} @ ${context.companyName})`,
      });
    } else if (node.type === "wait") {
      const config = (node.config ?? {}) as WaitNodeConfig;
      const days = config.days ?? 0;
      simulatedDay += days;
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Wait ${days ? `${days} day(s)` : `${config.hours ?? 0}h`}${
          config.businessDays !== false ? " (business days)" : ""
        } → now day ${simulatedDay}`,
      });
    } else if (node.type === "send") {
      const config = (node.config ?? {}) as SendNodeConfig;
      let subject: string | null = null;
      let body: string | null = null;
      if (options.draft) {
        const drafted = await draftStep({
          spec: { stepKind: config.stepKind, channel: config.channel },
          context,
          priorSteps: [],
        });
        subject = drafted?.subject ?? null;
        body = drafted?.body ?? "(draft failed sanitization — would retry, then pause)";
      }
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Day ${simulatedDay}: send ${config.stepKind} via ${config.channel} (in contact-local business window, jittered)`,
        draftedSubject: subject,
        draftedBody: body,
      });
    } else if (node.type === "condition") {
      const config = (node.config ?? {}) as ConditionNodeConfig;
      const label =
        config.kind === "reply_intent"
          ? options.assumeIntent ?? "no_reply"
          : config.kind === "no_reply_timeout"
            ? options.assumeIntent
              ? "reply"
              : "timeout"
            : "match";
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Condition (${config.kind}) → branch "${label}"`,
      });
      const to = nextNodeId(graph, node.id, label);
      node = to ? nodeById(graph, to) : null;
      continue;
    } else if (node.type === "split") {
      const config = (node.config ?? {}) as SplitNodeConfig;
      const total = config.branches.reduce((s, b) => s + b.weight, 0);
      let roll = random() * total;
      let key = config.branches[config.branches.length - 1].key;
      for (const branch of config.branches) {
        roll -= branch.weight;
        if (roll <= 0) {
          key = branch.key;
          break;
        }
      }
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Random split → branch "${key}" (weights: ${config.branches
          .map((b) => `${b.key}=${b.weight}`)
          .join(", ")})`,
      });
      const to = nextNodeId(graph, node.id, key);
      node = to ? nodeById(graph, to) : null;
      continue;
    } else if (node.type === "wait_manual") {
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Pause as waiting_on_manual — alert with reply / send availability / close actions; timeout falls through the default edge`,
      });
    } else if (node.type === "action") {
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Action: ${JSON.stringify(node.config ?? {})}`,
      });
    } else if (node.type === "outcome") {
      steps.push({
        nodeId: node.id,
        type: node.type,
        label: node.label,
        detail: `Outcome recorded: ${JSON.stringify(node.config ?? {})} (feeds ROI analytics)`,
      });
      return { steps, completed: true };
    }

    const to = nextNodeId(graph, node.id);
    node = to ? nodeById(graph, to) : null;
  }

  return { steps, completed: true };
}
