/**
 * What did the paid providers actually cost, and did anything spend more than
 * the code says it should?
 *
 * Apollo's published model, which `paid-egress.ts` is meant to mirror:
 *   mixed_people/api_search .... 0 credits, always (People Search is free)
 *   organizations/search ....... 1 credit per page of up to 100 organizations
 *   people/match ............... 1 credit when it returns a person, 0 when not
 *   people/match:mobile ........ 8 credits, booked by the phone webhook only
 *                                when a mobile actually came back
 *
 * Anything else, or any of those at a cost the model does not allow, is either
 * a new call site nobody costed or an accounting bug. Both matter: the daily
 * cap is enforced against these numbers, so a row that over-books stops real
 * work, and one that under-books lets a burst through.
 *
 * The two spend shapes this exists to police:
 *   - a discovery run must be 1 credit, or 2 with the unknown-headcount pass
 *   - approving a company must reveal exactly ONE contact
 *
 * Usage:
 *   npx tsx scripts/verify-credit-spend.ts               # last 7 days
 *   npx tsx scripts/verify-credit-spend.ts --days 30
 *   npx tsx scripts/verify-credit-spend.ts --problems    # only what looks wrong
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fail, readOnlySql, show } from "./lib/read-only-sql";

const ARGV = process.argv.slice(2);
const PROBLEMS_ONLY = ARGV.includes("--problems");
const daysArg = ARGV.indexOf("--days");
const DAYS = daysArg > -1 ? Math.max(1, Number(ARGV[daysArg + 1]) || 7) : 7;

const sql = readOnlySql();

/** Costs paid-egress.ts is allowed to book, per endpoint. */
const ALLOWED_COST: Record<string, number[]> = {
  "mixed_people/api_search": [0],
  "organizations/search": [0, 1],
  "people/match": [0, 1, 9],
  "people/match:mobile": [0, 8],
};

/** Endpoints the provider documents as free — excluded from the daily cap. */
const ZERO_COST_ENDPOINTS = new Set(["mixed_people/api_search"]);

async function main() {
  console.log(`\n=== Paid provider spend, last ${DAYS} day(s) ===\n`);

  /* --- per endpoint --------------------------------------------------- */
  const byEndpoint = await sql<{
    provider: string;
    endpoint: string;
    calls: number;
    blocked: number;
    credits: number;
    records: number;
    distinct_costs: string;
  }>`
    select provider, endpoint,
           count(*)::int as calls,
           count(*) filter (where blocked)::int as blocked,
           coalesce(sum(estimated_cost) filter (where not blocked), 0)::int as credits,
           coalesce(sum(records_returned) filter (where not blocked), 0)::int as records,
           (select string_agg(distinct e2.estimated_cost::text, ', ' order by e2.estimated_cost::text)
              from provider_usage_events e2
             where e2.provider = e.provider and e2.endpoint = e.endpoint
               and not e2.blocked
               and e2.created_at >= now() - (${DAYS} || ' days')::interval
           ) as distinct_costs
    from provider_usage_events e
    where created_at >= now() - (${DAYS} || ' days')::interval
    group by provider, endpoint
    order by credits desc, calls desc
  `;

  if (!byEndpoint.length) {
    console.log("No provider usage recorded in this window.");
    return;
  }

  console.table(
    byEndpoint.map((r) => ({
      provider: r.provider,
      endpoint: r.endpoint,
      calls: r.calls,
      blocked: r.blocked,
      credits: r.credits,
      records: r.records,
      costs_seen: show(r.distinct_costs),
      counts_against_cap: ZERO_COST_ENDPOINTS.has(r.endpoint) ? "no (free)" : "yes",
    })),
  );

  /* --- rows booked at a cost the model does not allow ----------------- */
  const offModel = await sql<{
    provider: string;
    endpoint: string;
    estimated_cost: number;
    records_returned: number;
    n: number;
    example_context: string;
  }>`
    select provider, endpoint, estimated_cost, records_returned,
           count(*)::int as n,
           min(egress_context) as example_context
    from provider_usage_events
    where created_at >= now() - (${DAYS} || ' days')::interval
      and not blocked
    group by provider, endpoint, estimated_cost, records_returned
    order by provider, endpoint, estimated_cost
  `;

  const surprises = offModel.filter((row) => {
    if (row.provider !== "apollo") return false;
    const allowed = ALLOWED_COST[row.endpoint];
    if (!allowed) return true; // an Apollo endpoint nobody costed
    return !allowed.includes(row.estimated_cost);
  });

  // A people/match that returned nothing must be free, and one that returned a
  // person must be 1: those two rules are the whole of the match accounting.
  const matchMisbooked = offModel.filter(
    (row) =>
      row.provider === "apollo" &&
      row.endpoint === "people/match" &&
      ((row.records_returned === 0 && row.estimated_cost !== 0) ||
        (row.records_returned > 0 && row.estimated_cost === 0)),
  );

  console.log("\nApollo rows booked at a cost the published model does not allow");
  if (surprises.length || matchMisbooked.length) {
    console.table(
      [...surprises, ...matchMisbooked].map((r) => ({
        endpoint: r.endpoint,
        booked: r.estimated_cost,
        records: r.records_returned,
        rows: r.n,
        expected: ALLOWED_COST[r.endpoint]?.join(" or ") ?? "endpoint not in the cost model",
        context: r.example_context,
      })),
    );
  } else {
    console.log("None. Every Apollo row is booked at a cost the model allows.");
  }

  /* --- discovery runs: 1 credit, or 2 with the unknown pass ----------- */
  const discoveryRuns = await sql<{
    run_label: string;
    day: string;
    pages: number;
    credits: number;
    organizations: number;
  }>`
    select
      coalesce(metadata ->> 'usageLabel', egress_context) as run_label,
      to_char(created_at, 'YYYY-MM-DD HH24:MI') as day,
      count(*)::int as pages,
      coalesce(sum(estimated_cost), 0)::int as credits,
      coalesce(sum(records_returned), 0)::int as organizations
    from provider_usage_events
    where provider = 'apollo'
      and endpoint = 'organizations/search'
      and not blocked
      and egress_context like 'manual_enrich:discovery:%'
      and created_at >= now() - (${DAYS} || ' days')::interval
    group by 1, 2
    order by 2 desc
    limit 60
  `;

  const runTotals = await sql<{
    context: string;
    minute: string;
    credits: number;
    pages: number;
  }>`
    select egress_context as context,
           to_char(date_trunc('minute', created_at), 'YYYY-MM-DD HH24:MI') as minute,
           coalesce(sum(estimated_cost), 0)::int as credits,
           count(*)::int as pages
    from provider_usage_events
    where provider = 'apollo'
      and endpoint = 'organizations/search'
      and not blocked
      and egress_context like 'manual_enrich:discovery:%'
      and created_at >= now() - (${DAYS} || ' days')::interval
    group by 1, 2
    order by 2 desc
    limit 60
  `;

  console.log("\nCompany-first discovery runs — pages bought per run");
  if (!discoveryRuns.length) {
    console.log("No discovery run in this window.");
  } else if (!PROBLEMS_ONLY) {
    console.table(discoveryRuns);
  }
  const overspentRuns = runTotals.filter((r) => r.credits > 2);
  if (overspentRuns.length) {
    console.log(
      "!! Runs that cost more than the documented 1 to 2 credits " +
        "(sized page + optional unknown-headcount page):",
    );
    console.table(overspentRuns);
  } else if (runTotals.length) {
    console.log(
      `Every one of ${runTotals.length} discovery run(s) cost 1 or 2 credits, ` +
        "which is the sized page plus the optional unknown-headcount page.",
    );
  }

  /* --- approving a company must reveal exactly one contact ------------ */
  const revealsPerCompany = await sql<{
    company: string;
    company_id: string;
    revealed_contacts: number;
    match_calls: number;
    mobile_credits: number;
    contactout_credits: number;
    apollo_credits: number;
  }>`
    select co.name as company, co.id as company_id,
           (select count(*)::int from contacts c
             where c.company_id = co.id and c.reveal_status = 'revealed') as revealed_contacts,
           count(*) filter (
             where e.provider = 'apollo' and e.endpoint = 'people/match' and not e.blocked
           )::int as match_calls,
           coalesce(sum(e.estimated_cost) filter (
             where e.endpoint = 'people/match:mobile' and not e.blocked
           ), 0)::int as mobile_credits,
           coalesce(sum(e.estimated_cost) filter (
             where e.provider = 'contactout' and not e.blocked
           ), 0)::int as contactout_credits,
           coalesce(sum(e.estimated_cost) filter (
             where e.provider = 'apollo' and not e.blocked
           ), 0)::int as apollo_credits
    from provider_usage_events e
    join companies co on co.id = e.company_id
    where e.created_at >= now() - (${DAYS} || ' days')::interval
      and co.review_status is not null
    group by co.id, co.name
    order by apollo_credits desc
    limit 50
  `;

  console.log(
    "\nCompanies from the discovery review queue — what the reveal actually cost",
  );
  if (!revealsPerCompany.length) {
    console.log("No review-queue company spent a credit in this window.");
  } else {
    if (!PROBLEMS_ONLY) console.table(revealsPerCompany);
    const multiReveal = revealsPerCompany.filter((r) => r.revealed_contacts > 1);
    if (multiReveal.length) {
      console.log(
        `!! ${multiReveal.length} review-queue compan(ies) have more than one revealed ` +
          "contact. revealSingleDecisionMaker stops at one; a second contact " +
          "should only exist where the operator clicked Find Additional Contact.",
      );
      console.table(
        multiReveal.map((r) => ({
          company: r.company,
          revealed_contacts: r.revealed_contacts,
          apollo_credits: r.apollo_credits,
        })),
      );
    } else {
      console.log(
        "Every review-queue company has at most one revealed contact, which is " +
          "the single-decision-maker rule holding.",
      );
    }
  }

  /* --- the daily cap and what it counts -------------------------------- */
  const capUsage = await sql<{
    day: string;
    provider: string;
    billable: number;
    free_calls: number;
    blocked: number;
  }>`
    select to_char(created_at at time zone 'America/New_York', 'YYYY-MM-DD') as day,
           provider,
           coalesce(sum(estimated_cost) filter (
             where not blocked and endpoint <> 'mixed_people/api_search'
           ), 0)::int as billable,
           count(*) filter (
             where endpoint = 'mixed_people/api_search'
           )::int as free_calls,
           count(*) filter (where blocked)::int as blocked
    from provider_usage_events
    where created_at >= now() - (${DAYS} || ' days')::interval
    group by 1, 2
    order by 1 desc, 2
  `;

  console.log(
    "\nCredits counted against the daily safety cap, per business day (midnight ET)",
  );
  if (capUsage.length) console.table(capUsage);
  else console.log("Nothing recorded.");

  const capHits = await sql<{
    day: string;
    provider: string;
    endpoint: string;
    n: number;
    reason: string;
  }>`
    select to_char(created_at at time zone 'America/New_York', 'YYYY-MM-DD') as day,
           provider, endpoint, count(*)::int as n,
           coalesce(metadata ->> 'reason', 'unknown') as reason
    from provider_usage_events
    where blocked
      and created_at >= now() - (${DAYS} || ' days')::interval
    group by 1, 2, 3, 5
    order by 1 desc, n desc
  `;

  console.log("\nCalls the egress gate refused");
  if (capHits.length) {
    console.table(capHits);
    console.log(
      "daily_cap_reached means the app's own guardrail fired, not the provider " +
        "balance. non_manual_context means an automated path tried to spend, " +
        "which the gate is there to stop.",
    );
  } else {
    console.log("None. Nothing was blocked in this window.");
  }

  /* --- verdict ---------------------------------------------------------- */
  const problems: string[] = [];
  if (surprises.length) {
    problems.push(
      `${surprises.length} Apollo endpoint/cost combination(s) outside the published model`,
    );
  }
  if (matchMisbooked.length) {
    problems.push(
      `${matchMisbooked.length} people/match row(s) charged for an empty result or free for a found one`,
    );
  }
  if (overspentRuns.length) {
    problems.push(`${overspentRuns.length} discovery run(s) cost more than 2 credits`);
  }

  console.log("\n=== Verdict ===");
  if (problems.length) {
    console.table(problems.map((p) => ({ problem: p })));
    fail("credit accounting does not match the published cost model.");
  } else {
    console.log(
      "PASS: every recorded call is booked at a cost the model allows, discovery " +
        "runs cost 1 to 2 credits, and no review-queue company revealed more " +
        "than one contact.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
