import type { HiringSignalKey, HiringSignals } from "@/lib/db/schema";
import type { JobListing } from "@/lib/db/schema";
import { jobLocationInFocus } from "@/lib/geo-focus";
import type { pipelineSettings } from "@/lib/db/schema";
import { businessListDate } from "@/lib/timezone";

const REPOST_WINDOW_DAYS = 21;
const REPOST_MIN_SIGHTINGS = 3;
const LONG_RUNNING_DAYS = 21;

export function jobUrlFingerprint(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function titleFingerprint(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function daysSince(date: Date | null | undefined): number | null {
  if (!date) return null;
  const ms = Date.now() - date.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function detectHiringSignals(
  listings: JobListing[],
  geoSettings: typeof pipelineSettings.$inferSelect,
  companyFirstSeen?: string | null,
): HiringSignals {
  const inFocus = listings.filter((l) =>
    jobLocationInFocus(l.location, geoSettings),
  );
  const signals: HiringSignals = {};

  if (inFocus.length >= 2) {
    signals.multiple_openings = inFocus.length;
  }

  const maxSightings = Math.max(
    ...inFocus.map((l) => l.sightingsCount ?? 1),
    0,
  );
  const recentRepost = inFocus.some((l) => {
    const lastSeen = l.lastSeenAt ? new Date(l.lastSeenAt) : null;
    const days = daysSince(lastSeen);
    return (
      (l.sightingsCount ?? 1) >= REPOST_MIN_SIGHTINGS &&
      (days == null || days <= REPOST_WINDOW_DAYS)
    );
  });
  if (maxSightings >= REPOST_MIN_SIGHTINGS || recentRepost) {
    signals.reposted_role = maxSightings;
  }

  const oldest = inFocus
    .map((l) => l.firstSeenAt ?? l.postedAt ?? l.createdAt)
    .filter(Boolean)
    .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0];
  const age = daysSince(oldest ? new Date(oldest) : null);
  if (age != null && age >= LONG_RUNNING_DAYS) {
    signals.long_running = age;
  }

  const locations = new Set(
    inFocus.map((l) => (l.location ?? "").trim().toLowerCase()).filter(Boolean),
  );
  if (locations.size >= 2) {
    signals.new_location_cluster = locations.size;
  }

  if (companyFirstSeen && companyFirstSeen === businessListDate()) {
    signals.new_company = true;
  }

  return signals;
}

export function reasonToCallFromSignals(signals: HiringSignals): string | null {
  const reasons: { key: HiringSignalKey; text: string; weight: number }[] = [];

  if (signals.reposted_role) {
    const n =
      typeof signals.reposted_role === "number" ? signals.reposted_role : 3;
    reasons.push({
      key: "reposted_role",
      text: `Same role reposted ${n}× in ${REPOST_WINDOW_DAYS} days`,
      weight: 100,
    });
  }
  if (signals.multiple_openings) {
    const n =
      typeof signals.multiple_openings === "number"
        ? signals.multiple_openings
        : 2;
    reasons.push({
      key: "multiple_openings",
      text: `${n} open reqs · hiring cluster`,
      weight: 85,
    });
  }
  if (signals.long_running) {
    const days =
      typeof signals.long_running === "number" ? signals.long_running : 30;
    reasons.push({
      key: "long_running",
      text: `Role open ${days} days — likely struggling`,
      weight: 70,
    });
  }
  if (signals.new_location_cluster) {
    const n =
      typeof signals.new_location_cluster === "number"
        ? signals.new_location_cluster
        : 2;
    reasons.push({
      key: "new_location_cluster",
      text: `New location — ${n} hiring zones`,
      weight: 60,
    });
  }
  if (signals.new_company) {
    reasons.push({
      key: "new_company",
      text: "New to your list today",
      weight: 55,
    });
  }

  reasons.sort((a, b) => b.weight - a.weight);
  return reasons[0]?.text ?? null;
}

export function signalScoreBonus(signals: HiringSignals): number {
  let bonus = 0;
  if (signals.reposted_role) bonus += 28;
  if (signals.multiple_openings) bonus += 18;
  if (signals.long_running) bonus += 12;
  if (signals.new_location_cluster) bonus += 8;
  if (signals.new_company) bonus += 6;
  return bonus;
}
