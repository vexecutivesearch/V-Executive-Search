"use client";

import { useEffect, useState } from "react";
import type { DialTarget } from "@/lib/call-dial-targets";
import { CALL_OUTCOME_LABELS, CALL_OUTCOMES } from "@/lib/call-outcomes";
import { PHONE_CLASSIFICATION_LABELS } from "@/lib/phone-classification";
import type { CallListEntry, CallOutcomeKind } from "@/lib/db/schema";

/**
 * The call screen: which numbers may be dialed, what the dial produced, and
 * the opt-in link that is the call's actual goal.
 *
 * A blocked number is rendered as text, never as a link. There is no confirm
 * dialog and no override, because a confirm dialog is a path to the unsafe
 * action and the requirement is that no such path exists. The number is still
 * shown so the operator can see it exists and why it is unusable.
 */

type ContactOption = {
  id: string;
  name: string;
  email?: string | null;
  workEmail?: string | null;
  personalEmail?: string | null;
};

function contactEmail(contact: ContactOption): string | null {
  return contact.workEmail ?? contact.email ?? contact.personalEmail ?? null;
}

export function CallLogPanel({
  entryId,
  targets: providedTargets,
  contacts = [],
  primaryContactId,
  locked = false,
  onEntryChange,
}: {
  entryId: string;
  /** Omit to fetch the gated list from the server. */
  targets?: DialTarget[];
  contacts?: ContactOption[];
  primaryContactId?: string | null;
  locked?: boolean;
  onEntryChange?: (entry: CallListEntry) => void;
}) {
  const [fetched, setFetched] = useState<DialTarget[] | null>(null);
  const targets = providedTargets ?? fetched;
  const [outcome, setOutcome] = useState<CallOutcomeKind>("placed");
  const [picked, setPicked] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const emailable = contacts.filter((c) => contactEmail(c));
  const [recipientId, setRecipientId] = useState(
    () =>
      emailable.find((c) => c.id === primaryContactId)?.id ??
      emailable[0]?.id ??
      "",
  );

  useEffect(() => {
    if (providedTargets) return;
    let cancelled = false;
    fetch(`/api/call-list/${entryId}/call-outcome`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { targets?: DialTarget[] } | null) => {
        if (!cancelled) setFetched(data?.targets ?? []);
      })
      .catch(() => {
        if (!cancelled) setFetched([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, providedTargets]);

  const dialable = (targets ?? []).filter((t) => t.allowed);
  const blocked = (targets ?? []).filter((t) => !t.allowed);
  // A single business line needs no picking; derived so the radio reflects it
  // without an effect writing state back on every render pass.
  const dialed = picked || (dialable.length === 1 ? dialable[0].number : "");

  async function logOutcome() {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch(`/api/call-list/${entryId}/call-outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          phone: dialed || null,
          contact_id:
            dialable.find((t) => t.number === dialed)?.contactId ??
            primaryContactId ??
            null,
          notes: notes.trim() || null,
        }),
      });
      const data = (await res.json()) as {
        entry?: CallListEntry;
        error?: string;
      };
      if (!res.ok || !data.entry) {
        setError(data.error ?? "Could not log the call");
        return;
      }
      onEntryChange?.(data.entry);
      setNotes("");
      setFlash(`Logged: ${CALL_OUTCOME_LABELS[outcome]}`);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function sendLink() {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch(`/api/call-list/${entryId}/opt-in-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: recipientId || null }),
      });
      const data = (await res.json()) as {
        send?: { email: string };
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Could not send the opt-in link");
        return;
      }
      setFlash(`Opt-in link emailed to ${data.send?.email ?? "the contact"}`);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <p className="text-sm text-red-700 dark:text-red-400">
        Do Not Contact — calling and opt-in sends are locked for this company.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
          Call
        </p>
        <p className="text-[11px] text-gray-500">
          Business lines only — a human dialing a business landline is exempt
          from the DNC registry under 16 CFR 310.6(b)(7).
        </p>
      </div>

      {targets === null ? (
        <p className="text-xs text-gray-400">Loading numbers…</p>
      ) : targets.length === 0 ? (
        <p className="text-xs text-gray-400">No phone numbers on file.</p>
      ) : (
        <ul className="space-y-1.5">
          {dialable.map((target) => (
            <li
              key={target.number}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name={`dialed-${entryId}`}
                value={target.number}
                checked={dialed === target.number}
                onChange={() => setPicked(target.number)}
                aria-label={`Select ${target.number}`}
                className="border-gray-300"
              />
              <a
                href={`tel:${target.number}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPicked(target.number);
                }}
                className="font-medium text-blue-600 dark:text-blue-400 hover:underline tabular-nums"
              >
                {target.number}
              </a>
              <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                {PHONE_CLASSIFICATION_LABELS[target.classification]}
              </span>
              <span className="text-xs text-gray-500 truncate">
                {target.label}
              </span>
            </li>
          ))}

          {blocked.map((target) => (
            <li
              key={target.number}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span
                className="tabular-nums text-gray-400 line-through"
                title={target.reason ?? undefined}
              >
                {target.number}
              </span>
              <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300">
                Cannot call · {PHONE_CLASSIFICATION_LABELS[target.classification]}
              </span>
              <span className="text-xs text-gray-500 truncate">
                {target.label}
              </span>
              <span className="basis-full text-xs text-red-700 dark:text-red-400">
                {target.reason}
              </span>
            </li>
          ))}
        </ul>
      )}

      {targets !== null && dialable.length === 0 && targets.length > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 px-2.5 py-2 text-xs text-amber-900 dark:text-amber-200">
          No business line on file, so there is nothing here we can call. Email
          the opt-in link instead — a form submission is the only consent that
          lets us text.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,14rem)_1fr] gap-2 items-start pt-1 border-t border-gray-100 dark:border-gray-800">
        <label className="text-xs text-gray-500">
          Outcome
          <select
            value={outcome}
            disabled={busy}
            onChange={(e) => setOutcome(e.target.value as CallOutcomeKind)}
            className="mt-1 block w-full text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900 disabled:opacity-50"
          >
            {CALL_OUTCOMES.map((kind) => (
              <option key={kind} value={kind}>
                {CALL_OUTCOME_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-gray-500">
          Call notes
          <input
            type="text"
            value={notes}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was said, who to ask for next time…"
            className="mt-1 block w-full text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={logOutcome}
          className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 hover:opacity-90 disabled:opacity-50"
        >
          Log call
        </button>

        {emailable.length > 1 && (
          <select
            value={recipientId}
            disabled={busy}
            onChange={(e) => setRecipientId(e.target.value)}
            aria-label="Opt-in link recipient"
            className="text-xs border border-gray-200 dark:border-gray-700 rounded-md px-1.5 py-1.5 bg-white dark:bg-gray-900"
          >
            {emailable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {contactEmail(c)}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          disabled={busy || emailable.length === 0}
          onClick={sendLink}
          title={
            emailable.length === 0
              ? "No contact with an email address on file"
              : "Email the consent form — the call's job is to earn a form click, not to capture consent"
          }
          className="px-2.5 py-1.5 rounded-md text-xs font-medium border border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 disabled:opacity-50"
        >
          Send opt-in link
        </button>
      </div>

      {flash && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">{flash}</p>
      )}
      {error && (
        <p className="text-xs text-red-700 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
