# V Executive Search — Worker

Daily pipeline: **JobSpy scrape** (configurable boards) → dedupe → **chunked** jobs-only CRM ingest → free scoring/email. **Apollo** + **ContactOut** run only from an explicit per-company manual Enrich action.

## Setup

Prefer a **promoted release checkout** on the Mac mini (see [DEPLOY.md](../DEPLOY.md) → Worker release promotion). For local editable testing:

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
# Edit .env — required: APOLLO_API_KEY, CRM_API_URL, CRM_API_KEY
```

Canonical production secrets live at `~/.vsearch/worker.env` (bootstrap symlinks this into the release `worker/.env`).

## Run manually

```bash
source .venv/bin/activate
python scripts/run_daily.py              # scrape + ingest; scheduled enrich is disabled by default
python scripts/run_daily.py --dry-run    # scrape only (no Apollo credits)
python scripts/run_daily.py --scrape-only
python scripts/health_check.py           # smoke test; live Apollo probes are blocked
```

Faster scrape-only validation (skip LinkedIn hiring-team poster crawl):

```bash
LINKEDIN_FETCH_HIRING_TEAM=false python scripts/run_daily.py --scrape-only
```

### Promoting code to the Mac mini

Do **not** `git pull origin main` into the live launchd tree. Promote a tested SHA, then bootstrap:

```bash
# From any machine with push access:
git push origin <tested-sha>:refs/heads/worker-production

# On the mini, from the editable clone:
WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12 \
  bash worker/scripts/bootstrap_release.sh
bash worker/scripts/verify_release_launchd.sh
```

- Release source: `origin/worker-production` (never raw `main`)
- Default release path: `…/V-Executive-Search-release` (detached HEAD at promoted SHA)
- Previous release retained for rollback
- Admin drift compares mini heartbeat SHA to the expected release ref (detached HEAD is OK when SHA matches)

Optional: `WORKER_SELF_SYNC_ENABLED=true` in the canonical env pulls the release ref before a run.

## Schedule on Mac (one machine only)

Must run on a **home Mac with residential IP** (job boards block cloud servers).

> **New machine?** Full checklist: [DEPLOY.md](../DEPLOY.md)

```bash
# Preferred: bootstrap_release.sh (installs launchd on the release worktree)
# Editable-only fallback:
cd worker
chmod +x scripts/setup_mac.sh && ./scripts/setup_mac.sh
WORKER_ENV_FILE="$HOME/.vsearch/worker.env" ./scripts/install_launchd.sh
```

| Agent | Schedule | Purpose |
|-------|----------|---------|
| `com.vexecsearch.scrape` | 5:00 AM | Scrape → chunked jobs-only CRM ingest |
| `com.vexecsearch.hygiene` | 6:15 AM | Archive stale listings |
| `com.vexecsearch.rescore` | 6:30 AM | Re-score backlog |
| `com.vexecsearch.presence` | 7:30 AM | iMessage + email MX checks |
| `com.vexecsearch.email` | 7:45 AM | Daily email |
| `com.vexecsearch.scrape-pm` | 6:00 PM | Evening scrape → chunked jobs-only CRM ingest |
| `com.vexecsearch.rescore-pm` | 6:30 PM | Evening re-score |
| `com.vexecsearch.poll` | Every 5 minutes | Admin **Run now**, scrape-only by default |

```bash
launchctl list | grep vexecsearch
tail -f logs/launchd_stdout.log
tail -f logs/poll_stdout.log
```

Unload when moving to a new Mac:

```bash
launchctl bootout gui/$(id -u)/com.vexecsearch.scrape
launchctl bootout gui/$(id -u)/com.vexecsearch.hygiene
launchctl bootout gui/$(id -u)/com.vexecsearch.rescore
launchctl bootout gui/$(id -u)/com.vexecsearch.presence
launchctl bootout gui/$(id -u)/com.vexecsearch.email
launchctl bootout gui/$(id -u)/com.vexecsearch.scrape-pm
launchctl bootout gui/$(id -u)/com.vexecsearch.rescore-pm
launchctl bootout gui/$(id -u)/com.vexecsearch.poll
# Remove legacy keepalive if present:
launchctl bootout gui/$(id -u)/com.vexecsearch.contactout-keepalive 2>/dev/null || true
```

## Config

Primary config is the **Admin UI** at `/admin` on Vercel:

| Setting | Stored in | Worker reads via |
|---------|-----------|------------------|
| State + market (geo) | Postgres | `/api/pipeline/config` |
| Job title searches / focus keywords | Postgres | same |
| **Job boards** | Postgres (`job_boards`) | same |
| Notification email | Postgres | same |

Fallback if CRM is unreachable: `config/searches.yaml`.

Geo presets (14 states / 61 markets) are Census/OMB-grounded; see [docs/state-geo-expanded-coverage.md](../docs/state-geo-expanded-coverage.md).

### CRM ingest chunking

`CRMClient.ingest_batch` splits company payloads (~200 companies or ~3.5 MB per POST) to avoid Vercel **413 Request Entity Too Large** on large metros. Later chunks zero `listings_scraped` so additive `daily_runs` counters stay correct. Covered by `tests/test_crm_ingest_chunking.py`.

### Job boards (JobSpy)

Enabled in `/admin` → **Job boards**. Default: `indeed`, `linkedin`, `zip_recruiter` (Google off).

| Board | Notes |
|-------|-------|
| **Indeed** | Reliable baseline / workhorse |
| **Google Jobs** | **SerpApi** when `SERPAPI_API_KEY` is set on the worker (auto-enabled). JobSpy Google is unused. |
| **LinkedIn Jobs** | Senior/corporate roles; higher block risk — watch logs |
| **ZipRecruiter** | Often Cloudflare 403 — keep on for loud `board_failure`; overlaps Indeed |
| **Glassdoor** | Off by default; overlaps Indeed |

JobSpy also supports Bayt, Naukri, BDJobs (international) — not exposed in admin UI.

### LinkedIn hiring-team posters

When `LINKEDIN_FETCH_HIRING_TEAM` is enabled (default `true`), the scrape fetches public LinkedIn job pages and parses poster / “Meet the hiring team” blocks into seed contacts (`linkedin_poster`). This can add hours on large markets.

| Variable | Purpose |
|----------|---------|
| `LINKEDIN_FETCH_HIRING_TEAM` | `true`/`false` — poster crawl |
| `LINKEDIN_DRAW_COUNT` | LinkedIn draws per search (default 3) |
| `LINKEDIN_LI_AT_ENABLED` | Opt-in authenticated cookie (burner only — ban risk) |

### Enrichment

When `CONTACTOUT_API_KEY` is set (manual Enrich only):

1. **Apollo** — name, title, LinkedIn, work email (and work phone if enabled)
2. **ContactOut API** — personal email/mobile via LinkedIn profile URL

No Playwright, Chrome, or dashboard scraping.

```bash
CONTACTOUT_API_KEY=your_token
python scripts/test_contactout_hybrid.py
```

| Variable | Purpose |
|----------|---------|
| `CONTACTOUT_API_KEY` | ContactOut API token |
| `CONTACTOUT_RATE_LIMIT_COOLDOWN` | Seconds to pause after HTTP 429 (default 3600) |

### iMessage check (Mac worker only)

Runs at end of each 6 AM / 6 PM run (Messages must be signed in):

```bash
python scripts/check_imessage.py --limit 20
```

## Required env vars

| Variable | Where | Purpose |
|----------|-------|---------|
| `APOLLO_API_KEY` | canonical env + Vercel | Discovery + work email |
| `CRM_API_URL` | canonical env | Vercel app URL |
| `CRM_API_KEY` | canonical env + Vercel | Worker ↔ CRM auth |
| `ALERT_EMAIL` | canonical env | Failure alerts |
| `RESEND_API_KEY` | canonical env | Daily HTML email |
| `REPORT_FROM_EMAIL` | canonical env | Email sender |
| `CONTACTOUT_API_KEY` | canonical env + Vercel | Personal email/mobile |
| `WORKER_ENV_FILE` | launchd / shell | Path to canonical env (default `~/.vsearch/worker.env`) |
| `WORKER_SELF_SYNC_ENABLED` | optional | Sync to release ref before runs |
| `WORKER_RELEASE_REF` | optional | Default `origin/worker-production` |

Full guide: [DEPLOY.md](../DEPLOY.md).
