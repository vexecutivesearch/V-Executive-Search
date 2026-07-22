"use client";

import { useCallback, useEffect, useState } from "react";
import type { SendingProfile } from "@/lib/db/schema";
import { api, Badge, btn, btnDanger, btnPrimary, input, label, statusTone, Section } from "./shared";

type ProfileRow = SendingProfile & { health: number; effectiveCap: number };
type DnsRecord = { type: string; host: string; value: string; note: string };
type RootGroup = {
  root: string;
  profiles: number;
  sent: number;
  bounced: number;
  complaints: number;
};

export function DomainsTab() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [rootGroups, setRootGroups] = useState<RootGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState({ domain: "", fromAddress: "", replyToAddress: "", resendKeyRef: "" });
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[] | null>(null);
  const [dnsCheck, setDnsCheck] = useState<Record<string, { ok: boolean; detail: string }> | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ profiles: ProfileRow[]; rootGroups: RootGroup[] }>(
      "/api/admin/outreach/profiles",
    );
    setProfiles(data.profiles);
    setRootGroups(data.rootGroups);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const addDomain = async () => {
    setError(null);
    try {
      const result = await api<{ dnsRecords: DnsRecord[] }>("/api/admin/outreach/profiles", {
        method: "POST",
        body: JSON.stringify({ kind: "email_domain", ...add, label: add.domain }),
      });
      setDnsRecords(result.dnsRecords);
      setAdd({ domain: "", fromAddress: "", replyToAddress: "", resendKeyRef: "" });
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      const result = await api<{ dnsCheck?: { spf: { ok: boolean; detail: string }; dkim: { ok: boolean; detail: string }; dmarc: { ok: boolean; detail: string } } }>(
        "/api/admin/outreach/profiles",
        { method: "PATCH", body: JSON.stringify({ id, ...body }) },
      );
      if (result.dnsCheck) {
        setDnsCheck({
          SPF: result.dnsCheck.spf,
          DKIM: result.dnsCheck.dkim,
          DMARC: result.dnsCheck.dmarc,
        });
      }
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Add sending domain"
        subtitle="Enter the domain → create the DNS records shown → Verify DNS. Unverified profiles cannot send, period. Warm-up starts at 5/day and ramps +5 per clean week to ~50/day."
      >
        <div className="grid sm:grid-cols-4 gap-3">
          <div>
            <label className={label}>Domain (e.g. reach1.yourdomain.com)</label>
            <input className={input} value={add.domain} onChange={(e) => setAdd({ ...add, domain: e.target.value })} />
          </div>
          <div>
            <label className={label}>From address</label>
            <input
              className={input}
              placeholder="Alejandro <a.delgado@reach1.…>"
              value={add.fromAddress}
              onChange={(e) => setAdd({ ...add, fromAddress: e.target.value })}
            />
          </div>
          <div>
            <label className={label}>Reply-To (watched mailbox)</label>
            <input className={input} value={add.replyToAddress} onChange={(e) => setAdd({ ...add, replyToAddress: e.target.value })} />
          </div>
          <div>
            <label className={label}>Resend key env-var NAME (optional)</label>
            <input
              className={input}
              placeholder="RESEND_KEY_REACH1"
              value={add.resendKeyRef}
              onChange={(e) => setAdd({ ...add, resendKeyRef: e.target.value })}
            />
          </div>
        </div>
        <button
          className={`${btnPrimary} mt-2`}
          disabled={!add.domain.trim() || !add.fromAddress.trim()}
          onClick={addDomain}
        >
          Add domain
        </button>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        {dnsRecords && (
          <div className="mt-3 border border-sky-200 dark:border-sky-900 rounded-lg p-3 bg-sky-50 dark:bg-sky-950/30">
            <p className="text-xs font-medium mb-2">
              Create these DNS records, then click “Verify DNS” on the profile:
            </p>
            {dnsRecords.map((record) => (
              <p key={record.host + record.type} className="text-[11px] font-mono mb-1">
                {record.type} · {record.host} → {record.value}
                <span className="text-gray-500 font-sans"> — {record.note}</span>
              </p>
            ))}
          </div>
        )}
        {dnsCheck && (
          <div className="mt-3 space-y-1">
            {Object.entries(dnsCheck).map(([name, check]) => (
              <p key={name} className="text-xs">
                <Badge tone={check.ok ? "green" : "red"}>{name}</Badge>{" "}
                <span className="font-mono text-[11px]">{check.detail}</span>
              </p>
            ))}
          </div>
        )}
      </Section>

      {rootGroups.length > 0 && (
        <Section
          title="Root-domain reputation"
          subtitle="Subdomains of one root get correlated by mailbox providers — health rolls up per root. Add 1–2 neutral standalone domains when scaling."
        >
          <div className="flex flex-wrap gap-2">
            {rootGroups.map((group) => (
              <div key={group.root} className="border border-gray-200 dark:border-gray-800 rounded-lg p-2.5 text-xs">
                <span className="font-medium">{group.root}</span> · {group.profiles} profile(s) ·{" "}
                {group.sent} sent · {group.bounced} bounced · {group.complaints} complaints
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title={`Sending profiles (${profiles.length})`}>
        {profiles.length === 0 ? (
          <p className="text-sm text-gray-400">
            No profiles yet — without one, email sends fall back to RESEND_API_KEY +
            OUTREACH_FROM_EMAIL (subject only to the system daily cap).
          </p>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <div key={profile.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={statusTone(profile.status)}>{profile.status}</Badge>
                  <span className="font-medium text-sm">{profile.label}</span>
                  <Badge>{profile.kind}</Badge>
                  <span className="text-gray-500">{profile.fromAddress ?? profile.phoneNumber}</span>
                  <Badge tone={profile.health > 0.7 ? "green" : profile.health > 0.4 ? "amber" : "red"}>
                    health {(profile.health * 100).toFixed(0)}%
                  </Badge>
                  <span className="text-gray-400">
                    cap {profile.effectiveCap}/day (ramp {profile.rampStage}) · sent{" "}
                    {profile.totalSent} · bounced {profile.totalBounced} · complaints{" "}
                    {profile.totalComplaints} · replies {profile.totalReplies}
                  </span>
                  {profile.pausedReason && <Badge tone="red">{profile.pausedReason}</Badge>}
                </div>
                <div className="flex gap-2 mt-2">
                  {profile.kind === "email_domain" && ["new", "verifying"].includes(profile.status) && (
                    <button className={btnPrimary} onClick={() => patch(profile.id, { action: "verify" })}>
                      Verify DNS
                    </button>
                  )}
                  {["warming", "active", "throttled"].includes(profile.status) && (
                    <button
                      className={btn}
                      onClick={() => {
                        const confirmLabel =
                          profile.status === "active"
                            ? prompt(`Pausing a warm domain — type "${profile.label}" to confirm:`)
                            : profile.label;
                        if (confirmLabel) patch(profile.id, { action: "pause", confirmLabel });
                      }}
                    >
                      Pause
                    </button>
                  )}
                  {profile.status === "paused" && (
                    <button className={btn} onClick={() => patch(profile.id, { action: "resume" })}>
                      Resume (re-enter warm-up)
                    </button>
                  )}
                  <button
                    className={btnDanger}
                    onClick={() => {
                      const needsConfirm = ["warming", "active"].includes(profile.status);
                      const confirmLabel = needsConfirm
                        ? prompt(`Deleting a warm domain — type "${profile.label}" to confirm:`)
                        : profile.label;
                      if (confirmLabel) patch(profile.id, { action: "delete", confirmLabel });
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
