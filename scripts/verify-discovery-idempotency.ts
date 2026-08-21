/**
 * Does discovery return the same companies twice?
 *
 * "25 new per day" is a sustained rate against a finite pool — a single
 * county's law firms are a few hundred companies — so day two must start where
 * day one stopped. Three separate things have to hold for that, and each fails
 * differently:
 *
 *   1. the cursor advances: one row per (vertical, market, pool), consumed
 *      climbing by roughly the page size each run, and pool_exhausted set once
 *      Apollo runs dry
 *   2. dedupe catches what the cursor cannot: Apollo's page boundary shifts
 *      whenever the run size changes, so a few organizations repeat and must be
 *      matched on domain or normalised name rather than inserted again
 *   3. review decisions survive: a company already approved, rejected or marked
 *      do-not-contact must never be dragged back into the pending queue
 *
 * A duplicate that gets through does not just waste a review slot. Both rows
 * can be approved, and each approval reveals a contact, so the cost of a
 * dedupe miss is paid in credits.
 *
 * Usage:
 *   npx tsx scripts/verify-discovery-idempotency.ts
 *   npx tsx scripts/verify-discovery-idempotency.ts --problems
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fail, readOnlySql, show } from "./lib/read-only-sql";

const ARGV = process.argv.slice(2);
const PROBLEMS_ONLY = ARGV.includes("--problems");

const sql = readOnlySql();

async function main() {
  console.log("\n=== Company-first discovery: cursors, duplicates, review state ===\n");

  /* --- 1. cursor state per (vertical, market, pool) ------------------- */
  const cursors = await sql<{
    vertical: string;
    market: string;
    pool: string;
    per_page: number;
    consumed: number;
    total_entries: number | null;
    pages_fetched: number;
    last_returned: number;
    pool_exhausted: boolean;
    last_run_at: string | null;
  }>`
    select vertical, market, pool, per_page, consumed, total_entries,
           pages_fetched, last_returned, pool_exhausted, last_run_at
    from company_discovery_runs
    order by vertical, market, pool
  `;

  console.log("Pagination cursors");
  if (!cursors.length) {
    console.log("No discovery run has been recorded yet.");
  } else {
    console.table(
      cursors.map((c) => ({
        vertical: c.vertical,
        market: c.market,
        pool: c.pool,
        per_page: c.per_page,
        consumed: c.consumed,
        pool_size: show(c.total_entries),
        remaining:
          c.total_entries == null ? "—" : Math.max(0, c.total_entries - c.consumed),
        pages: c.pages_fetched,
        last_page_returned: c.last_returned,
        exhausted: c.pool_exhausted,
        last_run: show(c.last_run_at),
      })),
    );
  }

  // A cursor that has run more than once but never moved is the failure mode
  // this table exists to prevent: every run re-reads page 1.
  const stuck = cursors.filter((c) => c.pages_fetched > 1 && c.consumed <= c.per_page);
  if (stuck.length) {
    console.log(
      "!! Cursors that have fetched more than one page but barely consumed anything — " +
        "these are re-reading the same page and will re-surface the same companies:",
    );
    console.table(stuck);
  }

  // The sized search runs unconditionally, so an exhausted pool still buys a
  // page every time the operator picks that market.
  const exhaustedButLive = cursors.filter(
    (c) => c.pool === "sized" && c.pool_exhausted,
  );
  if (exhaustedButLive.length && !PROBLEMS_ONLY) {
    console.log(
      "Pools already exhausted — running discovery on these markets still spends " +
        "the sized-page credit and returns nothing new. Rotate the market:",
    );
    console.table(
      exhaustedButLive.map((c) => ({
        vertical: c.vertical,
        market: c.market,
        consumed: c.consumed,
        pool_size: show(c.total_entries),
      })),
    );
  }

  /* --- 2. duplicates that reached the database ------------------------ */
  const dupeDomains = await sql<{
    domain: string;
    rows: number;
    names: string;
    review_statuses: string;
  }>`
    select lower(trim(domain)) as domain,
           count(*)::int as rows,
           string_agg(distinct name, ' | ') as names,
           string_agg(distinct coalesce(review_status::text, 'none'), ', ') as review_statuses
    from companies
    where domain is not null and trim(domain) <> ''
    group by 1
    having count(*) > 1
    order by rows desc
    limit 50
  `;

  console.log("\nDuplicate companies sharing a domain");
  if (dupeDomains.length) {
    console.table(dupeDomains);
    console.log(
      "companies.domain is UNIQUE, so more than one row per domain means the " +
        "duplicates differ by case or whitespace and slipped past the constraint.",
    );
  } else {
    console.log("None. Every non-null domain appears once.");
  }

  // The dedupe index normalises the name the same way normalizeCompanyKey does:
  // lowercase, strip punctuation and the usual legal suffixes, collapse spaces.
  const dupeNames = await sql<{
    name_key: string;
    rows: number;
    names: string;
    domains: string;
    verticals: string;
    review_statuses: string;
  }>`
    with keyed as (
      select id, name, domain, vertical, review_status,
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(name), '[^a-z0-9 ]', ' ', 'g'),
                 '\\y(inc|llc|llp|lp|corp|corporation|co|company|ltd|limited|group|partners|pa|pllc)\\y',
                 ' ', 'g'
               ),
               '\\s+', ' ', 'g'
             ) as name_key
      from companies
    )
    select trim(name_key) as name_key,
           count(*)::int as rows,
           string_agg(distinct name, ' | ') as names,
           string_agg(distinct coalesce(domain, 'no domain'), ', ') as domains,
           string_agg(distinct coalesce(vertical, 'none'), ', ') as verticals,
           string_agg(distinct coalesce(review_status::text, 'none'), ', ') as review_statuses
    from keyed
    where trim(name_key) <> ''
    group by 1
    having count(*) > 1
    order by rows desc
    limit 50
  `;

  console.log("\nDuplicate companies sharing a normalised name");
  if (dupeNames.length) {
    console.table(dupeNames);
    console.log(
      "matchExistingCompany matches on domain first, then normalised name. Rows " +
        "here that BOTH sit in the review queue are two review slots and two " +
        "possible reveals for one company.",
    );
    const bothPending = dupeNames.filter((d) => d.review_statuses.includes("pending"));
    if (bothPending.length) {
      console.log(
        `!! ${bothPending.length} of these have at least one row still pending review.`,
      );
    }
  } else {
    console.log("None. Every normalised company name appears once.");
  }

  /* --- 3. review decisions that got dragged back to pending ----------- */
  const draggedBack = await sql<{
    name: string;
    review_status: string;
    status: string;
    review_updated: string | null;
    updated_at: string;
    contacts: number;
  }>`
    select co.name, co.review_status::text as review_status, co.status::text as status,
           co.review_status_updated_at as review_updated, co.updated_at,
           (select count(*)::int from contacts c where c.company_id = co.id) as contacts
    from companies co
    where co.review_status = 'pending'
      and (
        co.status <> 'new'
        or exists (select 1 from sequence_enrollments e where e.company_id = co.id)
        or exists (select 1 from call_list_entries cl where cl.company_id = co.id)
      )
    order by co.updated_at desc
    limit 50
  `;

  console.log("\nCompanies sitting in the pending review queue that have already been worked");
  if (draggedBack.length) {
    console.table(
      draggedBack.map((r) => ({
        ...r,
        review_updated: show(r.review_updated),
        updated_at: show(r.updated_at),
      })),
    );
    console.log(
      "upsertCandidate only stamps 'pending' when review_status is null AND " +
        "status is still 'new'. A contacted or enrolled company back in the " +
        "queue means that guard did not hold.",
    );
  } else {
    console.log(
      "None. No contacted, enrolled or call-listed company has been pulled back " +
        "into the pending queue.",
    );
  }

  /* --- shape of the queue --------------------------------------------- */
  if (!PROBLEMS_ONLY) {
    const counts = await sql<{ review_status: string; n: number; verticals: string }>`
      select coalesce(review_status::text, 'none') as review_status,
             count(*)::int as n,
             string_agg(distinct coalesce(vertical, 'no vertical'), ', ') as verticals
      from companies
      where review_status is not null
      group by 1
      order by n desc
    `;
    console.log("\nReview queue by status");
    if (counts.length) console.table(counts);
    else console.log("Empty — nothing has been through discovery.");

    const perDay = await sql<{
      day: string;
      discovered: number;
      approved: number;
      auto_rejected: number;
    }>`
      select to_char(first_seen, 'YYYY-MM-DD') as day,
             count(*)::int as discovered,
             count(*) filter (where review_status = 'approved')::int as approved,
             count(*) filter (where review_status = 'rejected')::int as auto_rejected
      from companies
      where review_status is not null
      group by 1
      order by 1 desc
      limit 21
    `;
    console.log("\nDiscovery volume per day (companies first seen)");
    if (perDay.length) console.table(perDay);
  }

  /* --- verdict ---------------------------------------------------------- */
  const problems: string[] = [];
  if (stuck.length) problems.push(`${stuck.length} cursor(s) are not advancing`);
  if (dupeDomains.length) {
    problems.push(`${dupeDomains.length} domain(s) have more than one company row`);
  }
  if (dupeNames.length) {
    problems.push(`${dupeNames.length} normalised name(s) have more than one company row`);
  }
  if (draggedBack.length) {
    problems.push(
      `${draggedBack.length} already-worked compan(ies) are back in the pending queue`,
    );
  }

  console.log("\n=== Verdict ===");
  if (problems.length) {
    console.table(problems.map((p) => ({ problem: p })));
    fail("discovery is not idempotent for at least one (vertical, market).");
  } else {
    console.log(
      "PASS: cursors advance, no company is duplicated by domain or normalised " +
        "name, and no worked company has been pulled back into the queue.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
