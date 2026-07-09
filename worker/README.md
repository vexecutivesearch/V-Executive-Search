# V Executive Search — Worker

Daily pipeline: **JobSpy scrape** (configurable boards) → dedupe → **Apollo** + **ContactOut API** → CRM + email + iMessage tags.

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
python scripts/run_daily.py              # full pipeline
python scripts/run_daily.py --dry-run    # scrape only (no Apollo credits)
python scripts/run_daily.py --limit 3    # test with 3 companies
python scripts/health_check.py           # smoke test all integrations
python scripts/test_contactout_hybrid.py # ContactOut API only
```

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
| `com.vexecsearch.daily` | 6:00 AM & 6:00 PM | Scrape → enrich → CRM → iMessage → email |
| `com.vexecsearch.poll` | Every 5 minutes | Admin **Run now** |

```bash
launchctl list | grep vexecsearch
tail -f logs/launchd_stdout.log
tail -f logs/poll_stdout.log
```

Unload when moving to a new Mac:

```bash
launchctl bootout gui/$(id -u)/com.vexecsearch.daily
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

Enabled in `/admin` → **Job boards**. Default: `indeed`, `google`, `linkedin`, `zip_recruiter`.

| Board | Notes |
|-------|-------|
| **Indeed** | Reliable baseline |
| **Google Jobs** | Aggregator reach |
| **LinkedIn Jobs** | Senior/corporate roles; higher block risk — watch logs |
| **ZipRecruiter** | SMB/mid-market; low block risk |
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
