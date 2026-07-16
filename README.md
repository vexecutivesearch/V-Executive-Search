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
5. **Email** — daily HTML call-sheet report via Resend

**Paid enrichment (Apollo / ContactOut) is manual-only** — use Enrich on a company card. Scheduled jobs must not spend provider credits.

Admin **Run now** uses the same scrape-only / jobs-only path via a 5-minute poll.

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
CRM_API_URL=https://your-app.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY on Vercel>
CONTACTOUT_API_KEY=<ContactOut API token>
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
| **[DEPLOY.md](DEPLOY.md)** | New Vercel env, Neon DB, Mac worker, **release promotion**, env vars |
| [worker/README.md](worker/README.md) | Worker scripts, launchd, JobSpy boards, LinkedIn posters, ContactOut API |
| [docs/V-EXECUTIVE-SEARCH-SYSTEM.md](docs/V-EXECUTIVE-SEARCH-SYSTEM.md) | Product + pipeline operating model |
| [docs/state-geo-expanded-coverage.md](docs/state-geo-expanded-coverage.md) | Per-market Census/OMB counties and excluded hubs |
| [Playwright/README.md](Playwright/README.md) | **Archived** dashboard automation (not in production) |

**Important:** Scraping and launchd run on **one home Mac** with a residential IP. Vercel hosts the CRM only. Your MacBook browser is enough for `/admin` — it does not need the worker installed unless it *is* the worker Mac.
