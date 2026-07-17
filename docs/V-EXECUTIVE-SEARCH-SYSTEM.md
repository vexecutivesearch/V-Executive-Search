# V Executive Search — Complete System Guide

**For:** Alejandro Lozano · Proven Theory / V Executive Search  
**Purpose:** Everything in one place — what this system is, what it does, how to use it daily, and the full technical pipeline spec.

**Shareable PDF:** [`docs/V-Executive-Search-Playbook.pdf`](V-Executive-Search-Playbook.pdf)

---

## Executive summary

V Executive Search is a **recruiting operating system** built for one recruiter working focused metro markets (DB-backed presets across **14 states / 61 markets** — e.g. Charlotte, NC–SC; Florida markets including West Palm Beach). It runs overnight on a home Mac, ranks the local hiring market for free, spends paid enrichment credits only when you manually Enrich a lead you will call, and delivers a **ranked call sheet** to your inbox by ~6 AM.

Your job is not to hunt listings, build spreadsheets, or update a CRM after the fact. Your job is to **pick up the phone and have the conversation** — with a reason to call, a suggested opener, and the best contact channel already surfaced.

The system follows one rule:

> **Scrape wide and free. Score for free. Spend credits only on leads you choose to Enrich and call.**

That design cut projected enrichment spend from ~$4,500/month (enrich-everything) to a small manual budget while **increasing** market coverage, because the backlog compounds every night without costing more.

---

## What this system is

Think of it as three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  YOU (Alejandro)                                                 │
│  Phone · judgment · relationships · closing                      │
│  Interfaces: 6 AM email · /crm Pipeline · /admin from phone       │
└────────────────────────────▲────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────┐
│  CRM (Vercel + Neon)                                             │
│  Pipeline (All Leads · Job Listings · Call List · Hot) · Runs    │
│  Lead scoring · ICP fit scoring · selective enrich · openers     │
└────────────────────────────▲────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────┴────────────────────────────────────┐
│  Mac worker (always-on, residential IP)                          │
│  Scrape · chunked jobs-only ingest · rescore · iMessage · email  │
│  Paid Apollo/ContactOut only via manual Enrich                   │
└──────────────────────────────────────────────────────────────────┘
```

| Layer | Role |
|-------|------|
| **Mac worker** | Does the repetitive market-scanning work job boards block from cloud servers. Runs on a schedule while you sleep. |
| **CRM** | Stores every company, job, contact, score, and note. Ranks the backlog. Hosts the UI you work from. |
| **You** | Works the call sheet. Logs outcomes. Moves deals forward. The system never replaces the live conversation. |

**What it is not:** a mass-email blaster, a LinkedIn automation bot, or a VA replacement for judgment. Outbound sequences and cold SMS are explicitly out of scope — human-initiated outreach only.

---

## What it can do today

### Market intelligence (free, every night)

- Scrapes **Indeed, Google Jobs, LinkedIn, and ZipRecruiter** for your active title searches in your geo focus.
- Deduplicates by company and tracks **job resights** — when the same posting appears again, the system counts it instead of silently skipping it.
- Resolves company domains via Apollo org search (no enrichment credits).
- Filters to your **ICP**: company size band, staffing-agency blocklist, in-focus geography, HR-only deprioritization.
- Detects **hiring-pain signals** from scraped data alone:
  - Same role reposted 3× in 21 days
  - Multiple simultaneous openings
  - Long-running postings (21+ days)
  - New location clusters
  - New companies on today's list
- Persists a **lead score** and **reason to call** on every company — ranked best-first.

### Just-in-time enrichment (paid, **manual**) — discovery → reveal-on-selection

Enrich is a **two-stage split** (July 2026) so you pay reveal credits only for the person you'll actually call:

1. **Discovery (reveal-off).** "Find contacts" runs one Apollo people-search with **no email/phone revealed → zero reveal credits**. It returns candidate decision-makers (name, title, LinkedIn, location). The result is **cached per company** (`companies.discovery_completed_at`), so the search credit is paid **once, ever** — re-opening the picker never re-searches. Discovery de-dupes, caps at the top 8, and drops non-person junk records (e.g. company/license entities).
2. **Reveal (paid, per selection).** A **contact picker** ranks candidates by decision-maker relevance, pre-selects the single best, and shows an **honest cost preview** (search cost + reveal cost, never only reveal). You reveal the chosen contact(s); **phone is opt-in per contact** (scarcest credit).

**The reveal waterfall (ContactOut-first):**
- **Apollo people/match** (1 credit) resolves the real full name (search results obfuscate the last name), work email, and the LinkedIn URL.
- **ContactOut** is the **primary source** for personal email (top 2) and mobile (top 3 direct cells) — requested even when an Apollo phone already exists, so the ContactOut cell is preferred.
- **Apollo phone reveal** (8 credits) is the **last resort** only when ContactOut can't run (no LinkedIn URL / locked / no cell found); it arrives async via webhook.
- **Never re-reveal.** Saved contacts are free to view; a saved contact can still be *refreshed* through ContactOut to add a personal email / cell it's missing (email already paid is never re-charged).
- Short-code / hotline numbers (e.g. an "16224" corporate line) are rejected — never stored or shown as a callable number.

**Sector-aware contact targeting (Feature 2, config-driven).** Discovery searches an **allowlist** of decision-maker titles per detected sector + firm size — so it never wastes a search on titles you don't want. Law firms are the first sector:
- **Legal detection is strong-signal only:** sector = legal, or a strong name pattern (`LLP`, `PLLC`, `Attorneys at Law`, `Law Firm`, `Law Offices`). Weak patterns (`& Associates`, `Group`, `Partners`) alone → generic targeting (a consulting "Smith & Associates" is not a law firm).
- **Small firms** (≤ ~50): Managing Partner → Founder/Named Partner → Firm Administrator → HR Manager.
- **Larger firms:** HR Director → Recruiting Director → Legal Recruiting Manager → Firm Administrator → Executive Director → Office Managing Partner.
- **Unknown size → searches the union of both lists in one pass** (deduped) so a wrong guess never costs a second search credit; ranks by band once size is known.
- Litigation chairs / practice-group leaders / department chairs / extra partners are **never searched** (not on the allowlist). Config lives in `config/contact-targets.json`; other sectors extend it without code.

- **Domain backfill** still runs before enrich so companies without domains get a second chance via Apollo org search.
- All calls keep the `manual_enrich:<companyId>` egress gate, per-endpoint usage logging, and daily credit cap. ContactOut exhaustion triggers an alert email.

> **Worker note:** the sector-aware targeting and discovery/reveal split live in the **web app**. Scheduled Mac-mini runs are scrape-only and do not enrich, so they don't use this logic. The worker's own Python enrich path (`worker/src/enrich/`) still uses a flat title list and is dormant unless enrichment is explicitly run on the worker.

### Delivery & prep (free)

- **6 AM call sheet email** — ranked company cards, not a table dump:
  - Funnel header: `Scraped → ICP match → Enriched · Credits`
  - Rank, score badge, contact, **why now**, channel chips, job title, CRM link
  - Top-3 "call first" summary line
  - Haiku-generated **suggested opener** when `ANTHROPIC_API_KEY` is set
- **iMessage check** on personal emails (Mac Messages API) — blue bubble vs SMS-only before you text.
- **Email MX verification** — flags deliverable vs risky addresses on new contacts.

### Pipeline CRM (`/crm` — the home page)

`/crm` is the default landing page (`/` and the logo both open it). It is the **whole book of business — all markets, all dates — decoupled from the Admin scrape focus and today's date.** You navigate by filters, not a date picker. Left rail is **State → City** (expandable, counts from real listing locations); header shows KPI cards (Total companies, Enriched, Hot signals, Due today). Four tabs:

| Tab | What you see |
|-----|----------------|
| **All Leads** (default) | Every scored company, all markets/dates, server-paginated (500/page). Rows show score, **Enriched** / **Discovered (n)** badges, ICP score, role type, comp. Action progresses **Find contacts → Add to Call List → Open**. |
| **Job Listings** | The raw firehose — one row per posting (reposts shown individually with a "reposted N×" badge), market/board/search filters, **Find contacts** per row. |
| **Call List** | The persistent calling workspace (below). |
| **Hot** | All Leads pre-filtered to active hiring signals. |

**Filters (server-side, before the pagination cap):** State, City, Sector, Status, search, Callable-only, Enriched-only, **Discovered-only**, plus **ICP** filters — Role type, Company size, Comp ≥ (with include-estimated), ICP ≥, and per-category **Hide toggles** (Fortune / gov / schools / hospitals / staffing / third-party, all default OFF — bad fits *sink*, they're never removed; "show deprioritized" restores them). Multi-location companies surface the **filter-matching listing** first (Virginia shows the VA job, not an out-of-state one). Filtered CSV export.

**ICP fit scoring** (annotation-only, `company_icp` table). Every lead gets a dual score: `base_lead_score → icp_adjusted_score` (recruiter-fit multiplier + role/size/comp/private adjustments), plus exclusion flags with per-flag confidence, role type, comp estimate, size band. The default sort is **ICP fit** — Fortune 500 / big-box / hospital-system leads sink below mid-size private professional-role leads but stay reachable. Deterministic hard-excludes (exact Fortune/known-agency name, `.gov`) are the only hide-eligible flags; everything pattern-based only deprioritizes.

### Call List (`/crm?tab=call-list`)

After a company is enriched, **"Add to Call List: Yes/No"** promotes it into a persistent, trackable queue (also a retroactive "Add to Call List" button + "On Call List" badge). One entry per company (switchable primary contact). Tracks **12 call statuses** (New, Ready to Call, Called — No Answer, Voicemail Left, Spoke — Follow-Up Needed, Email Sent, Meeting Scheduled, Proposal Sent, Client Won, Not Interested, Bad Contact, Do Not Contact), attempts (auto-incremented on outreach statuses), last-contact + next-follow-up dates, notes, assigned team member, outreach angle, final result. Overdue follow-ups sort first; terminal statuses collapse into a "Closed" section; Do Not Contact locks outreach; every change also writes the company activity log. CSV export includes all 19 fields.

### Runs (`/runs`) — rebuilt ledger

One row per scheduled batch: Run · **Market** · Listings · New companies · Enriched · **Credits** (highlighted when nonzero — a silent drain shows at a glance) · Health pill (healthy / board-gap warn / no run), with the funnel/draw detail behind an expand.

### Legacy (`/legacy`) — the old views, preserved

The original **Today's List** (date-scoped call sheet + backlog + hot tabs) and **Companies** (leads + job listings) pages are merged under `/legacy` as two tabs, unchanged in behavior. Legacy is **removed from the nav menu** but reachable directly (a rollback/safety net during the Pipeline transition). `/today` and `/companies` still resolve.

### Company detail (`/companies/[id]`)

Full job history, contacts (with all channels + verification badges), **activity timeline**, and the discovery/reveal contact picker. **Log call:** paste transcript → AI summary → save → mark contacted in one flow.

### Admin (`/admin` from phone or laptop)

- **State + Market** — 14 states / 61 OMB–Census-grounded metros; Market reloads cities, counties, hubs, aliases (cross-state hubs keep true state, e.g. Rock Hill, SC)
- Job board toggles (A/B which sources produce net-new companies)
- Active title searches and optional focus keywords (legal/HR/finance/etc.)
- **Enrichment quotas:** still configure thresholds for when you Enrich; scheduled paid egress stays off
- **Worker status** — release SHA / drift vs `origin/worker-production`
- **Run now** — triggers scrape-only/jobs-only ingest from anywhere; worker polls every 5 minutes

### Hygiene (automatic)

- **06:15** — archive job listings not seen in 45+ days
- **06:30 / 18:30** — rescore entire backlog (free)
- Credit alerts when ContactOut phone API locks
- Pipeline health check before enrich (won't run against stale CRM)

---

## Alejandro's ideal day with this system

This is the workflow the system is designed around:

| Time | You | The system |
|------|-----|------------|
| **Before 6 AM** | Sleep | Scrape → chunked jobs-only ingest → filter → score → presence checks → build email |
| **6:00 AM** | Open call sheet email on phone | Ranked leads with reasons, channels, openers (enriched rows you already worked) |
| **6:15 AM** | Skim top 3, open `/crm` (Pipeline) | Full detail, filter by market for context |
| **7:00–11:00** | **Call block** — work the sheet top-down | — |
| **Per call** | Read opener chip → dial → converse | — |
| **After each call** | Expand row → Log call → paste notes → Save & mark contacted | Haiku summarizes, updates timeline |
| **11:30 AM** | Check backlog tab for anything that heated up overnight | Rescored automatically |
| **Ad hoc** | Hit Enrich on a company from backlog before calling | Manual paid egress only |
| **Anytime** | Admin → Run now if you want a fresh pull before a trip | Worker runs within 5 min |

**Time you no longer spend:**

- Manually scanning job boards
- Building daily lead lists in spreadsheets
- Guessing which companies are "hot" vs noise
- Enriching companies you won't call
- Writing CRM notes from memory at end of day
- Wondering if a number is iMessage-capable

---

## How this increases your daily productivity

### 1. Decision quality before the first dial

**Before:** You start the day with a flat list. Every row looks equally urgent. You burn mental energy prioritizing instead of selling.

**Now:** Every lead arrives with a **score**, a **reason to call**, and a **suggested opener** tied to a real hiring signal. You begin at rank #1 with conviction.

*Productivity gain:* Less context-switching, higher connect-to-conversation rate, fewer "why am I calling this person?" moments.

### 2. Capacity-matched spend

**Before:** Enrichment scaled with market size (~50k credits/month). You paid to research companies you'd never reach.

**Now:** Credits scale with **your call capacity** (25/day default). The backlog holds the rest for free until signals push them up.

*Productivity gain:* Budget stays predictable; you can raise N when you add capacity, not when the market grows.

### 3. Compounding backlog intelligence

**Before:** A reposted role looked like a duplicate and was skipped.

**Now:** Resights increment a counter. A role posted 4× in 3 weeks auto-climbs the ranking. You call companies when they're **desperate**, not when you happen to notice.

*Productivity gain:* The system gets smarter every night without you doing anything.

### 4. Channel clarity at a glance

**Before:** You discover mid-call that you only have a work email, or you text a green-bubble number cold.

**Now:** Call sheet shows personal email · mobile · **iMessage ✓** · MX ✓ before you choose how to reach out.

*Productivity gain:* Right channel, first attempt. Fewer dead ends.

### 5. Zero-lag CRM hygiene

**Before:** "I'll update the CRM later" → pipeline goes stale, follow-ups slip.

**Now:** Log call modal on company detail: paste transcript → AI summary → one-click mark contacted. Activity timeline is the source of truth.

*Productivity gain:* Admin work happens in 30 seconds between calls, not in a painful end-of-day batch.

### 6. Mobile-first control

**Before:** Pipeline only runs on a schedule you can't trigger.

**Now:** `/admin` → Run now from your phone. Change geo, boards, or enrichment N without a deploy.

*Productivity gain:* You're never blocked waiting for the next cron window.

---

## The productivity equation

Rough framing for one recruiter:

| Metric | v1 (enrich all) | v2 (JIT + funnel) |
|--------|-----------------|-------------------|
| Companies researched/month | ~all net-new | ~550 enriched + full backlog scored |
| Monthly enrichment cost | ~$4,500 | ~$200 |
| Daily call-ready leads | Variable (data dump) | 12–25 ranked with reasons |
| Time to first dial | 45–90 min list prep | ~15 min email skim |
| CRM update lag | Hours to days | Seconds per call |

**The leverage:** If you save 60 minutes of prep and 30 minutes of admin per day, that's **7.5 hours/week** returned to live conversations — roughly one extra calling block without hiring anyone.

---

## What you control vs what runs automatically

| You control | Runs automatically |
|-------------|-------------------|
| Which market (geo, titles, boards) | Nightly scrape + ingest |
| Daily enrich quota (N) | ICP filter + scoring |
| Score thresholds | Top-N cut + enrich |
| Who you call and what you say | Call sheet email |
| Call notes and status | iMessage + email verify |
| Manual Enrich on hot backlog picks | Opener generation (with API key) |
| Run now from admin | Stale listing archive |
| | Credit alerts |

---

## Interfaces cheat sheet

| URL | Use when |
|-----|----------|
| `https://v-executive-search.vercel.app/` → `/crm` | **Home / daily driver** — Pipeline: All Leads · Job Listings · Call List · Hot, filter by market/state/city |
| `https://v-executive-search.vercel.app/crm?tab=call-list` | Work the persistent call queue (statuses, follow-ups, notes) |
| `https://v-executive-search.vercel.app/runs` | Run health + credits per scrape |
| `https://v-executive-search.vercel.app/companies/[id]` | Deep dive + find/reveal contacts + log call + activity history |
| `https://v-executive-search.vercel.app/legacy` | Old Today's List + Companies views (out of the menu, still live) |
| `https://v-executive-search.vercel.app/admin` | Change settings, trigger runs from phone |
| **6 AM email** | First look — ranked leads + funnel stats |

---

## Further productivity gains (roadmap)

These are the highest-leverage next steps, ordered by impact on your daily output:

### Near-term (config + habits)

1. **Set `ANTHROPIC_API_KEY` on Vercel** — unlocks auto openers on every enriched lead and AI call summaries. Biggest single upgrade to "open email → start dialing."
2. **Tune N to your real call capacity** — if you consistently work 15 leads/day, set N=15 and raise min score threshold so every enriched lead is worth the credit.
3. **Work the sheet in rank order** — the system is only as good as your discipline to trust the score.
4. **Log every call same-day** — activity timeline compounds into placement intelligence over weeks.

### Medium-term (system extensions)

5. **Trigger-based prospect email** (spec §8) — short sequences (day 0 / 3 / 7) personalized off `reasonToCall`, sent from your domain, human-approved. Extends reach without replacing calls.
6. **Weekly hot-backlog digest** — email summary of top 10 backlog companies whose scores jumped (reposts, new openings). Lets you manually Enrich a strategic pick outside the daily batch.
7. **Callback reminders** — when AI classifies a call as "callback," surface it on tomorrow's call sheet header.
8. **Placement feedback loop** — tag which signals predicted placements; refine scoring weights over time.

### Longer-term (team scale)

9. **Per-recruiter call sheets** — when you add closers, each gets their own N slice from the shared backlog.
10. **More markets / multi-recruiter queues** — geo presets already cover 61 metros; next step is per-recruiter slices of the shared backlog, not inventing new city configs by hand.

---

## Operating principles (the "Neo line")

> The Mac holds the session warm, ranks the desperate, writes the opener — you pick up the phone and say the first human sentence.

- **Automate:** research, enrichment, ranking, logging, monitoring.
- **Preserve:** regulated sends, live conversation, judgment on fit.
- **Never:** cold SMS automation, LinkedIn DM bots, daily blasts to the same prospect.

---

## Appendix A: Lead Pipeline — Spec v2 (Just-In-Time Enrichment)

*Original technical spec — preserved in full.*

**For:** Proven Theory / V Executive Search recruiting pipeline  
**Model:** Mac mini (always-on) + Apollo + ContactOut + CRM  
**Assumption:** No VAs. Fully automated. One recruiter works the daily call sheet.

---

### 1. The core principle

**Enrich at the scale of your call capacity, not the scale of the market.**

Scraping is free (JobSpy). Enrichment costs credits. The v1 mistake was gluing them together — scrape then enrich everything — which projects to ~50,000 credits/month for one market. The fix: decouple them and move the money gate to the very last step.

> Scrape wide and free. Score for free. Spend credits only on the top-N leads a human will actually call today.

Result: same market coverage in the database, ~4% of the spend.

| | v1 (enrich all) | v2 (enrich call sheet) |
|---|---|---|
| Companies enriched / mo | ~all of WPB | 25/day × 22 = 550 |
| Credits / mo | ~50,000 | ~2,200 |
| Cost @ $0.09/credit | ~$4,500 | **~$200** |

---

### 2. The funnel (where each stage runs, and what it costs)

```
[1] SCRAPE          all listings, daily         FREE    Mac mini (residential IP)
      |
[2] FILTER to ICP   drop out-of-profile         FREE    rules only
      |
[3] SCORE & RANK    signals you already have     FREE    no credits
      |
[4] CUT to capacity top N (= daily call quota)   FREE    config knob
      |
[5] ENRICH slice    email + phone, just-in-time  PAID    Apollo → ContactOut API
      |
[6] DELIVER         daily call sheet email       FREE    the one human touchpoint
```

#### Stage 1 — Scrape (free)

JobSpy across Indeed, Google Jobs, LinkedIn, ZipRecruiter. Everything lands in a `companies` + `listings` store that just grows. Runs on the mini's residential IP.

#### Stage 2 — Filter to ICP (free)

Kill the pool before spending a cent:

- Company size outside **20–500 employees** → drop
- Staffing / recruiting agencies (competitors) → drop
- Out-of-vertical industries → drop
- Obvious internal TA team present → deprioritize

#### Stage 3 — Score & rank (free)

All signals derive from scraped data — **no enrichment needed to score**:

- Same role **reposted 3×** in N days → strong "they're struggling" signal
- **Multiple simultaneous openings** at one company
- **Posting age** (older open role = more pain)
- **Industry fit** vs placement history
- No internal-TA signal

Output: a ranked priority queue, best-first.

#### Stage 4 — Cut to capacity (free)

Take only the **top N** the recruiter can work today (start N = 25). This single number is the scalability knob — raise it when you add closers, never because the market got bigger.

#### Stage 5 — Enrich the slice (paid, just-in-time)

Only the top-N companies get enriched, at the moment they're pulled:

- **Apollo** = discovery: decision-maker name, title, `linkedin_url`
- **ContactOut API** (enrich by LinkedIn URL) = personal email + mobile
  - By-URL enrich = **2 credits** (email + phone), no search credit
- **Phone gating:** only request `include_phone=true` on score ≥ threshold — phone is the tightest cap. Use `email_type=none` where email isn't needed.
- **Fallback:** if ContactOut phone isn't on the current API plan, use Apollo mobile (as seen in testing). Waterfall keeps the best of each.

#### Stage 6 — Deliver (free)

The daily call sheet email (Section 4). The recruiter's only interface.

---

### 3. The backlog is an asset, not waste

Every scraped-but-not-worked company **stays in the queue and is re-scored for free** as new signals arrive. A role reposted again next week climbs the ranking on its own. You are building a compounding, ranked database of the entire market without paying to enrich it — and skimming the hot top each day.

Bonus: enriching at the moment of contact means the email/phone dialed was pulled days ago, not months. Just-in-time is **cheaper and fresher**.

---

### 4. The daily call sheet email

This is the pipeline's single output and the one human touchpoint. It replaces the old "list of everything." It is a **ranked, capacity-sized call sheet**, not a data dump.

**Header**

- Firm · market · date
- Funnel stats (show the whole funnel, not just "enriched: 2"):  
  `Scraped 340 → ICP match 48 → Enriched today 12 · Credits used 44`

**Body — ranked leads (best-first), each row:**

- Rank + score (color: green ≥ 80, amber 60–79)
- Contact: name · title · company (the decision-maker Apollo found)
- **Why now** — the single signal that scored them ("Reposted 3× in 21 days")
- Channel chips: personal email · mobile · **iMessage ✓** (native check on the mini)
- Source job title
- Link to the full record in the CRM

**Footer:** "Open full call sheet in CRM →"

Design rules:

- Only enriched top-N appear — never the whole scrape.
- Sorted by score. If nothing clears the score threshold, send a short "no hot leads today" note rather than padding the list.
- The email is the summary; the CRM holds full detail (notes, history, status).

---

### 5. Daily schedule (launchd on the mini)

| Time | Job | Cost |
|---|---|---|
| 06:00 | Scrape all boards → chunked jobs-only ingest | free |
| 06:15 | Archive stale listings | free |
| 06:30 | Filter ICP + re-score full backlog | free |
| 07:30 | Presence check (iMessage + email MX) | free |
| 07:45 | Build + send daily call sheet email | free |
| 18:00 | Scrape all boards → chunked jobs-only ingest | free |
| 18:30 | Filter ICP + re-score full backlog | free |
| every 5 min | Admin "Run now" poll, scrape-only by default | free |

Enrichment is manual only. Apollo and ContactOut paid egress must carry an
explicit per-company manual enrich context; scheduled jobs must not call paid
provider APIs.

Worker code ships via `origin/worker-production` + `bootstrap_release.sh` (see DEPLOY.md).
Large ingest payloads are chunked (~200 companies / ~3.5 MB) to avoid Vercel 413.

---

### 6. Credit governance

- Hard daily cap on enrichment (= N × avg contacts × credits) so a bug can't drain the balance.
- Phone reveals gated to score ≥ threshold.
- Alert the recruiter before hitting ContactOut's phone cap (tightest pool).
- Log credits/run in the digest header for visibility.

---

### 7. Scalability

The only knob is **N** (Stage 4). One recruiter → 25/day. Add a closer → 50. Team → 200. Spend and volume scale with the humans who can work the leads — never with the size of the market. That is the condensed, scalable model.

---

### 8. Later (not now): prospect outreach

The daily call sheet is *internal*. When you add outbound email to prospects, keep it **trigger-based** (personalized off the scoring signal), on a short sequence (day 0 / 3 / 7 then stop), sent from your domain, CAN-SPAM compliant (real identity + opt-out). Never a daily blast to the same person. This is a separate module from the digest above.

---

## Appendix B: Implementation status (as of July 2026)

| Spec item | Status |
|-----------|--------|
| JIT scrape → score → manual enrich | ✅ Live |
| Paid egress locked to manual Enrich | ✅ Live |
| ICP filter + hiring signals | ✅ Live |
| Call sheet + backlog CRM tabs | ✅ Live (now under `/legacy`) |
| **Pipeline CRM (`/crm`, home page): All Leads · Job Listings · Call List · Hot** | ✅ Live (Jul 2026) |
| **State → City location rail + KPI cards; server-side filters + pagination** | ✅ Live |
| **Market provenance (`companies.source_market`, `daily_runs.market`) + backfill** | ✅ Live |
| **ICP fit scoring (`company_icp`), dual score, sink-don't-hide filters** | ✅ Live |
| **Persistent Call List (12 statuses, attempts, follow-ups, assignee, notes, CSV)** | ✅ Live |
| **Selective enrichment: discovery→reveal split, cached search, contact picker** | ✅ Live |
| **ContactOut-first reveal waterfall; top-3 cells / top-2 personal emails; never re-reveal** | ✅ Live |
| **Sector-aware contact targeting (legal allowlist, size bands, union-on-unknown)** | ✅ Live (web app) |
| **Runs rebuilt as Market/Credits/Health ledger** | ✅ Live |
| **Legacy page (`/legacy`) preserving Today's List + Companies** | ✅ Live |
| Ranked email with funnel header | ✅ Live |
| Haiku openers | ✅ Live (requires `ANTHROPIC_API_KEY`) |
| Activity timeline + AI summarize | ✅ Live |
| iMessage + email MX presence | ✅ Live |
| Domain backfill before enrich | ✅ Live |
| Stale listing archive | ✅ Live |
| Credit alerts | ✅ Live |
| DB-backed geo (14 states / 61 markets, Census/OMB) | ✅ Live |
| Admin Market switch + cross-state hubs | ✅ Live |
| Worker release (`worker-production` + bootstrap) | ✅ Live |
| Chunked CRM ingest (Vercel 413-safe) | ✅ Live |
| LinkedIn hiring-team poster crawl (optional) | ✅ Live |
| Charlotte first-market scrape validation | ✅ Done (Jul 2026) |
| Trigger-based prospect email sequences | 🔜 Roadmap |

---

*Document version: 1.2 · July 2026 · V Executive Search / Proven Theory*
*v1.2 adds: Pipeline CRM (home page) with market/state/city rail, ICP fit scoring, persistent Call List, discovery→reveal selective enrichment with ContactOut-first waterfall and sector-aware (legal) contact targeting, rebuilt Runs ledger, and the Legacy page. See Appendix B.*
*Shareable twin: `docs/V-Executive-Search-Playbook.md` (keep in sync with this file).*
