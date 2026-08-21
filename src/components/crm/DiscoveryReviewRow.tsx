"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AddToCallListButton } from "@/components/AddToCallListButton";
import type { CompanyCardData } from "@/components/CompanyCard";
import type { CompanyReviewStatus, Contact } from "@/lib/db/schema";
import {
  canAddToCallList,
  REVIEW_STATUS_LABELS as STATUS_LABELS,
} from "@/lib/discovery/review-actions";
import type { ReviewQueueRow } from "@/lib/discovery/review-queue";
import {
  describeRevealFailure,
  describeRevealNetworkFailure,
  describeRevealSuccess,
  type ApproveEnrichmentSuccess,
  type RevealOutcome,
} from "@/lib/discovery/reveal-outcome";
import { verticalBadgeLabel } from "@/lib/discovery/vertical-evidence";
import { contactIsCallable } from "@/lib/lead-score";
import { DiscoveryContactPanel } from "./DiscoveryContactPanel";

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

type ApproveEnrichmentResponse = Partial<ApproveEnrichmentSuccess> & {
  company?: CompanyCardData | null;
  cost_note?: string;
  contactout_configured?: boolean;
  contactout_retry_at?: string | null;
  contactOutRetryAt?: string | null;
  review_status?: CompanyReviewStatus | null;
  review_status_applied?: boolean;
  error?: string;
};

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

  const [expanded, setExpanded] = useState(false);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RevealOutcome | null>(null);
  const [costNote, setCostNote] = useState<string | null>(null);
  const [jobLocation, setJobLocation] = useState<string | null>(null);
  // Approving moves the company out of the Pending bucket. The badge has to
  // reflect that locally, because the row deliberately does NOT re-fetch the
  // queue — a refresh would drop the row and take the result with it.
  const [reviewStatus, setReviewStatus] = useState(row.reviewStatus);

  const panelId = `discovery-contacts-${row.id}`;

  const applyCompany = useCallback((company: CompanyCardData) => {
    setContacts(company.contacts);
    setJobLocation(
      company.jobListings[0]?.location ??
        company.contacts.find((c) => c.jobLocation)?.jobLocation ??
        null,
    );
  }, []);

  /** Free read — the company row and its contacts, no provider call. */
  const loadContacts = useCallback(async () => {
    setContactsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/companies/${row.id}?skipGeo=1`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError("Could not load the contacts on file for this company.");
        return;
      }
      const data = (await res.json()) as { company: CompanyCardData };
      applyCompany(data.company);
    } catch {
      setLoadError("Network error — could not load the contacts on file.");
    } finally {
      setContactsLoading(false);
    }
  }, [applyCompany, row.id]);

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next && contacts === null && !contactsLoading) void loadContacts();
  }

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
      // A disposition is meant to move the row out of the bucket, so refreshing
      // the queue is the right behaviour here.
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
    setOutcome(null);
    setCostNote(null);
    setExpanded(true);
    // Show who is already on file while the reveal runs, and so a failure still
    // leaves the operator looking at the candidates rather than an empty panel.
    if (contacts === null) await loadContacts();
    try {
      const res = await fetch(`/api/companies/${row.id}/approve-enrichment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_phone: includePhone, additional }),
      });
      const data = (await res.json()) as ApproveEnrichmentResponse;
      if (!res.ok) {
        if (data.review_status_applied) setReviewStatus("approved");
        setOutcome(
          describeRevealFailure(res.status, data.error, {
            contactOutRetryAt: data.contactout_retry_at ?? null,
            reviewStatusApplied: data.review_status_applied,
          }),
        );
        return;
      }
      if (data.review_status) setReviewStatus(data.review_status);
      if (data.company) applyCompany(data.company);
      else await loadContacts();
      const success = describeRevealSuccess({
        revealed: data.revealed ?? 0,
        candidatesFound: data.candidatesFound ?? 0,
        alreadyRevealedCount: data.alreadyRevealedCount ?? 0,
        phoneRequested: data.phoneRequested ?? false,
        phonesFound: data.phonesFound ?? 0,
        emailDeliverable: data.emailDeliverable ?? null,
        emailVerifyReason: data.emailVerifyReason ?? null,
        contactOutUsed: data.contactOutUsed ?? false,
        contactOutLocked: data.contactOutLocked ?? false,
        contactOutError: data.contactOutError ?? null,
        contactOutConfigured: data.contactout_configured ?? false,
        contactOutRetryAt: data.contactout_retry_at ?? null,
        apolloMobileSkipped: data.apolloMobileSkipped ?? 0,
        contact: data.contact ?? null,
      });
      // The cost note describes a charge, so it must not appear on the paths
      // that deliberately charged nothing.
      setCostNote(success.spentCredit ? (data.cost_note ?? null) : null);
      setOutcome(success);
    } catch {
      setOutcome(describeRevealNetworkFailure());
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
  // Local contacts win once loaded: they are newer than the server-rendered
  // queue row, which is exactly the case right after a reveal.
  const revealedCount = contacts
    ? contacts.filter(contactIsCallable).length
    : row.revealedContactCount;
  const knownCount = contacts ? contacts.length : row.contactCount;
  const hasContact = revealedCount > 0;
  const addable = canAddToCallList(reviewStatus);
  const enriching = busy === "approve" || busy === "additional";

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
            {reviewStatus !== "pending" && (
              <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {STATUS_LABELS[reviewStatus]}
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
        </div>

        <div className="flex items-start gap-2 shrink-0">
          <div className="text-right">
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
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            aria-controls={panelId}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={expanded ? "Hide contacts" : "Show contacts"}
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

      {/* The disclosure summary doubles as the toggle, so the contact state is
          readable without expanding and reachable by keyboard. */}
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="mt-1.5 text-xs text-left text-blue-700 dark:text-blue-400 hover:underline"
      >
        {revealedCount > 0
          ? `${revealedCount} revealed contact${revealedCount === 1 ? "" : "s"}${
              knownCount > revealedCount
                ? ` · ${knownCount - revealedCount} found, not revealed`
                : ""
            }`
          : knownCount > 0
            ? `${knownCount} contact${knownCount === 1 ? "" : "s"} found, none revealed`
            : "No contacts on file"}
        {expanded ? " — hide" : " — show"}
      </button>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => enrich(false)}
          aria-controls={panelId}
          title="Reveals exactly ONE top-ranked decision-maker, verifies the email, then stops"
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-green-700 text-white hover:bg-green-800 disabled:opacity-50"
        >
          {busy === "approve" ? "Enriching…" : "Approve for enrichment"}
        </button>

        {/* Find additional contact lives in the dropdown, next to the contact
            it would add to. Add to Call List stays here: it also covers the
            main-line-only company, which has no contact to expand to. */}
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

      {expanded && (
        <DiscoveryContactPanel
          panelId={panelId}
          contacts={contacts}
          jobLocation={jobLocation}
          loading={contactsLoading}
          loadError={loadError}
          pending={enriching}
          pendingLabel={
            busy === "additional"
              ? "Revealing one more decision-maker — Apollo match, then ContactOut…"
              : "Revealing one decision-maker — Apollo match, email verify, then ContactOut…"
          }
          outcome={outcome}
          costNote={costNote}
          onFindAdditional={() => void enrich(true)}
          additionalBusy={busy === "additional"}
        />
      )}
    </article>
  );
}
