import type { OutreachSettings } from "@/lib/db/schema";

/**
 * Testing-window override.
 *
 * The contact-local send window is a production safety control: it is why a
 * real prospect never gets a text at 11 PM. Testing sessions kept needing a
 * later window, and the only lever was widening the production hours — which
 * ratcheted the real window from 17 to 22 in a single evening and never got
 * put back. This override separates the two: production hours stay sane, and
 * a testing session gets a temporary, self-expiring widening instead.
 *
 * The override ALWAYS expires. There is no "on" state without an expiry, so
 * it cannot be left on by forgetting about it.
 */

/** Longest a single override can run. Renew rather than raising this. */
export const TESTING_WINDOW_MAX_HOURS = 12;

/** Offered as the default duration in the admin UI. */
export const TESTING_WINDOW_DEFAULT_HOURS = 3;

/**
 * Latest contact-local end hour the Vercel cron can still dispatch for the
 * slowest US zone (Pacific in standard time), given the late dispatch cron
 * running every 15 minutes across 00:00–06:59 UTC. An override past this
 * still works for day-0 sends, which dispatch inline at enroll time, but
 * later flow steps scheduled beyond it wait for the next cron day.
 * See DEPLOY.md.
 */
export const CRON_COVERED_END_HOUR = 22;

export type SendWindowSettings = Pick<
  OutreachSettings,
  | "sendWindowStartHour"
  | "sendWindowEndHour"
  | "testingWindowUntil"
  | "testingWindowStartHour"
  | "testingWindowEndHour"
>;

export type ResolvedSendWindow = {
  startHour: number;
  endHour: number;
  /** True while a testing override is in force. */
  testingOverrideActive: boolean;
  /** When the override lapses back to production hours (null when inactive). */
  overrideExpiresAt: Date | null;
};

/**
 * The send window to actually use right now. Production hours unless a
 * testing override is set AND has not expired.
 */
export function resolveSendWindow(
  settings: SendWindowSettings,
  now: Date = new Date(),
): ResolvedSendWindow {
  const startHour = settings.sendWindowStartHour;
  const endHour = settings.sendWindowEndHour;
  const until = settings.testingWindowUntil;

  // Expiry is the only thing that keeps this from becoming a permanent
  // widening, so an elapsed override is indistinguishable from no override.
  if (!until || until.getTime() <= now.getTime()) {
    return { startHour, endHour, testingOverrideActive: false, overrideExpiresAt: null };
  }

  return {
    startHour: settings.testingWindowStartHour ?? startHour,
    endHour: settings.testingWindowEndHour ?? endHour,
    testingOverrideActive: true,
    overrideExpiresAt: until,
  };
}

/** Expiry instant for a requested duration, clamped to the maximum. */
export function testingWindowExpiry(hours: number, now: Date = new Date()): Date {
  const safe = Number.isFinite(hours) ? hours : 0;
  const clamped = Math.min(Math.max(safe, 0), TESTING_WINDOW_MAX_HOURS);
  return new Date(now.getTime() + clamped * 3_600_000);
}

/** Hour-of-day bounds check for override values coming off the wire. */
export function isValidWindowHour(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 24;
}

/** Whole minutes until the override lapses (0 when inactive or elapsed). */
export function minutesUntilOverrideExpiry(
  window: ResolvedSendWindow,
  now: Date = new Date(),
): number {
  if (!window.overrideExpiresAt) return 0;
  const ms = window.overrideExpiresAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 60_000);
}
