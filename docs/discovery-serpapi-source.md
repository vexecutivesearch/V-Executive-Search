# SerpApi as a company discovery source

**Status:** design + first implementation slice landed (Google Maps source, flag-off by default).
**Question asked:** _"I know you're using Apollo for search but we could also use SerpAPI to make a search to crawl and pull some companies per our criteria, no?"_
**Short answer:** Yes — and SerpApi is already paid for and already wired into this system. But it is a **complement to Apollo, not a replacement**, and it is only clearly worth the searches for the **Construction & Trades** vertical, secondarily for **Legal**. For Finance & Accounting and General Professional Services the case is weak. Details and evidence below.

All external facts in this document were verified against live vendor documentation on **2026-08-21**. Where a claim is inference rather than documented fact, it says so.

---

## 0. The thing to know first: we already have SerpApi

This was not a greenfield question. Before designing anything, the existing usage:

| Where | What it does | Key / flag |
|---|---|---|
| `worker/src/serpapi_google.py` | Google **Jobs** scraping via `engine=google_jobs`, replacing the broken JobSpy Google scraper | `SERPAPI_API_KEY` on the Mac worker |
| `worker/src/serpapi_budget.py` | `SerpApiMeter` — per-run cap, monthly budget guard, local state file at `~/.vsearch/serpapi_usage.json` | `SERPAPI_MONTHLY_PLAN`, `SERPAPI_BUDGET_PCT`, `SERPAPI_RUN_CAP` |
| `src/lib/serpapi-usage.ts` | CRM-side month-to-date accounting; sums `provider_usage_events` where `provider = 'serpapi'` | `SERPAPI_RENEWAL_DAY` |
| `.env.example` lines 25–31 | Documents the key as belonging on the **Mac worker**, not Vercel | — |

Consequences that shaped the whole design:

1. **Do not add a new dependency or a new key variable.** Reuse `SERPAPI_API_KEY`.
2. **SerpApi searches are a shared, finite monthly pool.** The defaults in `serpapiPlanConfig()` say the operator is on the **Production plan: 15,000 searches/month**, guarded at **80% = 12,000**. The job scrape already draws on that pool every morning. The real cost of company discovery on SerpApi is measured in *searches taken away from the job scrape*, not in dollars.
3. **The key is currently on the worker only.** Anything running inside the Next.js app (which is where `src/lib/discovery/run.ts` lives) needs `SERPAPI_API_KEY` added to Vercel. See §9.
4. The worker's accounting deliberately over-counts (it meters failed attempts too). SerpApi's own pricing FAQ says *"Only successful searches are counted toward your monthly searches. Cached, errored, and failed searches are not."* So the worker's guard is conservative — which is correct and should be preserved, not "fixed".

---

## 1. Which SerpApi engines are actually useful

Verified against `https://serpapi.com/google-maps-api`, `https://serpapi.com/maps-local-results`, `https://serpapi.com/google-local-api`, `https://serpapi.com/search-api`, and the engine index in `https://serpapi.com/llms.txt`.

### Field-by-field against what the operator asked for

The operator wants: name, website, industry, city/state, estimated size, main company phone, company LinkedIn, vertical, hiring signals, open-position count.

| Field | `google_maps` | `google_local` | `google` (organic) | `google` (local pack) | `google_jobs` | Apollo org search |
|---|---|---|---|---|---|---|
| Company name | ✅ `title` | ✅ `title` | ⚠️ from page title | ✅ `title` | ✅ `company_name` | ✅ `name` |
| Website / domain | ✅ `website` | ❌ not in documented example | ✅ `link` | ❌ | ❌ | ✅ `primary_domain` |
| Industry / category | ✅ `type`, `types`, `type_id`, `type_ids` | ✅ `type` | ❌ | ✅ `type` | ⚠️ implied by title | ✅ `industry` taxonomy |
| City / state | ✅ inside `address` ("18 W 29th St, New York, NY 10001") | ⚠️ `address` often street-only ("51 Rainey St #130") | ❌ | ⚠️ street-only | ✅ `location` | ✅ `city`, `state` |
| **Main company phone** | ✅ `phone` | ❌ not in documented example | ❌ | ❌ | ❌ | ⚠️ `primary_phone`, sparse for small firms |
| Estimated employees | ❌ **never** | ❌ | ❌ | ❌ | ❌ | ✅ `estimated_num_employees` |
| Company LinkedIn | ❌ | ❌ | ⚠️ only if you query `site:linkedin.com/company` | ❌ | ❌ | ✅ `linkedin_url` |
| Open-position count | ❌ | ❌ | ❌ | ❌ | ✅ per posting | via a separate paid endpoint |
| Trust/size proxies | ✅ `rating`, `reviews`, `operating_hours`, `service_options` | ✅ `rating`, `reviews` | ❌ | ✅ `rating`, `reviews` | ❌ | ❌ |

### Verdict per engine

**`google_maps` — the one worth using.** It is the only engine whose *documented JSON structure overview* lists both `phone` and `website` on every `local_results` entry, alongside `address` with a full city/state/ZIP, and a category (`type`/`types`). For roofing, HVAC, plumbing, electrical, restoration, general contractors and law firms — businesses whose entire marketing existence is a Google Business Profile — this is a better source of a **main-line phone number** than Apollo, and it covers firms Apollo's database does not contain at all. This confirms the hypothesis in the brief, with documentation as evidence rather than assumption.

**`google_local` — do not use.** SerpApi's marketing copy for the engine promises "Phone numbers, addresses…", but the documented response example returns only `position`, `rating`, `reviews`, `price`, `description`, `place_id`, `gps_coordinates`, `title`, `type`, `address` — and the `address` is street-only. It is strictly worse than `google_maps` for the same 1-search price. Skip it.

**`google` organic — useful, but for a different job.** The organic `link` gives a website, but the local pack embedded in the organic response (`local_results.places[]`) has **no phone and no website** in the documented example. Its real value is as a *targeted lookup*, not a discovery sweep: one `google` search for `"<company name>" <city> site:linkedin.com/company` is a legitimate way to obtain the company LinkedIn URL Maps cannot give you. That is 1 search per company, which is the expensive shape (see §2), so it belongs behind the operator's Approve button, not in discovery.

**`google_jobs` — already in use, leave it where it is.** It is the source of hiring signals today, and job signals are already attached to companies in `run.ts` via `summarizeJobSignals`. Nothing about the company-first rebuild needs a second `google_jobs` integration inside the Next.js app. The existing worker path is correct.

**`bing` — no.** It buys nothing the above do not, at the same per-search price, with worse local coverage in US metros.

**LinkedIn — there is no engine, and we should not build one.** SerpApi's supported-engine list (Google, Bing, Baidu, Amazon, Yelp, Facebook, Instagram, DuckDuckGo, Yandex, Yahoo, Walmart, eBay, Tripadvisor, OpenTable, Naver, Apple App Store, Apple Maps, Home Depot, YouTube, plus the Google family) does **not** include LinkedIn. Company LinkedIn URLs therefore come from Apollo, or from a `site:linkedin.com/company` Google query, or not at all. **Nothing in this design scrapes LinkedIn directly.**

**One engine worth flagging as unevaluated:** `google_local_services` (Google Local Services / "Google Guaranteed") exists in the engine list and is specifically the Google surface for licensed home-service trades — roofing, HVAC, plumbing, electrical. That is exactly the operator's Construction vertical, and a Google Guaranteed badge is a real signal of an established, licensed, spending business. I did not evaluate its response fields and am not implementing it. It is the single most promising follow-up.

---

## 2. Cost model

### First, correcting the premise

The brief said the codebase "treats [Apollo Organization Search] as 0 credits". **That is not what the code does, and 0 would be wrong.**

- `src/lib/domain-resolver.ts` records `estimatedCost: 1` for `organizations/search` on every call, and that endpoint is **not** in `ZERO_COST_ENDPOINTS` in `src/lib/paid-egress.ts`. The only zero-cost entry is `mixed_people/api_search`.
- Apollo's own docs confirm the code is right: Organization Search is **"1 credit per page, up to 100 results per page."**

So the existing accounting is correctly calibrated. Good news, and it means the comparison below is apples to apples.

### Per-search / per-page facts

| | Apollo Organization Search | SerpApi `google_maps` |
|---|---|---|
| Billing unit | 1 credit per page | 1 search per request |
| Records per unit | up to **100** | exactly **20** |
| Pagination | `page` | `start` +20; SerpApi recommends max `start=100`, i.e. **6 pages / ~120 results per query+location** |
| Hard ceiling | 50,000 records per filter set (100/page × 500 pages) | ~120 per query+location, then you must change the query or move the map |
| Unit price | Basic plan $49/seat/mo → 30,000 credits/seat/yr ≈ **$0.0196/credit** | Production plan $150/mo → 15,000 searches ≈ **$0.010/search** |
| Free retries | — | cached (1h) and errored/failed searches are **not** billed |

### Cost per 100 discovered companies

The operator's target is 100/day (25 × 4 verticals). The table below counts what it takes to *surface* 100 companies into the review queue. Yield assumptions are stated so they can be argued with.

| Path | Searches / credits | $ per 100 | Notes |
|---|---|---|---|
| **Apollo today, as `run.ts` actually runs it** | 8 credits/day (2 per vertical: one 25-row sized page + one 100-row unknown-size page) | **$0.16** | Measured from the code, not estimated. |
| Apollo, if the sized page used `per_page: 100` | 8 credits | $0.16 | Same credits, 4× the rows. Free improvement — see §10. |
| **SerpApi Maps, raw results** | 100 ÷ 20 = **5 searches** | **$0.05** | Best case, ignores dedupe and exclusions. |
| **SerpApi Maps, 100 net-new qualified** at 40% survival after dedupe + exclusion filtering | ~13 searches | **$0.13** | 40% is my estimate for a fresh market; there is no measurement yet. |
| **SerpApi Maps, saturated market** at 10% survival | ~50 searches | **$0.50** | This is the realistic steady state after a few weeks in one county. |
| SerpApi Maps, full vertical fan-out (Construction: 8 trade seeds × 6 pages, one market) | 48 searches | $0.48 | Sweeping a whole vertical-market exhaustively. |
| **`google` lookup for LinkedIn URL, per company** | 1 search **per company** | **$1.00 per 100** | 6× the whole Apollo discovery bill. Per-company SerpApi lookups are the expensive shape. Do not put this in discovery. |

### The honest reading

**In dollars, SerpApi Maps discovery is roughly a wash with Apollo** — somewhere between one-third of and three times the Apollo cost depending on market saturation, on a base that is pennies either way. Neither is a budget problem. Anyone claiming SerpApi is dramatically cheaper is comparing raw results against qualified results.

**The cost that actually matters is the monthly search quota, and it is shared.** Discovery at 100 companies/day needs roughly 400–1,500 searches/month (fresh vs. saturated). Against a 15,000/month plan guarded at 12,000, that is **3–13% of the pool** — affordable, but it is 3–13% the job scrape no longer has. The failure mode to fear is a saturated market where yield collapses toward zero and searches keep burning for nothing. The existing worker code already solved this with marginal-yield pagination (`GOOGLE_PAGE_MIN_YIELD`, stop when net-new ratio drops below threshold), and the same discipline must apply here.

**Per-company SerpApi lookups must never enter the discovery loop.** At 1 search per company, anything shaped "for each discovered company, do a search" costs more than the entire Apollo path. This is the rule that keeps SerpApi cheap.

---

## 3. Terms of service and legal posture

Not legal advice. What a reasonable operator should know, from primary sources dated 2026:

**SerpApi's U.S. Legal Shield** (`serpapi.com/us-legal-shield`, and §"DISCLAIMER OF WARRANTIES" of the ToS last updated 2026-04-08) provides **up to $2M of coverage for the scraping and parsing of search engine data**, and is **included on the Production plan and above** — which, per `SERPAPI_MONTHLY_PLAN=15000`, is the plan this account is on. It is **not** available on Free, Starter, or Developer, so a downgrade would silently drop the cover.

**What the Shield does and does not cover.** SerpApi's own wording: *"we assume liability for the lawful collection of public search data (scraping, parsing, and related actions), but not for how that data is ultimately used."* Coverage is limited to claims under U.S. state or federal law in a U.S. court. Excluded: copyright/IP infringement, DMCA violations, **privacy violations**, fraud, harassment. So: SerpApi carries the *collection* risk; the operator carries the *use* risk. For cold B2B outreach the use-side risk is mostly TCPA/CAN-SPAM/state consent law, which this codebase already treats seriously (`leadSource` consent lanes, `phone_classification` dial gating, `consentRecords`).

**Live litigation.** Google sued SerpApi in the Northern District of California in December 2025 under the DMCA, alleging circumvention of anti-scraping protections. A federal court **dismissed the DMCA claim in July 2026**, and the complaint may still be amended. Practical implication: SerpApi is not a legally settled utility, and the operator should not build a single-source dependency they cannot switch off. The `SERPAPI_DISCOVERY_ENABLED` flag exists partly for that reason.

**Crawling company websites directly is a separate, larger risk and is out of scope.** It would mean our IPs, our robots.txt compliance, our rate limiting, and no Legal Shield — the Shield covers *search engine* data, not arbitrary websites. Fetching a roofing company's contact page to guess headcount is a materially different legal and operational posture than reading a Google Business Profile through a covered intermediary. **Not implemented, and not recommended without a deliberate decision.**

**LinkedIn.** No LinkedIn scraping, direct or indirect. *hiQ v. LinkedIn* is often cited as permission; it is narrower than that, LinkedIn's ToS prohibit it, and there is no Legal Shield for it. A `site:linkedin.com/company` **Google** query reads Google's index, not LinkedIn — a meaningfully different act — but even that should stay a low-volume, post-approval lookup.

---

## 4. Where SerpApi beats Apollo, and where it does not

### SerpApi Maps wins

- **Coverage of small private local businesses.** A 12-person roofing company in Lake Worth has a Google Business Profile because that is how it gets customers. It may have no Apollo record at all. This is the single strongest argument, and it maps exactly onto "heavily prioritize small/midsize private companies."
- **Real main-line phone numbers.** Maps `phone` is the number the business publishes for customers to call. That is precisely a `business_line` under this codebase's `phone_classification` semantics — dialable under the operator's own gates without a ContactOut mobile reveal. Apollo's `primary_phone` is often absent for exactly the small firms the operator wants.
- **Recency.** Google Business Profiles are maintained by the owner because closures and moves cost them customers. Apollo's firmographics for a 15-person firm can be years stale.
- **Free size and legitimacy proxies.** `reviews` count, `rating`, `operating_hours`, `service_options` are all zero-extra-cost signals. A contractor with 400 reviews and 7am–7pm hours is a different business from one with 3 reviews.

### Apollo wins

- **Structured employee counts.** Maps returns **no headcount, ever**. Every Maps-discovered company lands with `estimatedEmployees = null`. The operator's targeting is explicitly banded (Legal 10–500, Construction 15–750, others 25–750), and Maps cannot filter on it. Apollo can, server-side, for the same one credit.
- **Industry taxonomy.** Apollo's `industry` is a consistent vocabulary. Maps `type` is a Google Business category chosen by the owner — "Roofing contractor" and "Roofer" and "Construction company" are all the same business.
- **Company LinkedIn URLs.** Apollo has them; Maps never will.
- **Deep pagination.** Apollo will page 50,000 records deep for one filter set. Maps gives ~120 per query+location before you must invent a new query. Sustaining "25 new/day" from Maps means a query-seed × geography grid, which is real engineering.
- **The whole downstream pipeline is already shaped like Apollo.** `DiscoveredOrganization`, `selectDiscoveryCandidates`, the `sized` / `unknown_size` pool split, `apolloEmployeeRange` — Apollo is the native vocabulary here. A second source has to translate into it.

### Conclusion

**Complementary, not a replacement, and specifically: Apollo stays the primary source and SerpApi Maps becomes a supplementary source for the local-service verticals.** Concretely:

| Vertical | Add SerpApi Maps? | Why |
|---|---|---|
| **Construction & Trades** | **Yes — highest value** | Roofing/HVAC/plumbing/electrical/restoration are Google-Business-Profile-native and Apollo-sparse. Maps is where these companies actually live. |
| **Legal** | **Yes — secondary** | Small firms and solo/small partnerships are well covered on Maps with a real main line. Multi-office firms create dedupe problems (§5). |
| Finance & Accounting | **Not yet** | Small CPA shops are on Maps, but Apollo's coverage of accounting firms is comparatively good and the size band (25–750) skews toward firms Apollo already has. Revisit with measured yield. |
| General Professional Services | **No** | "Professional services / consulting / marketing agency" does not map onto Google Business categories cleanly. Query seeds would return noise, and noise costs searches. |

**If forced to a single answer to the operator's question:** yes, add it — for Construction first — but expect *coverage improvement*, not *cost reduction*. If someone pitches SerpApi as a way to spend less, that is not what the numbers say.

---

## 5. Deduplication and merge strategy

A second source makes dedupe the highest-risk area in the whole change. Today `run.ts` matches **domain first, then `normalizeCompanyKey(name)`**, with domain as a UNIQUE column. That is the right skeleton; the additions needed are all on the domain side.

### Match order (implemented)

1. **Normalized domain.** Maps `website` is a marketing URL with UTM parameters (`?utm_source=gbp&utm_medium=organic&utm_campaign=local` is literally in SerpApi's own documented example). Normalization must strip scheme, `www.`, path, query, and fragment before comparing, or `example.com` and `https://www.example.com/?utm_source=gbp` become two companies. This is the single highest-value line of code in the change.
2. **`normalizeCompanyKey(name)`** — unchanged, shared with the job-scrape ingest so a Maps company cannot be inserted beside its scraped row.
3. Merge semantics unchanged: **fill blanks, never overwrite.** A Maps `phone` fills a null `companies.phone`; it never replaces an Apollo one. `reviewStatus` is only touched when the row is still `new` with a null review status, so a Maps hit cannot drag a contacted company back into the queue.

### Failure modes, honestly

- **Aggregator and social websites.** Maps `website` is whatever the owner put in their profile. For small firms that is frequently `facebook.com/theirpage`, `instagram.com/theirshop` (in SerpApi's own example!), a Squarespace subdomain, or a Yelp page. Taking `facebook.com` as a *domain* would be catastrophic: `domain` is UNIQUE, so the first Facebook-hosted company would claim it and every subsequent one would merge into that row. **Mitigation: a non-company-host denylist; those companies get `domain = null` and dedupe on name only.** Implemented, and it is the highest-severity trap in the change.
- **Franchise locations.** "Roto-Rooter Plumbing — West Palm Beach" and "— Boca Raton" are separate Maps entries sharing one corporate domain. Domain matching collapses them into one company, which is *usually right* for a recruiting pipeline (one hiring authority) but wrong for genuinely independent franchisees with their own hiring. Current behaviour: collapse. Accepted, not solved.
- **Multi-office law firms.** Same firm, one domain, several Maps entries with different city phones. Domain match collapses them and the *first* office's phone/city wins. For a firm whose hiring is centralized, correct. For a firm with independent offices, we lose the second office. Accepted, not solved.
- **DBA / trade names.** "Smith & Jones LLP" on Maps vs. "Smith Jones Law" in Apollo, no shared domain, `normalizeCompanyKey` produces different keys → **two rows, silently.** Unsolved and unsolvable with SERP-level data alone. This is the main quality tax of adding a second source, and it will produce visible duplicates in the review queue.
- **Suite/unit noise.** `address` includes `Unit B`, `# D30`, `Front`. Only the city/state tail is parsed; the street line is not used for matching.
- **Same business, two profiles.** Google itself has duplicates (an old profile plus a claimed one). Same-name-same-city entries are deduped in-batch by the existing name key.

### Interaction with the name-key strength gate

`run.ts` will not merge two companies on a normalised name key that the suffix
stripper reduced to a single generic word — "Smith Group" and "Smith Holdings"
both become `smith`, and merging on that discards a real company.

The in-batch dedupe in this source honours the same `companyNameKeyStrength`
gate, and it must: this pass can only *drop* rows, and a row it drops never
reaches the database dedupe to be matched properly. Being stricter here than the
pass downstream of it would be an outright bug, not a conservative choice. A
company with no usable key at all is kept — a duplicate the operator can see and
reject beats a real company silently discarded.

Incidentally this gate also reduces the DBA/trade-name risk above, because it
prevents the most dangerous class of accidental merge on Maps titles, which are
often short and generic.

### What I did not do

No fuzzy or probabilistic matching (trigram similarity, address-based clustering, `place_id` persisted as an external identity). Persisting Maps `place_id` / `data_cid` would be the principled fix for franchise and multi-office cases — it is a stable Google identity — but it needs a schema column, and this project has a documented history of production 500s from unapplied migrations. Deliberately deferred. See §10.

---

## 6. Free qualification layer — spending nothing before the operator approves

Everything here runs on SERP-level data only, before any credit is spent. The design principle inherited from `icp-scorer.ts` — *deterministic exclusions reject, patterns only deprioritize, ambiguity defaults to keep* — is preserved.

**Rejected at the source, before the company is written to the database** (these never reach the operator, because they are not merely low-quality, they are the wrong kind of entity):

1. **Staffing agencies and recruiters** — the existing `patterns.staffing_patterns` from `config/icp-config.json` (`\bstaffing\b`, `\brecruiting\b`, `\bexecutive search\b`, `\btalent solutions\b`, `\bemployment agency\b`, …) applied to the Maps `title`, **plus** the Maps category (`type`/`types`), which is strictly better data than a name: Google's own `Employment agency` / `Recruiter` / `Temp agency` categories are a direct self-declaration. Reusing the existing config means one place to edit and no divergence from the job-scrape path. **This is a real competitive-intelligence win of Maps over Apollo: Google makes recruiters label themselves.**
2. **Government and public sector** — existing `patterns.gov_patterns` on the title, plus a `.gov` / `.mil` domain check, plus government-ish Maps categories.
3. **Schools and hospital systems** — existing `school_patterns` / `hospital_system_patterns`.
4. **Fortune 500/1000, national retailers, known large private** — existing `known_lists` exact-name matching via the same normalization `icp-scorer` uses.
5. **Not a company** — no name, or a Maps category that is not an employer (`Post office`, `Park`, `ATM`).
6. **Out of market** — the `address` state does not match the requested market's state. Google's local search happily drifts across a metro boundary; the docs themselves warn results are "not guaranteed to be within the requested geographic location."
7. **Already in `companies`** — dedupe (§5), including companies already reviewed and rejected.

**Kept but deprioritized** (annotation only — never a filter, per the ICP module's prime directive): unknown headcount (all of them, by construction), pattern-only exclusion matches below confidence 1.0, `large_company_hint` names, very low review counts.

**Not spent, at any point in discovery:** zero Apollo credits, zero ContactOut credits, zero per-company SerpApi searches. The credit boundary stays exactly where it is — the operator's Approve for Enrichment button — and exactly one decision-maker is found per approved company.

---

## 7. Recommendation

**Add SerpApi Google Maps as a supplementary discovery source, flag-off by default, metered through the same guardrails as Apollo, for Construction first and Legal second.** Do not touch the Apollo path, do not change the schema, do not remove anything.

### Cost table (summary)

| Path | Unit cost | Records/unit | Per 100 companies | Verdict |
|---|---|---|---|---|
| Apollo org search (as run today) | 1 credit ≈ $0.0196 | up to 100 | **$0.16** / 8 credits | Keep as primary |
| SerpApi `google_maps`, fresh market | 1 search ≈ $0.010 | 20 | **~$0.13** / ~13 searches | Add for Construction + Legal |
| SerpApi `google_maps`, saturated market | 1 search ≈ $0.010 | 20 | **~$0.50** / ~50 searches | Yield gate must stop this |
| SerpApi `google` per-company LinkedIn lookup | 1 search ≈ $0.010 | 1 | **$1.00** / 100 searches | **Never in discovery** |
| ContactOut / Apollo people reveal | ~2 credits/contact | 1 | n/a | Only after Approve |

---

## 8. What I would not do

- **Would not replace Apollo with SerpApi.** Maps has no headcount and no LinkedIn URL. The operator's targeting is headcount-banded. Removing Apollo would break the core filter.
- **Would not crawl company websites for phone numbers or employee counts.** Outside the Legal Shield, our IPs, our robots.txt problem, and the "estimated size from a website" signal is bad anyway.
- **Would not scrape LinkedIn**, directly or through a headless browser, at any volume, for any field.
- **Would not run per-company SerpApi lookups during discovery.** 1 search per company is 6× the entire current Apollo discovery bill (§2).
- **Would not enable SerpApi for General Professional Services.** The vertical's keywords do not map onto Google Business categories; queries would return noise, and noise is paid for by the search.
- **Would not add a `discovery_source` column, a `place_id` column, or a `leadSource` enum value.** In particular: **`companies.leadSource` is not a data-provenance field.** Reading `schema.ts`, it is the *consent lane* (`cold_discovery` / `inbound_form` / `inbound_meta`) that decides which outreach channels are legal. Adding `serpapi` to it would corrupt consent logic — a company discovered via Maps is still `cold_discovery`. The brief suggested this as the cheap path; it is the wrong column. Provenance, when needed, belongs in `provider_usage_events.metadata` (already recorded, no migration) or a new nullable column later.
- **Would not let a SerpApi failure or cap break an Apollo run.** The source is additive; when it is off, blocked, or erroring, the run must return the Apollo results and say why SerpApi contributed nothing.
- **Would not "fix" the worker's over-counting of failed searches.** SerpApi does not bill failures, so the worker over-counts — which fails safe by skipping Google early. That is the correct direction for a spend guard.
- **Would not auto-enable it.** The key is not on Vercel, no yield has been measured, and the shared monthly quota belongs to the job scrape until someone decides otherwise.

---

## 9. What the operator must do before it does anything

1. Add `SERPAPI_API_KEY` to **Vercel** (it currently lives only on the Mac worker). Same key, same value.
2. Set `SERPAPI_DISCOVERY_ENABLED=true` on Vercel. **Default is off**; the key alone does nothing.
3. Optional caps, all documented in `.env.example`: `SERPAPI_DAILY_CREDIT_CAP` (default 400 searches/day ≈ 12,000/month ÷ 30), `SERPAPI_DISCOVERY_RUN_CAP` (default 12 searches/run), `SERPAPI_DISCOVERY_VERTICALS` (default `construction,legal`).
4. **No migration.** No schema change. `provider_usage_events.provider` is a `text` column and already carries `'serpapi'` rows from the worker; the discovery cursor reuses `company_discovery_runs` with a new `pool` **value** (`serpapi_maps`) in an existing `text` column.

Start with one vertical in one market, run it for a few days, and read the `searchesSpent` / net-new counts in the run summary before widening. The yield numbers in §2 are estimates, and the whole recommendation should be re-litigated against real ones.

---

## 10. Future work, deliberately not implemented

Ordered by value per unit of risk.

1. **Evaluate `google_local_services`** for the trades. Google Guaranteed is a strong licensed-and-spending signal, and it is the Google surface built for exactly the Construction vertical.
2. **Marginal-yield pagination**, ported from `worker/src/serpapi_google.py`. Stop paging when the net-new ratio drops below `GOOGLE_PAGE_MIN_YIELD`, rather than a flat per-run cap. This is the fix for the saturated-market cost blow-up in §2, and the logic already exists in Python — it needs porting, not inventing.
3. **Geographic grid expansion.** Maps caps at ~120 results per query+location, so sustaining 25/day per vertical needs a (query seed × city) grid. `src/lib/state-geo-config.ts` and `src/lib/google-zones.ts` already contain hub-city grids for the job scrape and are the obvious input.
4. **Persist Maps `place_id` / `data_cid`** as a nullable column, to fix franchise and multi-office identity properly (§5).
5. **`site:linkedin.com/company` lookup for approved companies only** — 1 search per company, post-Approve, capped. Fills the one field Maps structurally cannot.
6. **Surface `reviews` / `rating`** as an ICP size proxy for headcount-unknown companies, so the operator has something better than "size unknown" to triage on.
7. **Show the SerpApi pool cursor in the launcher UI.** Currently `getDiscoveryPoolStatuses` only reports the two Apollo pools; the SerpApi cursor is reported in run-summary notes instead.
8. **Teach `vertical-evidence.ts` about Google Business categories.** `verticalEvidence` matches `companies.industry` *exactly* against Apollo's taxonomy, so a Maps industry ("Roofing contractor", "Law firm") can never confirm a vertical on the industry leg — it falls through to the name leg. In practice construction is fine, because `name_any` already contains `roofing`, `hvac`, `plumbing`, `contractor`; Legal is weaker, because a Maps title like "Smith & Jones, P.A." matches none of `llp`/`pllc`/`law`/`attorney` and lands as *unverified*.

   Two consequences worth knowing, neither of which is a correctness bug:
   - a Maps company reads "found via Legal search" rather than a confirmed badge. That is honest — Apollo genuinely has not confirmed anything — but the reason text says "Apollo returned nothing that confirms…", which is misleading when Apollo never saw the company at all;
   - `preferredIndustry` treats a Google category as a real industry (it is not a coarse rollup), so once Maps writes "Roofing contractor" a later Apollo industry will not replace it. Arguably correct, since the Google category is more specific, but it does permanently close the industry-leg confirmation path for that company.

   The fix is a category → Apollo-industry mapping, or an `industry_any` list that accepts Google categories. Left alone here because `vertical-evidence.ts` and `review-queue.ts` were being actively changed alongside this work.

---

## 11. Problems found in the existing discovery code (out of scope, worth fixing)

Found while reading, not touched by this change:

1. **`run.ts` requests `per_page: limit` (default 25) for the sized pass.** Apollo bills 1 credit for up to 100 organizations either way, so the default run pays a full credit for a quarter of a page. The unknown-size pass already gets this right (`UNKNOWN_SIZE_PER_PAGE = 100`). Fetching 100 and slicing to `limit` would quadruple the candidate pool for the same credit — and, because `advanceCursor` counts `returned`, would also advance the cursor faster and reach pool exhaustion sooner, which is genuine information the operator wants. **The clearest available cost win in the discovery path, and it is free.**
2. **`buildDedupeIndex()` selects every row of `companies` on every run.** Fine at a few thousand rows, a problem at 50,000 inside a 120-second Vercel function (`maxDuration = 120`). It will degrade gradually and then fail.
3. **Discovery labels itself with a fake manual-enrich context.** `manualEnrichContext(\`discovery:${vertical}:${market}\`)` produces `manual_enrich:discovery:legal:...` purely to satisfy `assertPaidEgressAllowed`, which rejects every non-`manual_enrich` context outright. The gate's own audit trail therefore cannot distinguish an operator clicking Approve from an automated discovery sweep — and that distinction is the entire point of the gate. A `discovery_search` context that is allowed but separately capped would be more honest. (My SerpApi source inherits this pattern rather than diverging from it mid-change.)
4. **Apollo endpoint path may be stale.** The code calls `POST /api/v1/organizations/search`; Apollo's current docs document Organization Search as `POST /api/v1/mixed_companies/search`. The code defensively reads `data.organizations ?? data.accounts`, which suggests someone already hit a response-shape difference. It evidently still works today, so this is a "verify before it breaks" item, not a bug I can confirm.
5. **Apollo's 50,000-record display limit is not modelled.** `advanceCursor` treats a short page as pool exhaustion, which happens to cover it, but the 500-page ceiling is a distinct condition that would be reported to the operator as "pool exhausted, rotate market" when the truth is "add more filters."
6. **`companies.phone` is documented as Apollo-only.** The comment on `phoneClassification` says "Apollo organization search is the only writer of that column." After this change that is no longer true — Maps also writes it. The default `business_line` remains correct (a Google Business Profile phone is a published main line, not a personal mobile), but the comment is now stale and anyone reasoning about dial safety from it would be misled.
