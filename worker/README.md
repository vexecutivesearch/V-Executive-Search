# V Executive Search — Worker

Daily pipeline: **JobSpy scrape** (configurable boards) → dedupe → jobs-only CRM ingest → free scoring/email. **Apollo** + **ContactOut** run only from an explicit per-company manual Enrich action.

## Setup

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
# Edit .env — required: APOLLO_API_KEY, CRM_API_URL, CRM_API_KEY
```

## Run manually

```bash
source .venv/bin/activate
python scripts/run_daily.py              # scrape + ingest; scheduled enrich is disabled by default
python scripts/run_daily.py --dry-run    # scrape only (no Apollo credits)
python scripts/run_daily.py --scrape-only
python scripts/health_check.py           # smoke test; live Apollo probes are blocked
```

### After CRM deploys (industry fix, etc.)

The worker does **not** auto-update. From the repo root on the Mac:

```bash
git pull origin main
cd worker && source .venv/bin/activate
python scripts/health_check.py   # must report worker/API health without paid egress
```

Until you pull, the mini can keep running stale code. The Admin worker status
shows the mini's reported git SHA and flags drift from `origin/main`.

## Schedule on Mac (one machine only)

Must run on a **home Mac with residential IP** (job boards block cloud servers).

> **New machine?** Full checklist: [DEPLOY.md](../DEPLOY.md)

```bash
cd worker
chmod +x scripts/setup_mac.sh && ./scripts/setup_mac.sh
chmod +x scripts/install_launchd.sh && ./scripts/install_launchd.sh
```

| Agent | Schedule | Purpose |
|-------|----------|---------|
| `com.vexecsearch.scrape` | 6:00 AM | Scrape → jobs-only CRM ingest |
| `com.vexecsearch.hygiene` | 6:15 AM | Archive stale listings |
| `com.vexecsearch.rescore` | 6:30 AM | Re-score backlog |
| `com.vexecsearch.presence` | 7:30 AM | iMessage + email MX checks |
| `com.vexecsearch.email` | 7:45 AM | Daily email |
| `com.vexecsearch.scrape-pm` | 6:00 PM | Evening scrape → jobs-only CRM ingest |
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
| Geographic focus | Postgres | `/api/pipeline/config` |
| Job title searches | Postgres | same |
| **Job boards** | Postgres (`job_boards`) | same |
| Notification email | Postgres | same |

Fallback if CRM is unreachable: `config/searches.yaml`.

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

### Enrichment

When `CONTACTOUT_API_KEY` is set:

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
| `APOLLO_API_KEY` | worker `.env` + Vercel | Discovery + work email |
| `CRM_API_URL` | worker `.env` | Vercel app URL |
| `CRM_API_KEY` | worker `.env` + Vercel | Worker ↔ CRM auth |
| `ALERT_EMAIL` | worker `.env` | Failure alerts |
| `RESEND_API_KEY` | worker `.env` | Daily HTML email |
| `REPORT_FROM_EMAIL` | worker `.env` | Email sender |
| `CONTACTOUT_API_KEY` | worker `.env` + Vercel | Personal email/mobile |

Full guide: [DEPLOY.md](../DEPLOY.md).
