import type { ActivityType, CallStatus } from "@/lib/db/schema";

/** Workflow order — mirrors the recruiter's outreach funnel. */
export const CALL_STATUSES: CallStatus[] = [
  "new",
  "ready_to_call",
  "called_no_answer",
  "voicemail_left",
  "spoke_follow_up",
  "email_sent",
  "replied_interested",
  "meeting_scheduled",
  "proposal_sent",
  "client_won",
  "not_interested",
  "bad_contact",
  "do_not_contact",
];

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  new: "New",
  ready_to_call: "Ready to Call",
  called_no_answer: "Called — No Answer",
  voicemail_left: "Voicemail Left",
  spoke_follow_up: "Spoke — Follow-Up Needed",
  email_sent: "Email Sent",
  replied_interested: "Replied — Interested",
  meeting_scheduled: "Call Booked",
  proposal_sent: "Proposal Sent",
  client_won: "Client Won",
  not_interested: "Not Interested",
  bad_contact: "Bad Contact",
  do_not_contact: "Do Not Contact",
};

export const CALL_STATUS_COLORS: Record<CallStatus, string> = {
  new: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  ready_to_call:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
  called_no_answer:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  voicemail_left:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  spoke_follow_up:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  email_sent:
    "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  replied_interested:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  meeting_scheduled:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  proposal_sent:
    "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200",
  client_won:
    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  not_interested:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  bad_contact:
    "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  do_not_contact:
    "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
};

/**
 * Outreach-attempt statuses: selecting one auto-increments the attempt
 * counter and stamps the last-contact date.
 */
export const ATTEMPT_STATUSES: ReadonlySet<CallStatus> = new Set([
  "called_no_answer",
  "voicemail_left",
  "spoke_follow_up",
  "email_sent",
]);

/** Terminal statuses collapse into the Closed section and end the workflow. */
export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  "client_won",
  "not_interested",
  "bad_contact",
  "do_not_contact",
]);

/**
 * Funnel progression rank for AUTOMATED status writes: outreach-driven events
 * may only move a row forward (or to a terminal status). This is what stops a
 * later courtesy reply ("mark not as junk please") from silently demoting a
 * genuinely booked call back to Spoke — Follow-Up. Manual edits in the UI go
 * through a different path and can set anything.
 */
const AUTO_STATUS_RANK: Record<CallStatus, number> = {
  new: 0,
  ready_to_call: 1,
  called_no_answer: 2,
  voicemail_left: 2,
  email_sent: 3,
  spoke_follow_up: 4,
  replied_interested: 5,
  meeting_scheduled: 6,
  proposal_sent: 7,
  client_won: 8,
  not_interested: 8,
  bad_contact: 8,
  do_not_contact: 8,
};

/** True when an automated event may move a row from `current` to `next`. */
export function canAutoAdvanceStatus(
  current: CallStatus,
  next: CallStatus,
): boolean {
  if (next === current) return false;
  if (TERMINAL_STATUSES.has(current)) return false;
  if (TERMINAL_STATUSES.has(next)) return true;
  return AUTO_STATUS_RANK[next] > AUTO_STATUS_RANK[current];
}

export function isCallStatus(value: unknown): value is CallStatus {
  return typeof value === "string" && (CALL_STATUSES as string[]).includes(value);
}

export function isTerminalStatus(status: CallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isAttemptStatus(status: CallStatus): boolean {
  return ATTEMPT_STATUSES.has(status);
}

/** Activity-log type for a status change (history stays on company_activities). */
export function activityTypeForStatus(status: CallStatus): ActivityType {
  if (status === "email_sent") return "email";
  if (status === "meeting_scheduled") return "meeting";
  if (
    status === "called_no_answer" ||
    status === "voicemail_left" ||
    status === "spoke_follow_up"
  ) {
    return "call";
  }
  return "note";
}
