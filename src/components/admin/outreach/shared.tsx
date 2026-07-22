"use client";

export async function api<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) {
    throw new Error(data?.error ?? `HTTP ${resp.status}`);
  }
  return data;
}

export function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-gray-200 dark:border-gray-800 rounded-xl bg-white dark:bg-gray-950 shadow-sm p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {subtitle && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3">{subtitle}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const BADGE_STYLES: Record<string, string> = {
  green: "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  gray: "bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
};

export function Badge({
  tone = "gray",
  children,
}: {
  tone?: keyof typeof BADGE_STYLES | string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${
        BADGE_STYLES[tone] ?? BADGE_STYLES.gray
      }`}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): string {
  if (["active", "sent", "healthy", "replied_positive"].includes(status)) return "green";
  if (["paused", "waiting_on_manual", "queued", "warming", "throttled", "drafted"].includes(status))
    return "amber";
  if (["stopped", "suppressed", "failed", "bounced", "banned", "replied_negative"].includes(status))
    return "red";
  if (["completed", "waiting_on_reply", "verifying"].includes(status)) return "blue";
  return "gray";
}

export const btn =
  "px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed";
export const btnPrimary =
  "px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";
export const btnDanger =
  "px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed";
export const input =
  "px-2.5 py-1.5 rounded-lg text-sm border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 w-full";
export const label = "block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1";
