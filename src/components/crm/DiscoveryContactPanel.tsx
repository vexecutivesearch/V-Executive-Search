"use client";

import { ContactRow } from "@/components/ContactRow";
import type { Contact } from "@/lib/db/schema";
import type { RevealOutcome } from "@/lib/discovery/reveal-outcome";
import { contactIsCallable } from "@/lib/lead-score";

const OUTCOME_CLASS: Record<RevealOutcome["tone"], string> = {
  success:
    "border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200",
  warning:
    "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  error:
    "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
};

/** Discovered but unrevealed — no email/phone credit has been spent on them. */
function isUnrevealed(contact: Contact): boolean {
  return contact.revealStatus === "discovered" && !contactIsCallable(contact);
}

export type DiscoveryContactPanelProps = {
  panelId: string;
  /** Contacts as the profile page sees them, or null before the first load. */
  contacts: Contact[] | null;
  jobLocation: string | null;
  loading: boolean;
  loadError: string | null;
  /** A reveal is in flight — the row must show work happening, not a refresh. */
  pending: boolean;
  pendingLabel: string;
  outcome: RevealOutcome | null;
  costNote: string | null;
  onFindAdditional: () => void;
  additionalBusy: boolean;
};

/**
 * The expandable half of a discovery review row: who exists at the company,
 * who has been revealed, and what the last reveal actually did.
 *
 * Deliberately the same idiom as the expanded CrmLeadRow — a panel under the
 * row, contacts rendered by the shared `ContactRow` so the badges
 * (DISCOVERED — NOT REVEALED, CONTACTOUT · MOBILE, DO NOT CALL, MX ✓) are
 * literally the profile page's. Add to Call List stays on the row's own action
 * bar, which is still visible when the panel is open, so there is one of it.
 */
export function DiscoveryContactPanel({
  panelId,
  contacts,
  jobLocation,
  loading,
  loadError,
  pending,
  pendingLabel,
  outcome,
  costNote,
  onFindAdditional,
  additionalBusy,
}: DiscoveryContactPanelProps) {
  const all = contacts ?? [];
  const revealed = all.filter((c) => !isUnrevealed(c));
  const unrevealed = all.filter(isUnrevealed);

  return (
    <div
      id={panelId}
      className="mt-3 -mx-4 -mb-4 px-4 py-3 rounded-b-xl bg-gray-50/80 dark:bg-gray-900/40 border-t border-gray-100 dark:border-gray-800"
    >
      {pending && (
        <p
          role="status"
          className="mb-3 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <span
            className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
            aria-hidden
          />
          {pendingLabel}
        </p>
      )}

      {outcome && (
        <div
          role={outcome.tone === "error" ? "alert" : "status"}
          className={`mb-3 rounded-md border px-3 py-2 text-sm ${OUTCOME_CLASS[outcome.tone]}`}
        >
          <p className="font-medium">{outcome.headline}</p>
          {outcome.details.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs">
              {outcome.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {costNote && <p className="mb-3 text-[11px] text-gray-500">{costNote}</p>}

      {loadError && (
        <p className="mb-3 text-xs text-red-700 dark:text-red-400">
          {loadError}
        </p>
      )}

      {loading || contacts === null ? (
        <p className="text-sm text-gray-500">Loading contacts…</p>
      ) : all.length === 0 ? (
        <p className="text-sm text-gray-500">
          No contacts on file yet. Approve for enrichment runs a reveal-off
          Apollo search first, then spends one credit on the single
          highest-priority decision-maker.
        </p>
      ) : (
        <div className="space-y-3">
          {revealed.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 mb-1.5">
                Revealed ({revealed.length})
              </p>
              <div className="space-y-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 p-3">
                {revealed.map((contact) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    jobLocation={jobLocation}
                  />
                ))}
              </div>
            </div>
          )}

          {unrevealed.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 mb-1.5">
                Found, not yet revealed ({unrevealed.length}) — no credits spent
              </p>
              <div className="space-y-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 p-3">
                {unrevealed.map((contact) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    jobLocation={jobLocation}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {revealed.length > 0 && (
          <button
            type="button"
            disabled={additionalBusy || pending}
            onClick={onFindAdditional}
            title="Reveals exactly one more decision-maker — one extra credit, never automatic"
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-50"
          >
            {additionalBusy ? "Finding…" : "Find additional contact"}
          </button>
        )}
      </div>
    </div>
  );
}
