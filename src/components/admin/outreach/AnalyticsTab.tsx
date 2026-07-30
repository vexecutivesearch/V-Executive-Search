"use client";

import { useEffect, useState } from "react";
import { api, Badge, Section } from "./shared";

type Analytics = {
  templates: Array<{
    id: string;
    name: string;
    kind: string;
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
        title="Templates"
        subtitle="Underperformers (volume with zero positives / heavy opt-outs) are auto-flagged for deactivation — never auto-disabled."
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200 dark:border-gray-800">
              <th className="py-1.5 pr-2">Template</th>
              <th className="py-1.5 pr-2 text-right">Sends</th>
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
                  {t.name} <span className="text-gray-400">({t.kind})</span>
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{t.sends}</td>
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
