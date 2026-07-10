import { and, eq, ilike, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";
import { getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";
import { evaluateIcp } from "@/lib/icp-filter";
import { getBacklogCompanies } from "@/lib/queries";
import type { pipelineSettings } from "@/lib/db/schema";

export type LinkedInPerSearchFunnel = {
  search?: string;
  linkedin_draws?: number[];
  linkedin_raw_sum?: number;
  /** URL-deduped count from JobSpy union at scrape time (pre-geo). */
  linkedin_union?: number;
  /** Unique LinkedIn URLs ingested for this search this run (sanity check). */
  linkedin_union_payload?: number;
  /** Jobs passing county geo filter for this search this run. */
  linkedin_in_focus?: number;
  linkedin_distance?: number | null;
};

/** Per-run funnel — persisted on daily_runs.funnel_json after each scrape/ingest. */
export type PipelineFunnel = {
  scrape_linkedin_raw?: number;
  scrape_linkedin_deduped?: number;
  scrape_total?: number;
  scrape_linkedin_cap_per_search?: number;
  linkedin_per_search?: LinkedInPerSearchFunnel[];
  poster_pages_fetched?: number;
  poster_public_block_in_html?: number;
  meet_team_in_html?: number;
  poster_parsed?: number;
  poster_contacts_seeded?: number;
  db_linkedin_jobs?: number;
  db_linkedin_companies?: number;
  db_geo_pass_jobs?: number;
  db_icp_eligible_companies?: number;
  db_backlog_total?: number;
  db_backlog_linkedin?: number;
  db_jobs_with_poster?: number;
  measured_at?: string;
  /** Set when union/max(draw) or in-focus/union math breaks — never silent. */
  funnel_invariant_violations?: string[];
};

export function mergeFunnel(
  existing: PipelineFunnel | null | undefined,
  incoming: PipelineFunnel,
): PipelineFunnel {
  return { ...existing, ...incoming, measured_at: new Date().toISOString() };
}

/** Ground-truth DB snapshot — answers "where did leads drop?" */
export async function measureDbFunnel(
  geoSettings?: typeof pipelineSettings.$inferSelect,
): Promise<PipelineFunnel> {
  const settings = geoSettings ?? (await getGeoFocusSettings());

  const liJobs = await db
    .select({
      location: jobListings.location,
      posterName: jobListings.posterName,
      companyId: jobListings.companyId,
      companyName: companies.name,
      estimatedEmployees: companies.estimatedEmployees,
    })
    .from(jobListings)
    .innerJoin(companies, eq(jobListings.companyId, companies.id))
    .where(
      and(ilike(jobListings.board, "%linkedin%"), isNull(jobListings.archivedAt)),
    );

  const companyIds = [...new Set(liJobs.map((j) => j.companyId))];
  let geoPass = 0;
  let withPoster = 0;
  for (const job of liJobs) {
    if (jobLocationInFocus(job.location, settings)) geoPass += 1;
    if (job.posterName) withPoster += 1;
  }

  let icpEligible = 0;
  for (const cid of companyIds) {
    const job = liJobs.find((j) => j.companyId === cid)!;
    const icp = evaluateIcp({
      companyName: job.companyName,
      estimatedEmployees: job.estimatedEmployees,
    });
    if (icp !== "fail") {
      icpEligible += 1;
      continue;
    }
    const [poster] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.companyId, cid),
          eq(contacts.sourceProvider, "linkedin_poster"),
        ),
      )
      .limit(1);
    if (poster) icpEligible += 1;
  }

  const backlog = await getBacklogCompanies();
  const backlogLinkedIn = backlog.filter((c) =>
    c.jobListings.some((j) => j.board?.toLowerCase() === "linkedin"),
  );

  return {
    db_linkedin_jobs: liJobs.length,
    db_linkedin_companies: companyIds.length,
    db_geo_pass_jobs: geoPass,
    db_icp_eligible_companies: icpEligible,
    db_backlog_total: backlog.length,
    db_backlog_linkedin: backlogLinkedIn.length,
    db_jobs_with_poster: withPoster,
    measured_at: new Date().toISOString(),
  };
}

type RunListingGeo = {
  searchName?: string | null;
  board?: string | null;
  location?: string | null;
  url?: string | null;
};

/**
 * Attach per-search in-focus counts from this run's ingested listings.
 * Keeps scrape union (worker) separate from geo deliverable (CRM).
 */
export function augmentScrapeFunnelWithGeo(
  funnel: PipelineFunnel,
  runListings: RunListingGeo[],
  settings: typeof pipelineSettings.$inferSelect,
): PipelineFunnel {
  if (!funnel.linkedin_per_search?.length) {
    return validateFunnelInvariants(funnel);
  }

  const linkedin = runListings.filter((j) =>
    j.board?.toLowerCase().includes("linkedin"),
  );

  const bySearch = new Map<string, RunListingGeo[]>();
  for (const job of linkedin) {
    const key = job.searchName?.trim() ?? "";
    const bucket = bySearch.get(key) ?? [];
    bucket.push(job);
    bySearch.set(key, bucket);
  }

  const linkedin_per_search = funnel.linkedin_per_search.map((entry) => {
    const jobs = bySearch.get(entry.search?.trim() ?? "") ?? [];
    const urls = new Set(jobs.map((j) => j.url).filter(Boolean));
    const inFocus = jobs.filter((j) =>
      jobLocationInFocus(j.location, settings),
    ).length;
    return {
      ...entry,
      linkedin_in_focus: inFocus,
      linkedin_union_payload: urls.size,
    };
  });

  return validateFunnelInvariants({ ...funnel, linkedin_per_search });
}

/** Per-search funnel invariants: union ≥ max(draws); in-focus ≤ union. */
export function checkPerSearchFunnelInvariants(
  entry: LinkedInPerSearchFunnel,
): string[] {
  const violations: string[] = [];
  const name = (entry.search ?? "?").split(" — ")[0];
  const draws = entry.linkedin_draws ?? [];
  const union = entry.linkedin_union;
  const inFocus = entry.linkedin_in_focus;

  if (draws.length && union != null) {
    const maxDraw = Math.max(...draws);
    if (union < maxDraw) {
      violations.push(`${name}: union ${union} < max(draw) ${maxDraw}`);
    }
  }
  if (union != null && inFocus != null && inFocus > union) {
    violations.push(`${name}: in-focus ${inFocus} > union ${union}`);
  }
  return violations;
}

export function validateFunnelInvariants(funnel: PipelineFunnel): PipelineFunnel {
  const violations = [
    ...(funnel.funnel_invariant_violations ?? []),
    ...(funnel.linkedin_per_search ?? []).flatMap(checkPerSearchFunnelInvariants),
  ];
  const unique = [...new Set(violations)];
  if (unique.length) {
    console.error("[funnel] invariant violations:", unique);
  }
  return {
    ...funnel,
    funnel_invariant_violations: unique.length ? unique : undefined,
  };
}

export function formatPerSearchFunnelLine(entry: LinkedInPerSearchFunnel): string {
  const name = (entry.search ?? "?").split(" — ")[0];
  const draws =
    entry.linkedin_draws?.length != null
      ? `[${entry.linkedin_draws.join(",")}]`
      : "[]";
  const union = entry.linkedin_union ?? "?";
  const inFocus = entry.linkedin_in_focus ?? "?";
  return `${name}: ${draws} → union ${union} → in-focus ${inFocus}`;
}

/** This run only — scrape yield + posters. Per title: draws → union → in-focus. */
export function formatRunFunnelLine(f: PipelineFunnel): string {
  const parts = [
    f.scrape_total != null && `scraped ${f.scrape_total}`,
    f.scrape_linkedin_deduped != null && `LI union ${f.scrape_linkedin_deduped}`,
    f.poster_parsed != null && `posters ${f.poster_parsed}`,
  ].filter(Boolean);

  const perSearch = f.linkedin_per_search;
  if (perSearch?.length) {
    parts.push(
      `by title: ${perSearch.map(formatPerSearchFunnelLine).join("; ")}`,
    );
  }

  if (f.funnel_invariant_violations?.length) {
    parts.push(`⚠ ${f.funnel_invariant_violations.join("; ")}`);
  }

  return parts.join(" → ");
}

/** Cumulative DB snapshot — not single-run yield. */
export function formatDbFunnelLine(f: PipelineFunnel): string {
  const parts = [
    f.db_linkedin_jobs != null && `${f.db_linkedin_jobs} LI jobs in DB`,
    f.db_geo_pass_jobs != null && `${f.db_geo_pass_jobs} geo pass`,
    f.db_backlog_linkedin != null && `backlog ${f.db_backlog_linkedin}`,
    f.db_jobs_with_poster != null && `${f.db_jobs_with_poster} w/ poster`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function formatFunnelLine(f: PipelineFunnel): string {
  return formatRunFunnelLine(f);
}
