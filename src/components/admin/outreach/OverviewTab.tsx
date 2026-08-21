"use client";

import { useEffect, useState } from "react";
import type { OutreachSettings } from "@/lib/db/schema";
import {
  CRON_COVERED_END_HOUR,
  TESTING_WINDOW_DEFAULT_HOURS,
  TESTING_WINDOW_MAX_HOURS,
} from "@/lib/outreach/send-window";
import { api, Badge, btn, btnDanger, btnPrimary, input, label, Section } from "./shared";

type Overview = {
  enrollments: Record<string, number>;
  messages: Record<string, number>;
  sends: number;
  replies: number;
  positives: number;
  unreadNotifications: number;
};

/** Server-resolved effective window; dates arrive as ISO strings over JSON. */
type ResolvedWindow = {
  startHour: number;
  endHour: number;
  testingOverrideActive: boolean;
  overrideExpiresAt: string | null;
};

type SettingsPatch = Partial<OutreachSettings> & {
  testingWindowHours?: number;
  testingWindowStartHour?: number;
  testingWindowEndHour?: number;
};

const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

function formatCountdown(expiresAt: string, nowMs: number): string {
  const minutes = Math.ceil((new Date(expiresAt).getTime() - nowMs) / 60_000);
  if (minutes <= 0) return "expired";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function OverviewTab() {
  const [settings, setSettings] = useState<OutreachSettings | null>(null);
  const [sendWindow, setSendWindow] = useState<ResolvedWindow | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draftStart, setDraftStart] = useState<number | null>(null);
  const [draftEnd, setDraftEnd] = useState<number | null>(null);
  const [draftHours, setDraftHours] = useState(TESTING_WINDOW_DEFAULT_HOURS);
  // Clock kept in state so the countdown ticks and the badge clears at expiry
  // without reading the impure Date.now() during render. 0 means "not yet
  // sampled", in which case the server's freshly-resolved verdict stands.
  const [nowMs, setNowMs] = useState(0);

  const load = async () => {
    const [s, a] = await Promise.all([
      api<{ settings: OutreachSettings; window: ResolvedWindow }>(
        "/api/admin/outreach/settings",
      ),
      api<{ overview: Overview }>("/api/admin/outreach/analytics"),
    ]);
    setNowMs(Date.now());
    setSettings(s.settings);
    setSendWindow(s.window);
    setOverview(a.overview);
  };

  useEffect(() => {
    load().catch((e) => setMessage(String(e)));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const save = async (patch: SettingsPatch) => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await api<{ settings: OutreachSettings; window: ResolvedWindow }>(
        "/api/admin/outreach/settings",
        { method: "PUT", body: JSON.stringify(patch) },
      );
      setSettings(result.settings);
      setSendWindow(result.window);
      setMessage("Saved.");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return <p className="text-sm text-gray-500">Loading…{message && ` ${message}`}</p>;
  }

  const overrideExpiresAt = sendWindow?.overrideExpiresAt ?? null;
  // Recomputed on each tick rather than trusting the badge the server sent,
  // so an override that lapses while this page is open stops showing as on.
  const overrideActive = Boolean(
    sendWindow?.testingOverrideActive &&
      overrideExpiresAt &&
      new Date(overrideExpiresAt).getTime() > nowMs,
  );
  const effectiveStart = overrideActive ? sendWindow!.startHour : settings.sendWindowStartHour;
  const effectiveEnd = overrideActive ? sendWindow!.endHour : settings.sendWindowEndHour;
  const formStart = draftStart ?? settings.sendWindowStartHour;
  const formEnd = draftEnd ?? Math.max(settings.sendWindowEndHour, CRON_COVERED_END_HOUR);

  const toggles: Array<{
    key:
      | "enabled"
      | "textEnabled"
      | "dryRun"
      | "requireApproval"
      | "autoEnroll"
      | "workEmailPreferred";
    title: string;
    description: string;
    danger?: boolean;
  }> = [
    {
      key: "enabled",
      title: "Master send switch (kill switch)",
      description:
        "OFF = nothing sends anywhere (email or text), no matter what flows say. Must be ON together with Dry-run Off for live Call List / enroll sends.",
      danger: true,
    },
    {
      key: "textEnabled",
      title: "Text channel (iMessage / SMS)",
      description:
        "OFF = no text is drafted, queued, or handed to the Mac worker: enrollments plan email only, the worker queue returns empty, replies that arrive by text are answered by email, and booking confirmations stay quiet. Email is unaffected. Texts already sitting in the queue are held, not cancelled.",
      danger: true,
    },
    {
      key: "dryRun",
      title: "Dry-run mode",
      description:
        "ON = draft and queue everything but never send, auto-replies included. OFF = live sends when Master send is also On (email via Resend in the send window; SMS via the Mac worker iMessage queue when the text channel is On).",
    },
    {
      key: "requireApproval",
      title: "Approval gate",
      description:
        "ON = every drafted message must be approved in Approvals before send. OFF = enroll auto-approves, queues the day-0 intro, and dispatches when Master is On and Dry-run is Off.",
    },
    {
      key: "autoEnroll",
      title: "Auto-enroll on call list",
      description:
        "When you add a company to the call list, the primary contact is enrolled with a personalized email sequence drafted from their job listings (also runs after enrich ingest). Manual enroll stays available either way.",
    },
    {
      key: "workEmailPreferred",
      title: "Prefer work email",
      description: "Work email first, personal as fallback (off = personal first).",
    },
  ];

  return (
    <div className="space-y-4">
      {overrideActive && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 flex items-center justify-between gap-4">
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <span className="font-semibold">Testing send window is ON</span> — sending{" "}
            {hourLabel(effectiveStart)}–{hourLabel(effectiveEnd)} contact-local instead of{" "}
            {hourLabel(settings.sendWindowStartHour)}–{hourLabel(settings.sendWindowEndHour)}.
            Reverts automatically in {formatCountdown(overrideExpiresAt!, nowMs)}.
          </div>
          <button
            className={btnDanger}
            disabled={saving}
            onClick={() => save({ testingWindowUntil: null })}
          >
            End now
          </button>
        </div>
      )}

      {overview && (
        <Section title="Pipeline at a glance">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            {[
              ["Active", overview.enrollments.active ?? 0],
              ["Sent", overview.sends],
              ["Replies", overview.replies],
              ["Positive", overview.positives],
            ].map(([labelText, value]) => (
              <div
                key={String(labelText)}
                className="rounded-lg border border-gray-200 dark:border-gray-800 p-3"
              >
                <div className="text-2xl font-semibold tabular-nums">{value}</div>
                <div className="text-xs text-gray-500">{labelText}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {Object.entries(overview.enrollments).map(([status, count]) => (
              <Badge key={status}>{`${status}: ${count}`}</Badge>
            ))}
            {Object.entries(overview.messages).map(([status, count]) => (
              <Badge key={`m-${status}`} tone="blue">{`msg ${status}: ${count}`}</Badge>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Safety switches"
        subtitle="System-level overrides — these sit above sequences and flows, never inside them."
      >
        <div className="space-y-3">
          {toggles.map((toggle) => (
            <div key={toggle.key} className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">
                  {toggle.title}{" "}
                  {toggle.key === "enabled" && (
                    <Badge tone={settings.enabled ? "green" : "red"}>
                      {settings.enabled ? "SENDING ENABLED" : "ALL SENDS OFF"}
                    </Badge>
                  )}
                  {toggle.key === "textEnabled" && (
                    <Badge tone={settings.textEnabled ? "green" : "red"}>
                      {settings.textEnabled ? "TEXTING ON" : "ALL TEXTS OFF"}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-gray-500 max-w-xl">{toggle.description}</p>
              </div>
              <button
                className={settings[toggle.key] ? btnPrimary : btn}
                disabled={saving}
                onClick={() => save({ [toggle.key]: !settings[toggle.key] })}
              >
                {settings[toggle.key] ? "On" : "Off"}
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Caps, window & identity">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={label}>
              System daily send cap (per channel — this many emails AND this
              many texts)
            </label>
            <input
              className={input}
              type="number"
              defaultValue={settings.dailySendCap}
              onBlur={(e) => save({ dailySendCap: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className={label}>Max contacts per company (2–3)</label>
            <input
              className={input}
              type="number"
              defaultValue={settings.maxContactsPerCompany}
              onBlur={(e) => save({ maxContactsPerCompany: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className={label}>Intro stagger between contacts (days)</label>
            <input
              className={input}
              type="number"
              defaultValue={settings.introStaggerDays}
              onBlur={(e) => save({ introStaggerDays: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className={label}>Send window (contact-local hours)</label>
            <div className="flex gap-2 items-center">
              <input
                className={input}
                type="number"
                defaultValue={settings.sendWindowStartHour}
                onBlur={(e) => save({ sendWindowStartHour: Number(e.target.value) })}
              />
              <span className="text-xs text-gray-500">to</span>
              <input
                className={input}
                type="number"
                defaultValue={settings.sendWindowEndHour}
                onBlur={(e) => save({ sendWindowEndHour: Number(e.target.value) })}
              />
            </div>
          </div>
          <div>
            <label className={label}>Reply-To address (IMAP-watched mailbox)</label>
            <input
              className={input}
              defaultValue={settings.replyToAddress ?? ""}
              placeholder="replies@yourdomain.com"
              onBlur={(e) => save({ replyToAddress: e.target.value || null })}
            />
          </div>
          <div>
            <label className={label}>Physical mailing address (CAN-SPAM footer)</label>
            <input
              className={input}
              defaultValue={settings.physicalAddress ?? ""}
              placeholder="869 Donald Ross Road, Juno Beach, FL"
              onBlur={(e) => save({ physicalAddress: e.target.value || null })}
            />
          </div>
        </div>
        {message && <p className="text-xs text-gray-500 mt-3">{message}</p>}
      </Section>

      <Section
        title="Testing send window"
        subtitle="Temporarily widen the send window for a testing session without touching the production hours above. Always expires on its own."
      >
        <div className="flex items-center gap-2 mb-3">
          <Badge tone={overrideActive ? "amber" : "gray"}>
            {overrideActive ? "OVERRIDE ACTIVE" : "PRODUCTION HOURS"}
          </Badge>
          <span className="text-xs text-gray-500">
            Sending {hourLabel(effectiveStart)}–{hourLabel(effectiveEnd)} contact-local
            {overrideActive
              ? ` until ${new Date(overrideExpiresAt!).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })} (${formatCountdown(overrideExpiresAt!, nowMs)} left)`
              : ""}
          </span>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <div>
            <label className={label}>Testing window (contact-local hours)</label>
            <div className="flex gap-2 items-center">
              <input
                className={input}
                type="number"
                min={0}
                max={24}
                value={formStart}
                onChange={(e) => setDraftStart(Number(e.target.value))}
              />
              <span className="text-xs text-gray-500">to</span>
              <input
                className={input}
                type="number"
                min={0}
                max={24}
                value={formEnd}
                onChange={(e) => setDraftEnd(Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <label className={label}>Expires after (max {TESTING_WINDOW_MAX_HOURS}h)</label>
            <input
              className={input}
              type="number"
              min={1}
              max={TESTING_WINDOW_MAX_HOURS}
              value={draftHours}
              onChange={(e) => setDraftHours(Number(e.target.value))}
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              className={btnPrimary}
              disabled={saving}
              onClick={() =>
                save({
                  testingWindowHours: draftHours,
                  testingWindowStartHour: formStart,
                  testingWindowEndHour: formEnd,
                })
              }
            >
              {overrideActive ? "Extend / update" : "Start override"}
            </button>
            {overrideActive && (
              <button
                className={btn}
                disabled={saving}
                onClick={() => save({ testingWindowUntil: null })}
              >
                End now
              </button>
            )}
          </div>
        </div>

        {formEnd > CRON_COVERED_END_HOUR && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-3">
            Past {hourLabel(CRON_COVERED_END_HOUR)} the dispatch cron no longer runs for
            West-Coast contacts. Day-0 sends still go out immediately at enroll time, but
            later flow steps scheduled past that hour wait for the next cron day.
          </p>
        )}
      </Section>
    </div>
  );
}
