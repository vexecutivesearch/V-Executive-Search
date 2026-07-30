"use client";

import { useCallback, useEffect, useState } from "react";
import type { Suppression } from "@/lib/db/schema";
import { api, Badge, btn, btnDanger, btnPrimary, input, label, Section } from "./shared";

export function SuppressionsTab() {
  const [rows, setRows] = useState<Suppression[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState({ email: "", phone: "", channel: "all", reason: "" });
  const [dnc, setDnc] = useState("");
  const [deleteContactId, setDeleteContactId] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ suppressions: Suppression[] }>(
      "/api/admin/outreach/suppressions",
    );
    setRows(data.suppressions);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const post = async (body: Record<string, unknown>, okMessage: string) => {
    setError(null);
    setStatus(null);
    try {
      const result = await api<{ imported?: number }>("/api/admin/outreach/suppressions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setStatus(
        result.imported !== undefined ? `${okMessage} (${result.imported} imported)` : okMessage,
      );
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Add a suppression"
        subtitle='Per-channel: "stop emailing me" suppresses email but leaves texts unless the intent says otherwise. Checked before every send, even mid-flow.'
      >
        <div className="grid sm:grid-cols-4 gap-3">
          <div>
            <label className={label}>Email</label>
            <input
              className={input}
              value={add.email}
              onChange={(e) => setAdd({ ...add, email: e.target.value })}
            />
          </div>
          <div>
            <label className={label}>Phone</label>
            <input
              className={input}
              value={add.phone}
              onChange={(e) => setAdd({ ...add, phone: e.target.value })}
            />
          </div>
          <div>
            <label className={label}>Channel</label>
            <select
              className={input}
              value={add.channel}
              onChange={(e) => setAdd({ ...add, channel: e.target.value })}
            >
              <option value="all">all</option>
              <option value="email">email only</option>
              <option value="imessage">imessage only</option>
            </select>
          </div>
          <div>
            <label className={label}>Reason</label>
            <input
              className={input}
              value={add.reason}
              onChange={(e) => setAdd({ ...add, reason: e.target.value })}
            />
          </div>
        </div>
        <button
          className={`${btnPrimary} mt-2`}
          disabled={!add.email.trim() && !add.phone.trim()}
          onClick={() =>
            post(
              { action: "add", ...add, reason: add.reason || "manual suppression" },
              "Suppression added",
            )
          }
        >
          Suppress
        </button>
      </Section>

      <Section
        title="DNC import"
        subtitle="Paste emails and/or phone numbers (comma or newline separated) — matched across both columns."
      >
        <textarea
          className={`${input} h-28 font-mono text-xs`}
          placeholder={"jane@acme.com\n+1 561 555 0100"}
          value={dnc}
          onChange={(e) => setDnc(e.target.value)}
        />
        <button
          className={`${btnPrimary} mt-2`}
          disabled={!dnc.trim()}
          onClick={() => post({ action: "import", values: dnc }, "DNC list imported")}
        >
          Import DNC list
        </button>
      </Section>

      <Section
        title="Data deletion request"
        subtitle="For requests arriving out-of-band: purges drafts + inbound bodies for the contact, fully suppresses email + phone, and writes the audit event."
      >
        <div className="flex gap-2">
          <input
            className={input}
            placeholder="Contact UUID"
            value={deleteContactId}
            onChange={(e) => setDeleteContactId(e.target.value)}
          />
          <button
            className={btnDanger}
            disabled={!deleteContactId.trim()}
            onClick={() => {
              if (confirm("Purge this contact's outreach data and fully suppress them?")) {
                post(
                  { action: "data_deletion", contactId: deleteContactId.trim() },
                  "Contact purged + suppressed",
                );
                setDeleteContactId("");
              }
            }}
          >
            Purge + suppress
          </button>
        </div>
      </Section>

      {(status || error) && (
        <p className={`text-xs ${error ? "text-red-600" : "text-green-600"}`}>
          {error ?? status}
        </p>
      )}

      <Section title={`Suppression list (${rows.length})`}>
        {rows.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing suppressed.</p>
        ) : (
          <div className="space-y-1.5">
            {rows.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-2 text-xs border-b border-gray-100 dark:border-gray-900 pb-1.5">
                <Badge tone={row.channel === "all" ? "red" : "amber"}>{row.channel}</Badge>
                <span className="font-mono">{row.email ?? row.phone}</span>
                <span className="text-gray-500">{row.reason}</span>
                {row.legalBasis && <span className="text-gray-400">({row.legalBasis})</span>}
                <span className="text-gray-400">{new Date(row.createdAt).toLocaleDateString()}</span>
                <button
                  className={btn}
                  onClick={async () => {
                    if (confirm("Remove this suppression? They become contactable again.")) {
                      await api(`/api/admin/outreach/suppressions?id=${row.id}`, { method: "DELETE" });
                      await load();
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
