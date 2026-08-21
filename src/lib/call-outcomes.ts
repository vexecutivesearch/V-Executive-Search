import type { CallOutcomeKind, CallStatus } from "@/lib/db/schema";

/**
 * Call outcome vocabulary.
 *
 * This complements the existing callStatus workflow rather than replacing it:
 * callStatus is where a company sits in the funnel, and one row only ever
 * holds the latest value. call_outcomes is the append-only record of each
 * dial, which is what a connect rate has to be computed from.
 */

export const CALL_OUTCOMES: CallOutcomeKind[] = [
  "placed",
  "connected",
  "no_answer",
  "voicemail",
  "gatekeeper",
  "wrong_number",
];

export const CALL_OUTCOME_LABELS: Record<CallOutcomeKind, string> = {
  placed: "Placed — no result yet",
  connected: "Connected — spoke with them",
  no_answer: "No answer",
  voicemail: "Left voicemail",
  gatekeeper: "Gatekeeper — did not get through",
  wrong_number: "Wrong number",
};

export function isCallOutcomeKind(value: unknown): value is CallOutcomeKind {
  return (
    typeof value === "string" && (CALL_OUTCOMES as string[]).includes(value)
  );
}

/** Connect rate numerator: we actually spoke to the person we called. */
export function countsAsConnected(outcome: CallOutcomeKind): boolean {
  return outcome === "connected";
}

/** Someone picked up, even if it was not the decision maker. */
export function reachedAHuman(outcome: CallOutcomeKind): boolean {
  return outcome === "connected" || outcome === "gatekeeper";
}

/**
 * Funnel status an outcome implies, or null to leave the status alone.
 *
 * `gatekeeper` and `placed` map to null on purpose: callStatusEnum has no
 * honest value for either, and stamping "Called — No Answer" on a call that a
 * receptionist answered would misreport it. The attempt counter and the
 * outcome row carry those cases instead.
 */
export function callStatusForOutcome(
  outcome: CallOutcomeKind,
): CallStatus | null {
  switch (outcome) {
    case "connected":
      return "spoke_follow_up";
    case "no_answer":
      return "called_no_answer";
    case "voicemail":
      return "voicemail_left";
    case "wrong_number":
      return "bad_contact";
    case "placed":
    case "gatekeeper":
      return null;
  }
}

export function callOutcomeSummary(
  outcome: CallOutcomeKind,
  options?: { phone?: string | null; notes?: string | null },
): string {
  const parts = [`Call logged: ${CALL_OUTCOME_LABELS[outcome]}`];
  if (options?.phone) parts.push(`(${options.phone})`);
  const notes = options?.notes?.trim();
  if (notes) parts.push(`— ${notes}`);
  return parts.join(" ");
}

export type CallFunnel = {
  placed: number;
  connected: number;
  reachedHuman: number;
  gatekeeper: number;
  noAnswer: number;
  voicemail: number;
  wrongNumber: number;
  /** connected / placed, or null with no calls (never 0%, which would lie). */
  connectRate: number | null;
};

/** Every logged outcome is a dial that happened — that is the denominator. */
export function summarizeCallOutcomes(
  outcomes: Array<{ outcome: CallOutcomeKind }>,
): CallFunnel {
  const funnel: CallFunnel = {
    placed: 0,
    connected: 0,
    reachedHuman: 0,
    gatekeeper: 0,
    noAnswer: 0,
    voicemail: 0,
    wrongNumber: 0,
    connectRate: null,
  };

  for (const { outcome } of outcomes) {
    funnel.placed += 1;
    if (countsAsConnected(outcome)) funnel.connected += 1;
    if (reachedAHuman(outcome)) funnel.reachedHuman += 1;
    if (outcome === "gatekeeper") funnel.gatekeeper += 1;
    if (outcome === "no_answer") funnel.noAnswer += 1;
    if (outcome === "voicemail") funnel.voicemail += 1;
    if (outcome === "wrong_number") funnel.wrongNumber += 1;
  }

  funnel.connectRate =
    funnel.placed > 0 ? funnel.connected / funnel.placed : null;
  return funnel;
}
