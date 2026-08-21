"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AddToCallListButton } from "@/components/AddToCallListButton";
import type { CompanyReviewStatus } from "@/lib/db/schema";
import {
  canAddToCallList,
  REVIEW_STATUS_LABELS as STATUS_LABELS,
} from "@/lib/discovery/review-actions";
import type { ReviewQueueRow } from "@/lib/discovery/review-queue";
import { verticalBadgeLabel } from "@/lib/discovery/vertical-evidence";

const REVIEW_ACTIONS: Array<{
  status: CompanyReviewStatus;
  label: string;
  tone: "neutral" | "danger";
}> = [
  { status: "rejected", label: "Reject", tone: "danger" },
  { status: "review_later", label: "Review later", tone: "neutral" },
  { status: "already_contacted", label: "Already contacted", tone: "neutral" },
  { status: "existing_client", label: "Existing client", tone: "neutral" },
  { status: "do_not_contact", label: "Do not contact", tone: "danger" },
];

function linkedInHref(url: string): string {
  return url.startsWith("http") ? url : `https://${url.replace(/^\/+/, "")}`;
}

/**
 * The vertical badge asserts the vertical only when the company's own Apollo
 * industry or name backs it. Otherwise it says how the company was FOUND,
 * which is all discovery actually knows.
 */
const VERTICAL_BADGE_CLASS: Record<ReviewQueueRow["verticalEvidence"]["status"], string> = {
  confirmed:
    "bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200",
  unverified:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  contradicted:
    "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-200",
};

export function DiscoveryReviewRow({ row }: { row: ReviewQueueRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mobile is an explicit opt-in and comes from ContactOut only — see
  // lib/enrich/single-contact.ts.
  const [includePhone, setIncludePhone] = useState(false);

  async function review(status: CompanyReviewStatus) {
    setBusy(status);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/companies/${row.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Review failed");
        return;
      }
      setNotice(`Marked ${STATUS_LABELS[status].toLowerCase()}`);
      router.refresh();
    } catch {
      setError("Network error — review not saved");
    } finally {
      setBusy(null);
    }
  }

  async function enrich(additional: boolean) {
    setBusy(additional ? "additional" : "approve");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/companies/${row.id}/approve-enrichment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_phone: includePhone, additional }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Enrichment failed");
        return;
      }
      setNotice(data.message ?? "Enriched");
      router.refresh();
    } catch {
      setError("Network error — enrichment did not run");
    } finally {
      setBusy(null);
    }
  }

  const sizeLabel =
    row.estimatedEmployees == null
      ? "size unknown"
      : `${row.estimatedEmployees.toLocaleString()} employees`;
  const location = [row.city, row.stateAbbr ?? row.state]
    .filter(Boolean)
    .join(", ");
  const evidence = row.verticalEvidence;
  const verticalBadge = verticalBadgeLabel(row.verticalLabel, evidence.status);
  const industryLabel = !row.industry
    ? "Industry unknown"
    : row.industryIsRollup
      ? `${row.industry} (pipeline rollup — no Apollo industry)`
      : row.industry;
  const hasContact = row.revealedContactCount > 0;
  const addable = canAddToCallList(row.reviewStatus);

  return (
    <article className="border border-gray-200 dark:border-gray-800 rounded-xl p-4 bg-white dark:bg-gray-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/companies/${row.id}`}
              className="font-semibold hover:underline break-words"
            >
              {row.name}
            </Link>
            {verticalBadge && (
              <span
                title={evidence.reason}
                className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${
                  VERTICAL_BADGE_CLASS[evidence.status]
                }`}
              >
                {verticalBadge}
              </span>
            )}
            {row.sizeUnknown && (
              <span
                className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
                title="Apollo has no headcount for this company — surfaced rather than filtered out"
              >
                size unknown
              </span>
            )}
            {row.reviewStatus !== "pending" && (
              <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {STATUS_LABELS[row.reviewStatus]}
              </span>
            )}
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {[industryLabel, location || "Location unknown", sizeLabel]
              .filter(Boolean)
              .join(" · ")}
          </p>

          {evidence.status !== "confirmed" && row.verticalLabel && (
            <p
              className={`text-xs mt-1 ${
                evidence.status === "contradicted"
                  ? "text-red-700 dark:text-red-400"
                  : "text-gray-500"
              }`}
            >
              {evidence.reason}
            </p>
          )}

          <p className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {row.website ? (
              <a
                href={row.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {row.domain}
              </a>
            ) : (
              <span>no website</span>
            )}
            {row.phone ? <span>☎ {row.phone}</span> : <span>no main phone</span>}
            {row.linkedinUrl ? (
              <a
                href={linkedInHref(row.linkedinUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Company LinkedIn →
              </a>
            ) : (
              <span>no LinkedIn</span>
            )}
            {row.market && <span>{row.market}</span>}
          </p>

          <p className="text-xs mt-1">
            {row.jobSignal.label ? (
              <span className="text-green-700 dark:text-green-400">
                {row.jobSignal.openPositions} open position
                {row.jobSignal.openPositions === 1 ? "" : "s"} ·{" "}
                {row.jobSignal.label}
              </span>
            ) : (
              <span className="text-gray-500">
                No job postings on file — hiring is a signal, not a requirement
              </span>
            )}
          </p>

          {row.icpFlags.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              ICP flags: {row.icpFlags.join(", ")}
            </p>
          )}

          {row.primaryContact && (
            <p className="text-xs text-gray-700 dark:text-gray-300 mt-1.5">
              {row.primaryContact.name}
              {row.primaryContact.title ? ` · ${row.primaryContact.title}` : ""}
              {row.primaryContact.email ? ` · ${row.primaryContact.email}` : ""}
              {row.primaryContact.emailDeliverable === true
                ? " (verified)"
                : row.primaryContact.emailDeliverable === false
                  ? " (unverified)"
                  : ""}
              {row.primaryContact.phone ? ` · ${row.primaryContact.phone}` : ""}
            </p>
          )}
        </div>

        <div className="text-right shrink-0">
          <p className="text-sm font-semibold tabular-nums">
            {row.leadScore}
            <span className="text-xs font-normal text-gray-500"> score</span>
          </p>
          {row.icpAdjustedScore != null && (
            <p className="text-xs text-gray-500 tabular-nums">
              ICP {row.icpAdjustedScore}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => enrich(false)}
          title="Reveals exactly ONE top-ranked decision-maker, verifies the email, then stops"
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-green-700 text-white hover:bg-green-800 disabled:opacity-50"
        >
          {busy === "approve" ? "Enriching…" : "Approve for enrichment"}
        </button>

        {row.revealedContactCount > 0 && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => enrich(true)}
            className="px-3 py-1.5 rounded-md text-sm font-medium border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-50"
          >
            {busy === "additional" ? "Finding…" : "Find additional contact"}
          </button>
        )}

        {addable && (
          <AddToCallListButton
            companyId={row.id}
            initialOnList={row.onCallList}
            compact
            label={hasContact ? "Add to Call List" : "Add to Call List (main line)"}
            title={
              hasContact
                ? "Move this company and its revealed decision-maker onto the active call list"
                : "Add the company on its own so you can cold-call the main line — no contact is required"
            }
          />
        )}

        <label
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer"
          title="ContactOut is the only mobile source on this path. If ContactOut has no mobile for the contact, none is returned — Apollo's mobile is 9 Apollo credits and less accurate."
        >
          <input
            type="checkbox"
            checked={includePhone}
            onChange={(e) => setIncludePhone(e.target.checked)}
            className="rounded border-gray-300"
          />
          Also look up mobile via ContactOut (1 ContactOut credit, no Apollo
          fallback)
        </label>

        <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-700" aria-hidden />

        {REVIEW_ACTIONS.map((action) => (
          <button
            key={action.status}
            type="button"
            disabled={busy !== null}
            onClick={() => review(action.status)}
            className={`px-2.5 py-1 rounded-md text-xs border disabled:opacity-50 ${
              action.tone === "danger"
                ? "border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
            }`}
          >
            {busy === action.status ? "Saving…" : action.label}
          </button>
        ))}
      </div>

      {notice && (
        <p className="text-xs text-green-700 dark:text-green-400 mt-2">{notice}</p>
      )}
      {error && (
        <p className="text-xs text-red-700 dark:text-red-400 mt-2">{error}</p>
      )}
    </article>
  );
}
