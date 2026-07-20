# V Executive Search

Automated recruiter list pipeline: scrape job postings from multiple boards, rank the market for free, enrich contacts only when you choose, and surface a daily outreach list.

## Structure

```
├── worker/     Python pipeline (one home Mac — launchd + JobSpy)
├── src/        Next.js CRM app (Vercel + Neon)
└── package.json
```

## What runs automatically

On a **home Mac worker** (launchd), twice daily at **5 AM and 6 PM ET**:

1. **Scrape** — JobSpy pulls jobs from boards enabled in `/admin` (default: Indeed, LinkedIn, ZipRecruiter; Google Jobs via SerpApi when keyed)
2. **Dedupe** — collapse listings to companies; skip domains already in CRM
3. **Sync** — chunked jobs-only ingest to Neon via Vercel `/api/ingest` (avoids Vercel body-size 413s on large markets)
4. **Score / hygiene** — free backlog rescore, stale-listing archive, presence checks
5. **Email** — **07:45 ET** call-sheet report via Resend (waits for morning ingest if Stage 1 is still running)

**Paid enrichment (Apollo / ContactOut) is manual-only** — use **Find contacts** on a company card. Scheduled jobs must not spend provider credits.

**Canonical CRM:** `https://v-executive-search-delta.vercel.app` (never the legacy `v-executive-search.vercel.app` host).

Admin **Run now** uses the same scrape-only / jobs-only path via a 5-minute poll. Google Jobs uses **SerpApi** when keyed (AM weekdays by default — see [DEPLOY.md](DEPLOY.md)).

## The CRM app (`/crm` is the home page)

`/crm` (**Pipeline**) is the consolidated book of business — all markets, all dates, decoupled from the Admin scrape focus. Tabs: **All Leads · Job Listings · Call List · Hot**, with a State→City rail, ICP fit scoring/filters, and a persistent Call List (12 statuses, follow-ups, CSV). **Runs** (`/runs`) is a Market/Credits/Health ledger. **Legacy** (`/legacy`, off-menu) preserves the old Today's List + Companies views.

**Selective enrichment (discovery → reveal):** "Find contacts" runs one reveal-off Apollo search (cached per company, zero reveal credits); a picker pre-selects the best contact; reveal spends credits only on your pick — **ContactOut-first** (personal email top 2, mobile top 3), Apollo phone as last resort, phone opt-in, never re-revealed. Discovery targets a **sector-aware allowlist** (`config/contact-targets.json`; law firms first). See `docs/V-EXECUTIVE-SEARCH-SYSTEM.md`.

## Quick start

### CRM (local or Vercel)

```bash
npm install
cp .env.example .env.local   # DATABASE_URL, WORKER_API_KEY, APOLLO_API_KEY
npm run db:push
npm run dev
```

Open `/admin` to set **state + market** (grounded geo presets), job title searches, **job boards**, and notification email.

### Worker (Mac mini — not your dev MacBook unless testing)

Prefer a **promoted release checkout** (see [DEPLOY.md](DEPLOY.md) → Worker release promotion):

```bash
# Canonical secrets (outside git checkouts)
cp worker/.env.example ~/.vsearch/worker.env   # then edit

# From an editable clone that tracks the repo:
WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12 \
  bash worker/scripts/bootstrap_release.sh

# Verify launchd points at the release worktree
bash worker/scripts/verify_release_launchd.sh
```

For a one-off local test without bootstrap:

```bash
cd worker
./scripts/setup_mac.sh
# Edit worker/.env → CRM_API_URL, CRM_API_KEY, API keys
python scripts/health_check.py
python scripts/run_daily.py --dry-run
```

### Connect worker → CRM

In the **canonical** env file (`~/.vsearch/worker.env` after bootstrap):

```env
CRM_API_URL=https://v-executive-search-delta.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY on Vercel>
CONTACTOUT_API_KEY=<ContactOut API token>
# SERPAPI_API_KEY=...   # Google Jobs on the Mac worker
```

## Admin configuration (no redeploy needed)

| Setting | Where | Notes |
|---------|-------|-------|
| **State + Market** | `/admin` | 14 states / 61 OMB–Census-grounded metro presets; Market reload sets cities, counties, hubs, aliases |
| Job title / focus keywords | `/admin` | Active profiles × geo zones; optional legal/HR/finance focus keywords |
| **Job boards** | `/admin` | Indeed, Google, LinkedIn, ZipRecruiter, Glassdoor |
| Notification email | `/admin` | Daily report recipient |
| Run now | `/admin` | Worker picks up within 5 minutes (scrape-only) |

Cross-state metros keep true hub states (e.g. Charlotte includes **Rock Hill, SC**). Coverage and exclusions: [docs/state-geo-expanded-coverage.md](docs/state-geo-expanded-coverage.md).

## Documentation

| Doc | When to read |
|-----|----------------|
| **[DEPLOY.md](DEPLOY.md)** | New Vercel env, Neon DB, Mac worker, **bootstrap / promote**, SerpApi, Outreach IMAP |
| [docs/OPS-CHANGELOG-JUL-2026.md](docs/OPS-CHANGELOG-JUL-2026.md) | Jul 2026 ops: SerpApi, PR #18 email wait, ICP annotate, **PR #14 pending** |
| [worker/README.md](worker/README.md) | Worker scripts, launchd, JobSpy boards, LinkedIn posters, ContactOut API |
| [docs/V-EXECUTIVE-SEARCH-SYSTEM.md](docs/V-EXECUTIVE-SEARCH-SYSTEM.md) | Product + pipeline operating model |
| [docs/V-Executive-Search-Playbook.md](docs/V-Executive-Search-Playbook.md) | Operator playbook (keep in sync with system guide) |
| [docs/state-geo-expanded-coverage.md](docs/state-geo-expanded-coverage.md) | Per-market Census/OMB counties and excluded hubs |
| [Playwright/README.md](Playwright/README.md) | **Archived** dashboard automation (not in production) |

**Important:** Scraping and launchd run on **one home Mac** with a residential IP. Vercel hosts the CRM only. After every `worker-production` tip move, **bootstrap** on the mini (`WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12`) — never mid-scrape. Your MacBook browser is enough for `/admin` unless it *is* the worker Mac.

**PR #14 (Outreach Sequencer)** is pending weekend stress-test before merge — see OPS changelog.
