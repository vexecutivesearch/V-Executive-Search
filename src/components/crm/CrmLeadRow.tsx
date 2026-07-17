"use client";

import { useState } from "react";
import Link from "next/link";
import type { CompanyCardData } from "@/components/CompanyCard";
import type { CrmLeadRow as CrmLeadRowData } from "@/lib/crm-queries";
import {
  AddToCallListButton,
  AddToCallListPrompt,
  OnCallListBadge,
} from "@/components/AddToCallListButton";
import { CallControls } from "./CallControls";
import { ContactPickerButton } from "@/components/enrich/ContactPickerButton";
import { ContactRow } from "@/components/ContactRow";
import { StatusBadge, StatusSelect } from "@/components/StatusBadge";
import {
  contactIsCallable,
  scoreBgClass,
  scoreTextClass,
} from "@/lib/lead-score";
import { sectorFromIndustry } from "@/lib/industry-sectors";
import { parseJobLocation } from "@/lib/location-match";
import { formatListingSalary, pickDisplayListing } from "@/lib/salary-format";

export function CrmLeadRow({ row }: { row: CrmLeadRowData }) {
  const [company, setCompany] = useState<CompanyCardData>(row);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [onList, setOnList] = useState(row.onCallList);
  const [showAddPrompt, setShowAddPrompt] = useState(false);
  const [openerBusy, setOpenerBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const primaryJob = company.jobListings[0];
  const salaryJob = pickDisplayListing(company.jobListings);
  const salary = salaryJob ? formatListingSalary(salaryJob) : null;
  const callableCount = company.contacts.filter(contactIsCallable).length;
  const hasCallable = callableCount > 0;
  const discoveredCount = company.contacts.filter(
    (c) => c.revealStatus === "discovered",
  ).length;
  const hotSignals = Object.keys(company.hiringSignals ?? {}).length > 0;
  const sector = sectorFromIndustry(company.industry);
  const jobLocation =
    primaryJob?.location ||
    company.contacts.find((c) => c.jobLocation)?.jobLocation ||
    null;
  const locationLabel = jobLocation
    ? (parseJobLocation(jobLocation)?.label ?? jobLocation)
    : null;
  const score = company.leadScore ?? 0;

  async function handleEnrichComplete(
    updated?: CompanyCardData,
    summary?: string,
  ) {
    let latest = updated ?? null;
    if (!latest) {
      const res = await fetch(`/api/companies/${row.id}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { company: CompanyCardData };
        latest = data.company;
      }
    }
    if (latest) setCompany(latest);
    setExpanded(true);
    if (summary) setNotice(summary);

    if (!onList && (latest ?? company).contacts.some(contactIsCallable)) {
      setShowAddPrompt(true);
    }
  }

  function handlePromptAnswer(added: boolean) {
    setShowAddPrompt(false);
    if (added) {
      setOnList(true);
      setNotice("Added to Call List — Ready to Call");
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
        setNotice(data.error);
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
      <div className="grid grid-cols-[3rem_1fr_auto] sm:grid-cols-[3.5rem_minmax(0,1.3fr)_minmax(0,1.3fr)_7rem_5rem_auto] gap-x-3 gap-y-1 items-center px-3 py-2.5 sm:px-4 hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors">
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
            className={`flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-lg text-sm font-semibold tabular-nums ${scoreBgClass(score)} ${scoreTextClass(score)}`}
          >
            {score}
          </div>

          <div className="min-w-0 text-left">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Link
                href={`/companies/${company.id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-medium truncate hover:underline"
              >
                {company.name}
              </Link>
              {onList && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                  On list
                </span>
              )}
              {hotSignals && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300">
                  Hot
                </span>
              )}
              {hasCallable && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                  Enriched
                </span>
              )}
              {discoveredCount > 0 && (
                <span
                  className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300"
                  title={`${discoveredCount} candidate${discoveredCount === 1 ? "" : "s"} discovered (reveal-off) — pick one to reveal`}
                >
                  Discovered {discoveredCount}
                </span>
              )}
              {row.icp && row.icp.adjustedScore != null && (
                <span
                  className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-50 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200"
                  title={
                    row.icp.flags.length
                      ? `ICP ${row.icp.baseScore ?? "?"} → ${row.icp.adjustedScore} · ${row.icp.flags.join(", ")}`
                      : `ICP ${row.icp.baseScore ?? "?"} → ${row.icp.adjustedScore} · no exclusion flags`
                  }
                >
                  ICP {row.icp.adjustedScore}
                </span>
              )}
              {row.icp?.roleType && row.icp.roleType !== "unknown" && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 capitalize">
                  {row.icp.roleType}
                </span>
              )}
              {row.icp?.compAnnualMax != null && (
                <span
                  className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${
                    row.icp.compEstimated
                      ? "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                  }`}
                  title={
                    row.icp.compEstimated
                      ? `Estimated from title (${row.icp.compConfidence ?? "low"} confidence)`
                      : "From the job listing"
                  }
                >
                  {row.icp.compEstimated ? "est. " : ""}$
                  {Math.round(row.icp.compAnnualMax / 1000)}k
                </span>
              )}
              {company.reasonToCall && (
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
                  {salary ? ` · ${salary}` : ""}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-400 italic">No active job</p>
            )}
          </div>

          <div className="hidden sm:block min-w-0 text-left">
            {locationLabel ? (
              <span className="text-xs text-gray-600 dark:text-gray-300 truncate block">
                {locationLabel}
              </span>
            ) : (
              <span className="text-xs text-gray-400 italic">
                Location unavailable
              </span>
            )}
          </div>

          <div className="hidden sm:block text-sm text-gray-600 dark:text-gray-400 tabular-nums text-left">
            {company.contacts.length > 0 ? (
              `${callableCount}/${company.contacts.length}`
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-1">
          {/* Action progression: Find contacts → Add to list → Open (dossier). */}
          {onList ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 whitespace-nowrap"
            >
              Open
            </button>
          ) : hasCallable ? (
            <AddToCallListButton
              companyId={company.id}
              compact
              onAdded={() => setOnList(true)}
            />
          ) : (
            <ContactPickerButton
              companyId={company.id}
              compact
              onRevealComplete={handleEnrichComplete}
            />
          )}
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
          {locationLabel ? ` · ${locationLabel}` : ""}
        </button>
      </div>

      {showAddPrompt && (
        <div className="mx-4 mb-2">
          <AddToCallListPrompt
            companyId={company.id}
            onAnswer={handlePromptAnswer}
          />
        </div>
      )}

      {notice && (
        <div className="mx-4 mb-2 rounded-md border border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200 px-3 py-2 text-sm">
          {notice}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-gray-50/80 dark:bg-gray-900/40 border-t border-gray-100 dark:border-gray-800">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <StatusBadge status={company.status} />
            <StatusSelect
              companyId={company.id}
              currentStatus={company.status}
              onStatusChange={(status) => setCompany((c) => ({ ...c, status }))}
            />
            {onList ? (
              <OnCallListBadge />
            ) : (
              hasCallable && (
                <AddToCallListButton
                  companyId={company.id}
                  compact
                  onAdded={() => setOnList(true)}
                />
              )
            )}
            <ContactPickerButton
              companyId={company.id}
              compact
              label={hasCallable ? "Enrich another contact" : "Find contacts"}
              onRevealComplete={handleEnrichComplete}
            />
          </div>

          {company.reasonToCall && (
            <div className="mb-3 rounded-lg border border-orange-200 dark:border-orange-900 bg-orange-50/70 dark:bg-orange-950/30 px-3 py-2 text-sm text-orange-900 dark:text-orange-200">
              <span className="text-[10px] font-medium uppercase tracking-wide mr-2">
                Hiring signal
              </span>
              {company.reasonToCall}
              {primaryJob?.location ? ` · ${primaryJob.location}` : ""}
            </div>
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

          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
            {company.industry && (
              <span title={company.industry}>
                Industry: {sector ?? company.industry}
                {company.enrichedAt ? "" : " (coarse)"}
              </span>
            )}
            {salary && <span>Salary: {salary}</span>}
            <span>First seen: {company.firstSeen}</span>
            <span>Location: {locationLabel ?? "unavailable"}</span>
            {company.sourceMarket && (
              <span>Source market: {company.sourceMarket}</span>
            )}
          </div>

          {primaryJob && (
            <div className="mb-3 p-3 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-sm">
              <p className="font-medium">{primaryJob.title}</p>
              <p className="text-gray-500 dark:text-gray-400 mt-0.5">
                {primaryJob.board}
                {primaryJob.location ? ` · ${primaryJob.location}` : ""}
                {salary ? ` · ${salary}` : ""}
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
              {company.jobListings.length > 1 && (
                <p className="text-xs text-gray-400 mt-1">
                  +{company.jobListings.length - 1} more active listing
                  {company.jobListings.length - 1 === 1 ? "" : "s"}
                </p>
              )}
            </div>
          )}

          {company.contacts.length > 0 ? (
            <div className="space-y-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 p-3">
              {company.contacts.map((c) => (
                <ContactRow key={c.id} contact={c} jobLocation={jobLocation} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">
              No contacts enriched yet — Enrich pulls Apollo/ContactOut contacts.
            </p>
          )}

          {onList && (
            <div className="mt-3">
              <CallControls companyId={company.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
