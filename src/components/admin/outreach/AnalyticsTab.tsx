"use client";

import { useEffect, useState } from "react";
import {
  PROVEN_BADGE_LABEL,
  templateChannelLabel,
  templateKindLabel,
} from "@/lib/outreach/template-labels";
import { CALL_OUTCOME_LABELS } from "@/lib/call-outcomes";
import { LEAD_SOURCE_LABELS } from "@/lib/lead-lanes";
import type { LeadSource } from "@/lib/db/schema";
import { api, Badge, Section } from "./shared";

type Analytics = {
  templates: Array<{
    id: string;
    name: string;
    kind: string;
    channel: string;
    isProven: boolean;
    isActive: boolean;
    sends: number;
    replies: number;
    positives: number;
    optOuts: number;
    replyRate: number | null;
    positiveRate: number | null;
    flagged: boolean;
    flagReason: string | null;
  }>;
  profiles: Array<{
    id: string;
    label: string;
    status: string;
    sent: number;
    bounced: number;
    complaints: number;
    replies: number;
    positives: number;
    health: number;
  }>;
  branches: Array<{
    flowVersionId: string;
    splitNode: string;
    branch: string;
    enrollments: number;
    positives: number;
    outcomes: number;
  }>;
  outcomes: Array<{ flowVersionId: string | null; outcome: string; count: number }>;
  industries: Array<{
    industry: string;
    enrollments: number;
    replies: number;
    positives: number;
  }>;
  calls: {
    placed: number;
    connected: number;
    reachedHuman: number;
    gatekeeper: number;
    noAnswer: number;
    voicemail: number;
    wrongNumber: number;
    connectRate: number | null;
    companiesCalled: number;
    optInLinksSent: number;
    optInLinkFailures: number;
    optInConversions: number;
    optInConversionRate: number | null;
  };
  consent: Array<{
    source: string;
    captured: number;
    revoked: number;
    liveSms: number;
  }>;
  lanes: Array<{
    leadSource: LeadSource;
    companies: number;
    enrollments: number;
    replies: number;
    positives: number;
    meetings: number;
    callsPlaced: number;
    connects: number;
    optInLinksSent: number;
    consentRecords: number;
    replyRate: number | null;
    bookingRate: number | null;
    connectRate: number | null;
  }>;
};

const CONSENT_SOURCE_LABELS: Record<string, string> = {
  web_form: "Self-hosted opt-in form",
  meta_lead_ad: "Meta lead ad",
  inbound_written_request: "Inbound written request",
};

function pct(value: number | null): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function AnalyticsTab() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Analytics>("/api/admin/outreach/analytics")
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <Section
        title="Calling"
        subtitle="Is calling worth doing? Only business lines are dialable, and the call's job is to earn an opt-in form click — consent is never captured on the phone. Conversion counts companies sent a link, not links sent, so chasing one prospect twice does not deflate it."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Calls placed", String(data.calls.placed)],
            ["Companies reached", String(data.calls.companiesCalled)],
            ["Connect rate", pct(data.calls.connectRate)],
            ["Spoke to a human", String(data.calls.reachedHuman)],
            ["Opt-in links sent", String(data.calls.optInLinksSent)],
            ["Opt-ins earned", String(data.calls.optInConversions)],
            ["Opt-in conversion", pct(data.calls.optInConversionRate)],
            ["Failed link sends", String(data.calls.optInLinkFailures)],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2"
            >
              <p className="text-[10px] uppercase tracking-wide text-gray-500">
                {label}
              </p>
              <p className="text-lg font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>

        {data.calls.placed === 0 ? (
          <p className="mt-3 text-sm text-gray-400">
            No calls logged yet — log outcomes from the Call List to populate
            this.
          </p>
        ) : (
          <p className="mt-3 text-xs text-gray-500">
            {CALL_OUTCOME_LABELS.connected}: {data.calls.connected} ·{" "}
            {CALL_OUTCOME_LABELS.gatekeeper}: {data.calls.gatekeeper} ·{" "}
            {CALL_OUTCOME_LABELS.no_answer}: {data.calls.noAnswer} ·{" "}
            {CALL_OUTCOME_LABELS.voicemail}: {data.calls.voicemail} ·{" "}
            {CALL_OUTCOME_LABELS.wrong_number}: {data.calls.wrongNumber}
          </p>
        )}
      </Section>

      <Section
        title="Consent artifacts"
        subtitle="Written consent on file, by the mechanism that captured it. A revoked record is kept — retention guidance is five years — but never authorizes a send."
      >
        {data.consent.length === 0 ? (
          <p className="text-sm text-gray-400">
            No consent records yet. Until one exists, no number may be texted.
          </p>
        ) : (
          <div className="space-y-1.5 text-xs">
            {data.consent.map((row) => (
              <p key={row.source}>
                <Badge tone={row.liveSms > 0 ? "green" : "amber"}>
                  {row.liveSms} live SMS
                </Badge>{" "}
                <span className="font-medium">
                  {CONSENT_SOURCE_LABELS[row.source] ?? row.source}
                </span>{" "}
                — {row.captured} captured · {row.revoked} revoked
              </p>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="By lane"
        subtitle="Cold leads are email plus a human call to the main line. Inbound leads arrived with a consent artifact and are excluded from cold calling. Averaging the two hides which one works."
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200 dark:border-gray-800">
              <th className="py-1.5 pr-2">Lane</th>
              <th className="py-1.5 pr-2 text-right">Companies</th>
              <th className="py-1.5 pr-2 text-right">Enrolled</th>
              <th className="py-1.5 pr-2 text-right">Replies</th>
              <th className="py-1.5 pr-2 text-right">Reply rate</th>
              <th className="py-1.5 pr-2 text-right">Booked</th>
              <th className="py-1.5 pr-2 text-right">Booking rate</th>
              <th className="py-1.5 pr-2 text-right">Calls</th>
              <th className="py-1.5 pr-2 text-right">Connect rate</th>
              <th className="py-1.5 pr-2 text-right">Links sent</th>
              <th className="py-1.5 text-right">Consent</th>
            </tr>
          </thead>
          <tbody>
            {data.lanes.map((row) => (
              <tr
                key={row.leadSource}
                className="border-b border-gray-100 dark:border-gray-900 last:border-b-0"
              >
                <td className="py-1.5 pr-2 font-medium">
                  {LEAD_SOURCE_LABELS[row.leadSource] ?? row.leadSource}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.companies}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.enrollments}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.replies}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {pct(row.replyRate)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.meetings}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {pct(row.bookingRate)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.callsPlaced}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {pct(row.connectRate)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.optInLinksSent}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {row.consentRecords}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Templates"
        subtitle="Rates count sends, not messages: a send is replied once however long the thread runs, so these can never exceed 100%. Underperformers (volume with zero positives / heavy opt-outs) are auto-flagged for deactivation, never auto-disabled."
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200 dark:border-gray-800">
              <th className="py-1.5 pr-2">Template</th>
              <th className="py-1.5 pr-2">Step</th>
              <th className="py-1.5 pr-2">Channel</th>
              <th className="py-1.5 pr-2 text-right">Sends</th>
              <th className="py-1.5 pr-2 text-right">Replied</th>
              <th className="py-1.5 pr-2 text-right">Reply rate</th>
              <th className="py-1.5 pr-2 text-right">Positive rate</th>
              <th className="py-1.5 pr-2 text-right">Opt-outs</th>
              <th className="py-1.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.templates.map((t) => (
              <tr key={t.id} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
                <td className="py-1.5 pr-2">
                  {t.name}
                  {t.isProven && (
                    <>
                      {" "}
                      <Badge tone="blue">{PROVEN_BADGE_LABEL}</Badge>
                    </>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-gray-500">{templateKindLabel(t.kind)}</td>
                <td className="py-1.5 pr-2 text-gray-500">
                  {templateChannelLabel(t.channel)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{t.sends}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{t.replies}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{pct(t.replyRate)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{pct(t.positiveRate)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{t.optOuts}</td>
                <td className="py-1.5">
                  {t.flagged ? (
                    <Badge tone="red">⚠ {t.flagReason}</Badge>
                  ) : t.isActive ? (
                    <Badge tone="green">active</Badge>
                  ) : (
                    <Badge>inactive</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Sending profiles">
        {data.profiles.length === 0 ? (
          <p className="text-sm text-gray-400">No profiles yet.</p>
        ) : (
          <div className="space-y-1.5 text-xs">
            {data.profiles.map((p) => (
              <p key={p.id}>
                <Badge tone={p.health > 0.7 ? "green" : "amber"}>
                  {(p.health * 100).toFixed(0)}%
                </Badge>{" "}
                <span className="font-medium">{p.label}</span> ({p.status}) — {p.sent} sent ·{" "}
                {p.bounced} bounced · {p.complaints} complaints · {p.replies} replies ·{" "}
                {p.positives} positive
              </p>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="A/B branches & outcomes"
        subtitle='ROI attribution: "Flow X: Z sends → Y meetings booked". Outcome nodes + meeting/client status changes attribute back to the flow + branch.'
      >
        {data.branches.length === 0 && data.outcomes.length === 0 ? (
          <p className="text-sm text-gray-400">
            No split branches or outcomes recorded yet — add a Random Split or Outcome node to a
            flow.
          </p>
        ) : (
          <div className="space-y-1.5 text-xs">
            {data.branches.map((b) => (
              <p key={`${b.flowVersionId}${b.splitNode}${b.branch}`}>
                <Badge tone="blue">
                  {b.splitNode} → {b.branch}
                </Badge>{" "}
                {b.enrollments} enrolled · {b.positives} positive · {b.outcomes} outcome(s)
                <span className="text-gray-400"> (v{b.flowVersionId.slice(0, 8)})</span>
              </p>
            ))}
            {data.outcomes.map((o) => (
              <p key={`${o.flowVersionId}${o.outcome}`}>
                <Badge tone="green">{o.outcome}</Badge> ×{o.count}
                {o.flowVersionId && (
                  <span className="text-gray-400"> (v{o.flowVersionId.slice(0, 8)})</span>
                )}
              </p>
            ))}
          </div>
        )}
      </Section>

      <Section title="By industry">
        {data.industries.length === 0 ? (
          <p className="text-sm text-gray-400">No enrollments yet.</p>
        ) : (
          <div className="space-y-1 text-xs">
            {data.industries.slice(0, 15).map((row) => (
              <p key={row.industry}>
                <span className="font-medium">{row.industry}</span> — {row.enrollments} enrolled ·{" "}
                {row.replies} replies · {row.positives} positive
              </p>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
