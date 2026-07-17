"use client";

import { useMemo, useState } from "react";
import type { CompanyCardData } from "@/components/CompanyCard";

type Candidate = {
  contactId: string;
  name: string;
  title: string | null;
  linkedinUrl: string | null;
  contactLocation: string | null;
  locationMatched: boolean;
  revealStatus: "discovered" | "revealed" | "legacy";
  isPrimary: boolean;
  priorityRank: number;
  alreadyCallable: boolean;
};

type DiscoveryResponse = {
  candidates?: Candidate[];
  cached?: boolean;
  sector?: string;
  sizeBand?: string;
  usedUnion?: boolean;
  usedFallback?: boolean;
  searchesSpent?: number;
  cost_note?: string;
  error?: string;
};

type RevealResponse = {
  ok?: boolean;
  revealed?: number;
  emailsFound?: number;
  phonesFound?: number;
  skippedAlreadyRevealed?: number;
  company?: CompanyCardData;
  message?: string;
  error?: string;
};

/**
 * Discovery → reveal-on-selection (Feature 1).
 *
 * "Find contacts" runs a reveal-off search (cached per company — the search
 * credit is paid once, ever) and opens a picker of candidates ranked by
 * decision-maker relevance. Reveal credits are spent only on the selected
 * contact(s); phone is opt-in per contact; saved contacts are never
 * re-charged. The cost preview shows BOTH the search and reveal cost.
 */
export function ContactPickerButton({
  companyId,
  compact = false,
  label = "Find contacts",
  onRevealComplete,
}: {
  companyId: string;
  compact?: boolean;
  label?: string;
  onRevealComplete?: (
    company?: CompanyCardData,
    summary?: string,
  ) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phoneFor, setPhoneFor] = useState<Set<string>>(new Set());

  const candidates = useMemo(
    () => discovery?.candidates ?? [],
    [discovery],
  );

  async function runDiscovery(force = false) {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = (await res.json()) as DiscoveryResponse;
      if (!res.ok) {
        setError(data.error ?? "Discovery failed");
        return;
      }
      setDiscovery(data);

      // Default = single best contact pre-selected (top unrevealed candidate).
      const best =
        (data.candidates ?? []).find(
          (c) => c.isPrimary && c.revealStatus === "discovered",
        ) ?? (data.candidates ?? []).find((c) => c.revealStatus === "discovered");
      setSelected(best ? new Set([best.contactId]) : new Set());
      setPhoneFor(new Set());
    } catch {
      setError("Network error — could not reach discovery API");
    } finally {
      setLoading(false);
    }
  }

  async function handleOpen(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
    if (!discovery) await runDiscovery(false);
  }

  function toggleSelected(contactId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) {
        next.delete(contactId);
        setPhoneFor((p) => {
          const np = new Set(p);
          np.delete(contactId);
          return np;
        });
      } else {
        next.add(contactId);
      }
      return next;
    });
  }

  function togglePhone(contactId: string) {
    setPhoneFor((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }

  async function handleReveal() {
    if (!selected.size) return;
    setRevealBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selections: [...selected].map((contactId) => ({
            contact_id: contactId,
            channels: phoneFor.has(contactId) ? "email_phone" : "email",
          })),
        }),
      });
      const data = (await res.json()) as RevealResponse;
      if (!res.ok) {
        setError(data.error ?? "Reveal failed");
        return;
      }
      setNotice(data.message ?? "Revealed");
      // Refresh candidate statuses from cache (free) so badges update.
      await runDiscovery(false);
      if (onRevealComplete) {
        await onRevealComplete(data.company, data.message);
      }
    } catch {
      setError("Network error — could not reach reveal API");
    } finally {
      setRevealBusy(false);
    }
  }

  const selectableCount = candidates.filter(
    (c) => c.revealStatus === "discovered",
  ).length;
  const phoneCount = phoneFor.size;
  const emailCount = selected.size;

  const costPreview = discovery
    ? [
        discovery.cached
          ? "Discovery: cached — search credit already spent, none charged"
          : `Discovery: ${discovery.searchesSpent ?? 1} search credit${(discovery.searchesSpent ?? 1) === 1 ? "" : "s"} spent`,
        emailCount > 0
          ? `Reveal ${emailCount}: up to ${emailCount} email credit${emailCount === 1 ? "" : "s"}${phoneCount > 0 ? ` + ${phoneCount} phone reveal${phoneCount === 1 ? "" : "s"}` : ""}`
          : "Reveal: nothing selected — 0 credits",
      ].join(" · ")
    : null;

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title="Discovery is reveal-off (search credit only, cached). Reveal credits are spent only on the contacts you pick."
        className={`rounded-md font-medium transition-colors whitespace-nowrap bg-green-700 text-white hover:bg-green-800 ${
          compact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
        }`}
      >
        {label}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">Pick contacts to reveal</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {discovery
                    ? [
                        discovery.sector && discovery.sector !== "default"
                          ? `${discovery.sector} targeting`
                          : "generic decision-maker targeting",
                        discovery.sizeBand === "unknown"
                          ? "size unknown — searched both size lists in one pass"
                          : `${discovery.sizeBand} firm`,
                        discovery.usedFallback
                          ? "fallback: generic decision-makers"
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Reveal-off discovery — no email/phone credits spent"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
                aria-label="Close picker"
              >
                ×
              </button>
            </div>

            <div className="p-4 space-y-2">
              {loading && (
                <p className="text-sm text-gray-500">Discovering candidates…</p>
              )}
              {error && (
                <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
              )}
              {notice && (
                <p className="text-sm text-green-700 dark:text-green-400">
                  {notice}
                </p>
              )}

              {!loading && discovery && candidates.length === 0 && (
                <p className="text-sm text-gray-500">
                  No candidates found — try re-running discovery.
                </p>
              )}

              {candidates.map((c) => {
                const isSelectable = c.revealStatus === "discovered";
                const isChecked = selected.has(c.contactId);
                return (
                  <div
                    key={c.contactId}
                    className={`rounded-lg border px-3 py-2 ${
                      isChecked
                        ? "border-green-600 bg-green-50/50 dark:bg-green-950/20"
                        : "border-gray-200 dark:border-gray-800"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      {isSelectable ? (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelected(c.contactId)}
                          className="mt-1 rounded border-gray-300"
                          aria-label={`Select ${c.name}`}
                        />
                      ) : (
                        <span
                          className="mt-0.5 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                          title="Already saved — free to view, never re-charged"
                        >
                          saved
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {c.name}
                          {c.isPrimary && (
                            <span className="ml-2 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
                              best contact
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {c.title ?? "—"}
                        </p>
                        {c.locationMatched ? (
                          <p className="text-[11px] text-green-700 dark:text-green-400">
                            In market{c.contactLocation ? ` (${c.contactLocation})` : ""}
                          </p>
                        ) : (
                          <p className="text-[11px] text-amber-700 dark:text-amber-400">
                            {c.contactLocation
                              ? `Contact in ${c.contactLocation}`
                              : "Location not verified"}{" "}
                            — may be the wrong office
                          </p>
                        )}
                      </div>
                      {c.linkedinUrl && (
                        <a
                          href={
                            c.linkedinUrl.startsWith("http")
                              ? c.linkedinUrl
                              : `https://www.linkedin.com/in/${c.linkedinUrl}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          LinkedIn →
                        </a>
                      )}
                    </div>
                    {isChecked && (
                      <label className="mt-1.5 ml-6 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={phoneFor.has(c.contactId)}
                          onChange={() => togglePhone(c.contactId)}
                          className="rounded border-gray-300"
                        />
                        Also reveal phone (scarcest credit — opt-in)
                      </label>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-800 space-y-2">
              {costPreview && (
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {costPreview}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={loading || revealBusy}
                  onClick={() => runDiscovery(true)}
                  title="Explicit corrective re-discovery — spends one more search credit"
                  className="text-xs text-gray-500 hover:underline disabled:opacity-50"
                >
                  Re-run discovery (1 search credit)
                </button>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">
                    {selected.size}/{selectableCount} selected
                  </span>
                  <button
                    type="button"
                    disabled={revealBusy || selected.size === 0}
                    onClick={handleReveal}
                    className="px-3 py-1.5 rounded-md text-sm font-medium bg-green-700 text-white hover:bg-green-800 disabled:opacity-50"
                  >
                    {revealBusy
                      ? "Revealing…"
                      : `Reveal ${selected.size || ""} contact${selected.size === 1 ? "" : "s"}`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
