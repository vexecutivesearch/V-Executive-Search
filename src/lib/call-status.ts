import type { ActivityType, CallStatus } from "@/lib/db/schema";

/** Workflow order — mirrors the recruiter's outreach funnel. */
export const CALL_STATUSES: CallStatus[] = [
  "new",
  "ready_to_call",
  "called_no_answer",
  "voicemail_left",
  "spoke_follow_up",
  "email_sent",
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
  meeting_scheduled: "Meeting Scheduled",
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
