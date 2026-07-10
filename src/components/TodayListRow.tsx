"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CompanyCardData } from "./CompanyCard";
import { ContactRow } from "./ContactRow";
import { EnrichButton } from "./EnrichButton";
import { StatusBadge, StatusSelect } from "./StatusBadge";
import {
  contactIsCallable,
  scoreBgClass,
  scoreLead,
  scoreTextClass,
} from "@/lib/lead-score";
import { isNewToday } from "@/lib/new-today";

export function TodayListRow({
  company: initial,
  defaultExpanded = false,
  rank,
  showReasonToCall = false,
  listMode = "call-sheet",
}: {
  company: CompanyCardData;
  defaultExpanded?: boolean;
  rank?: number;
  showReasonToCall?: boolean;
  listMode?: "call-sheet" | "backlog";
}) {
  const router = useRouter();
  const [company, setCompany] = useState(initial);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [enrichNotice, setEnrichNotice] = useState<string | null>(null);
  const [openerBusy, setOpenerBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCompany(initial);
  }, [initial]);

  const linkedInJob =
    company.jobListings.find(
      (j) => j.board?.toLowerCase() === "linkedin" && j.posterName,
    ) ??
    company.jobListings.find((j) => j.board?.toLowerCase() === "linkedin");
  // Call sheet prefers LinkedIn (poster path). Backlog shows the top listing as-is
  // so Indeed/Google/Zip rows are visible, not hidden behind a LinkedIn preference.
  const primaryJob =
    listMode === "backlog"
      ? company.jobListings[0]
      : (linkedInJob ?? company.jobListings[0]);
  const posterContacts = company.contacts.filter(
    (c) => c.sourceProvider === "linkedin_poster",
  );
  const listingPoster =
    primaryJob?.posterName && primaryJob.posterLinkedinUrl
      ? {
          name: primaryJob.posterName,
          title: primaryJob.posterTitle,
          linkedinUrl: primaryJob.posterLinkedinUrl,
        }
      : null;
  const jobLocation =
    primaryJob?.location ||
    company.contacts.find((c) => c.jobLocation)?.jobLocation ||
    null;
  const lead = scoreLead(company);
  const displayScore = company.leadScore ?? lead.score;
  const showNewToday = isNewToday({
    companyFirstSeen: company.firstSeen,
    listings: company.jobListings,
  });

  async function refreshCompany(updated?: CompanyCardData) {
    if (updated) {
      setCompany(updated);
      return;
    }
    const res = await fetch(`/api/companies/${initial.id}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as { company: CompanyCardData };
      setCompany(data.company);
    }
  }

  async function handleEnrichComplete(
    updated?: CompanyCardData,
    summary?: string,
  ) {
    await refreshCompany(updated);
    setExpanded(true);
    if (summary) setEnrichNotice(summary);

    const latest = updated ?? company;
    const promoted = latest.contacts.some(contactIsCallable);
    if (promoted) {
      router.refresh();
      if (listMode === "backlog") {
        const params = new URLSearchParams(window.location.search);
        params.delete("tab");
        const qs = params.toString();
        router.push(qs ? `/today?${qs}` : "/today");
      }
    }
  }

  async function generateOpener(force = false) {
    setOpenerBusy(true);
    try {
      const res = await fetch(`/api/companies/${company.id}/generate-opener`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = (await res.json()) as {
        call_opener?: string;
        error?: string;
      };
      if (res.ok && data.call_opener) {
        setCompany((c) => ({ ...c, callOpener: data.call_opener }));
      } else if (data.error) {
        setEnrichNotice(data.error);
      }
    } finally {
      setOpenerBusy(false);
    }
  }

  async function copyOpener() {
    if (!company.callOpener) return;
    await navigator.clipboard.writeText(company.callOpener);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 last:border-b-0">
      <div className="grid grid-cols-[3rem_1fr_auto] sm:grid-cols-[3.5rem_minmax(0,1.2fr)_minmax(0,1.4fr)_5rem_6.5rem_auto] gap-x-3 gap-y-1 items-center px-3 py-2.5 sm:px-4 hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          className="contents cursor-pointer"
          aria-expanded={expanded}
        >
          <div
            className={`flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-lg text-sm font-semibold tabular-nums ${scoreBgClass(displayScore)} ${scoreTextClass(displayScore)}`}
          >
            {displayScore}
          </div>

          <div className="min-w-0 col-span-1 sm:col-span-1 text-left">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Link
                href={`/companies/${company.id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-medium truncate hover:underline"
              >
                {company.name}
              </Link>
              {showNewToday && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                  New today
                </span>
              )}
              {lead.geoMismatch && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300">
                  Geo mismatch
                </span>
              )}
              {company.domainConfidence === "low" && (
                <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                  unverified domain
                </span>
              )}
              {showReasonToCall && company.reasonToCall && (
                <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200 max-w-[14rem] truncate">
                  {company.reasonToCall}
                </span>
              )}
            </div>
            {company.domain && (
              <p className="text-xs text-gray-500 truncate">{company.domain}</p>
            )}
          </div>

          <div className="hidden sm:block min-w-0 text-left">
            {primaryJob ? (
              <>
                <p className="text-sm truncate">{primaryJob.title}</p>
                <p className="text-xs text-gray-500 truncate">
                  {primaryJob.board}
                  {primaryJob.location ? ` · ${primaryJob.location}` : ""}
                  {primaryJob.posterName
                    ? ` · Hiring team: ${primaryJob.posterName}`
                    : ""}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-400 italic">No job</p>
            )}
          </div>

          <div className="hidden sm:block text-sm text-gray-600 dark:text-gray-400 tabular-nums text-left">
            {company.contacts.length > 0 ? (
              <>
                {lead.callableCount}/{company.contacts.length}
                {posterContacts.length > 0 && lead.callableCount === 0 && (
                  <span className="block text-[10px] text-indigo-600 dark:text-indigo-300">
                    {posterContacts.length} hiring team
                  </span>
                )}
              </>
            ) : listingPoster ? (
              <span className="text-indigo-600 dark:text-indigo-300 text-xs">
                Hiring team
              </span>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </div>

          <div className="hidden sm:flex justify-end">
            <StatusBadge status={company.status} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-1">
          <EnrichButton
            companyId={company.id}
            contactCount={company.contacts.length}
            onEnrichComplete={handleEnrichComplete}
          />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={expanded ? "Collapse row" : "Expand row"}
          >
            <span
              className={`inline-block transition-transform ${expanded ? "rotate-180" : ""}`}
              aria-hidden
            >
              ▾
            </span>
          </button>
        </div>
      </div>

      <div className="sm:hidden px-3 pb-2 pl-[3.75rem] text-xs text-gray-500">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-left w-full"
        >
          {primaryJob?.title}
          {primaryJob?.location ? ` · ${primaryJob.location}` : ""}
          {company.contacts.length > 0 && (
            <span className="ml-2">
              · {lead.callableCount}/{company.contacts.length} contacts
            </span>
          )}
        </button>
      </div>

      {enrichNotice && (
        <div
          className={`mx-4 mb-2 rounded-md border px-3 py-2 text-sm ${
            enrichNotice.includes("error") ||
            enrichNotice.includes("failed") ||
            enrichNotice.includes("not configured")
              ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              : enrichNotice.includes("+") ||
                  enrichNotice.includes("updated") ||
                  enrichNotice.includes("synced")
                ? "border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
                : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          }`}
        >
          {enrichNotice}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-gray-50/80 dark:bg-gray-900/40 border-t border-gray-100 dark:border-gray-800">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3 sm:hidden">
            <StatusBadge status={company.status} />
            <StatusSelect
              companyId={company.id}
              currentStatus={company.status}
              onStatusChange={(status) =>
                setCompany((c) => ({ ...c, status }))
              }
            />
          </div>

          {primaryJob && (
            <div className="mb-3 p-3 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-sm">
              <p className="font-medium">{primaryJob.title}</p>
              <p className="text-gray-500 dark:text-gray-400 mt-0.5">
                {primaryJob.board}
                {primaryJob.location ? ` · ${primaryJob.location}` : ""}
              </p>
              {primaryJob.url && (
                <a
                  href={primaryJob.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block text-xs"
                >
                  View posting →
                </a>
              )}
            </div>
          )}

          {lead.bestContactLabel && (
            <p className="text-xs text-gray-500 mb-2">
              Best contact:{" "}
              <span className="text-gray-700 dark:text-gray-300">
                {lead.bestContactLabel}
              </span>
            </p>
          )}

          <div className="mb-3 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-xs font-medium uppercase tracking-wide text-blue-800 dark:text-blue-200">
                Suggested opener
              </p>
              <div className="flex gap-2">
                {company.callOpener && (
                  <button
                    type="button"
                    onClick={copyOpener}
                    className="text-xs text-blue-700 dark:text-blue-300 hover:underline"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={openerBusy}
                  onClick={() => generateOpener(Boolean(company.callOpener))}
                  className="text-xs text-blue-700 dark:text-blue-300 hover:underline disabled:opacity-50"
                >
                  {openerBusy
                    ? "Generating…"
                    : company.callOpener
                      ? "Regenerate"
                      : "Generate"}
                </button>
              </div>
            </div>
            {company.callOpener ? (
              <p className="text-sm text-blue-950 dark:text-blue-100 leading-relaxed">
                {company.callOpener}
              </p>
            ) : (
              <p className="text-sm text-blue-800/70 dark:text-blue-200/70 italic">
                Generate a personalized opener from the hiring signal and job
                posting.
              </p>
            )}
          </div>

          {company.contacts.length > 0 ? (
            <div className="space-y-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 p-3">
              {company.contacts.map((c) => (
                <ContactRow key={c.id} contact={c} jobLocation={jobLocation} />
              ))}
            </div>
          ) : listingPoster ? (
            <div className="mb-3 rounded-lg border border-indigo-200 dark:border-indigo-900 bg-indigo-50/60 dark:bg-indigo-950/30 p-3 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-indigo-800 dark:text-indigo-200 mb-1">
                LinkedIn hiring team
              </p>
              <p className="font-medium">{listingPoster.name}</p>
              {listingPoster.title && (
                <p className="text-gray-600 dark:text-gray-400 text-xs mt-0.5">
                  {listingPoster.title}
                </p>
              )}
              <a
                href={
                  listingPoster.linkedinUrl.startsWith("http")
                    ? listingPoster.linkedinUrl
                    : `https://www.linkedin.com/in/${listingPoster.linkedinUrl}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline text-xs mt-2 inline-block"
              >
                View LinkedIn profile →
              </a>
              <p className="text-xs text-gray-500 mt-2">
                Use Enrich contacts to pull email/phone via ContactOut from this
                profile.
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">No contacts enriched yet</p>
          )}

          <div className="hidden sm:flex items-center gap-2 mt-3">
            <StatusSelect
              companyId={company.id}
              currentStatus={company.status}
              onStatusChange={(status) =>
                setCompany((c) => ({ ...c, status }))
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
