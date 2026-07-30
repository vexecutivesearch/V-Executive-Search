/**
 * Google Calendar availability for positive-reply auto-replies.
 * Read-only free/busy via OAuth refresh token (server-side only):
 *   GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET /
 *   GOOGLE_CALENDAR_REFRESH_TOKEN / GOOGLE_CALENDAR_ID (default "primary")
 * Calendar failure never blocks the reply — callers fall back to a generic
 * availability line and flag the reply for confirmation.
 */

import { dateInTimezone, wallClock, DEFAULT_TIMEZONE } from "@/lib/outreach/timezone-infer";

type BusyInterval = { start: Date; end: Date };

export type AvailabilityResult = {
  lines: string[];
  /** false when the calendar could not be queried (generic line used). */
  fromCalendar: boolean;
};

async function accessTokenFromRefresh(): Promise<string | null> {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) {
      console.error("[outreach] gcal token refresh failed:", await resp.text());
      return null;
    }
    const data = (await resp.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch (error) {
    console.error("[outreach] gcal token error:", error);
    return null;
  }
}

async function freeBusy(
  token: string,
  from: Date,
  to: Date,
): Promise<BusyInterval[] | null> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID ?? "primary";
  try {
    const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    if (!resp.ok) {
      console.error("[outreach] gcal freebusy failed:", await resp.text());
      return null;
    }
    const data = (await resp.json()) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    };
    const busy = data.calendars?.[calendarId]?.busy ?? [];
    return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (error) {
    console.error("[outreach] gcal freebusy error:", error);
    return null;
  }
}

function overlaps(a: BusyInterval, b: BusyInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

const SLOT_TEMPLATES = [
  { hour: 10, minute: 0 },
  { hour: 11, minute: 30 },
  { hour: 14, minute: 0 },
  { hour: 15, minute: 30 },
];

function formatWindow(start: Date, timeZone: string): string {
  const day = start.toLocaleDateString("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const time = start.toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const zone = timeZone === "America/New_York" ? "ET" : start
    .toLocaleTimeString("en-US", { timeZone, timeZoneName: "short" })
    .split(" ")
    .pop();
  return `${day} at ${time} ${zone}`;
}

/**
 * 2–3 open 30-minute windows over the next 5 business days, written as plain
 * text in the recruiter's working timezone.
 */
export async function suggestAvailability(options?: {
  timeZone?: string;
  now?: Date;
  maxWindows?: number;
}): Promise<AvailabilityResult> {
  const timeZone = options?.timeZone ?? DEFAULT_TIMEZONE;
  const now = options?.now ?? new Date();
  const maxWindows = options?.maxWindows ?? 3;

  const token = await accessTokenFromRefresh();
  let busy: BusyInterval[] | null = null;
  if (token) {
    busy = await freeBusy(token, now, new Date(now.getTime() + 8 * 86_400_000));
  }
  if (busy === null) {
    return {
      lines: [
        "I have good availability over the next few days — send a couple of times that work and I'll make one fit.",
      ],
      fromCalendar: false,
    };
  }

  const windows: string[] = [];
  let cursor = now;
  let businessDaysChecked = 0;
  while (windows.length < maxWindows && businessDaysChecked < 5) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const wc = wallClock(cursor, timeZone);
    if (wc.weekday === 0 || wc.weekday === 6) continue;
    businessDaysChecked += 1;

    for (const slot of SLOT_TEMPLATES) {
      if (windows.length >= maxWindows) break;
      const start = dateInTimezone(wc.year, wc.month, wc.day, slot.hour, slot.minute, timeZone);
      const end = new Date(start.getTime() + 30 * 60_000);
      if (start <= now) continue;
      const isBusy = busy.some((b) => overlaps({ start, end }, b));
      if (!isBusy) {
        windows.push(`- ${formatWindow(start, timeZone)}`);
        break; // one window per day, spread across days
      }
    }
  }

  if (!windows.length) {
    return {
      lines: [
        "This week is packed, but send a couple of times that could work and I'll move things around.",
      ],
      fromCalendar: true,
    };
  }
  return { lines: windows, fromCalendar: true };
}
