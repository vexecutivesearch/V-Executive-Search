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
  linkedin_union?: number;
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

/** This run only — scrape yield + posters. Union counts only; raw_sum is overlap, not coverage. */
export function formatRunFunnelLine(f: PipelineFunnel): string {
  const parts = [
    f.scrape_total != null && `scraped ${f.scrape_total}`,
    f.scrape_linkedin_deduped != null && `LI union ${f.scrape_linkedin_deduped}`,
    f.poster_parsed != null && `posters ${f.poster_parsed}`,
  ].filter(Boolean);

  const perSearch = f.linkedin_per_search;
  if (perSearch?.length) {
    const brief = perSearch
      .map((s) => {
        const name = (s.search ?? "?").split(" — ")[0];
        const draws = s.linkedin_draws?.length
          ? `[${s.linkedin_draws.join("+")}]`
          : "";
        return `${name} ${s.linkedin_union ?? "?"}${draws}`;
      })
      .join(", ");
    parts.push(`by title: ${brief}`);
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
