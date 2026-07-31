/**
 * Enrollment statuses the Mac worker is allowed to claim queued texts for.
 *
 * Shared so that anything queueing a text can check up front whether the
 * worker will ever come for it. A message queued against a status outside
 * this set sits in the table forever with nobody looking at it.
 */
export const WORKER_CLAIMABLE_ENROLLMENT_STATUSES = [
  "active",
  "replied_positive",
  "waiting_on_manual",
  "replied_negative",
] as const;

export type WorkerClaimableStatus =
  (typeof WORKER_CLAIMABLE_ENROLLMENT_STATUSES)[number];

export function workerCanClaim(status: string): boolean {
  return (WORKER_CLAIMABLE_ENROLLMENT_STATUSES as readonly string[]).includes(
    status,
  );
}
