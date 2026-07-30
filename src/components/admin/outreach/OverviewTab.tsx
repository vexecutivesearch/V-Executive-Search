"use client";

import { useEffect, useState } from "react";
import type { OutreachSettings } from "@/lib/db/schema";
import { api, Badge, btn, btnPrimary, input, label, Section } from "./shared";

type Overview = {
  enrollments: Record<string, number>;
  messages: Record<string, number>;
  sends: number;
  replies: number;
  positives: number;
  unreadNotifications: number;
};

export function OverviewTab() {
  const [settings, setSettings] = useState<OutreachSettings | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    const [s, a] = await Promise.all([
      api<{ settings: OutreachSettings }>("/api/admin/outreach/settings"),
      api<{ overview: Overview }>("/api/admin/outreach/analytics"),
    ]);
    setSettings(s.settings);
    setOverview(a.overview);
  };

  useEffect(() => {
    load().catch((e) => setMessage(String(e)));
  }, []);

  const save = async (patch: Partial<OutreachSettings>) => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await api<{ settings: OutreachSettings }>(
        "/api/admin/outreach/settings",
        { method: "PUT", body: JSON.stringify(patch) },
      );
      setSettings(result.settings);
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

  const toggles: Array<{
    key: "enabled" | "dryRun" | "requireApproval" | "autoEnroll" | "workEmailPreferred";
    title: string;
    description: string;
    danger?: boolean;
  }> = [
    {
      key: "enabled",
      title: "Master send switch (kill switch)",
      description:
        "OFF = nothing sends anywhere (email or text), no matter what flows say. This is the system-level override above all sequences.",
      danger: true,
    },
    {
      key: "dryRun",
      title: "Dry-run mode",
      description:
        "Drafts and schedules everything but never sends — use this to preview the pipeline end-to-end.",
    },
    {
      key: "requireApproval",
      title: "Approval gate",
      description:
        "Every drafted message must be approved in the Approvals tab before dispatch will send it.",
    },
    {
      key: "autoEnroll",
      title: "Auto-enroll on call list",
      description:
        "When you add a company to the call list, the primary contact is enrolled with a personalized email + SMS sequence drafted from their job listings (also runs after enrich ingest). Manual enroll stays available either way.",
    },
    {
      key: "workEmailPreferred",
      title: "Prefer work email",
      description: "Work email first, personal as fallback (off = personal first).",
    },
  ];

  return (
    <div className="space-y-4">
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
            <label className={label}>System daily send cap (all channels)</label>
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
    </div>
  );
}
