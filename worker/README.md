# V Executive Search — Worker

Daily pipeline: JobSpy scrape → dedupe → Apollo enrich → CRM + email.

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
```

## Schedule on Mac (Mac mini / MacBook)

Must run on a **home Mac with residential IP** (job boards block cloud servers).

**One-command setup** (clone repo first):

```bash
cd worker
chmod +x scripts/setup_mac.sh
./scripts/setup_mac.sh
```

Or manual steps:

```bash
cd worker
chmod +x scripts/install_launchd.sh
./scripts/install_launchd.sh
```

This installs two launchd agents:

| Agent | Schedule | Purpose |
|-------|----------|---------|
| `com.vexecsearch.daily` | 6:00 AM & 6:00 PM daily | Full scrape → enrich → CRM ingest → email |
| `com.vexecsearch.poll` | Every 5 minutes | Picks up **Run now** from admin on your phone |

Verify:

```bash
launchctl list | grep vexecsearch
tail -f logs/launchd_stdout.log
tail -f logs/poll_stdout.log
```

Unload:

```bash
launchctl bootout gui/$(id -u)/com.vexecsearch.daily
launchctl bootout gui/$(id -u)/com.vexecsearch.poll
```

## Config

Primary config is the **Admin UI** at `/admin` (geo focus, job titles, email).  
Fallback: `config/searches.yaml` if CRM is unreachable.

## Required env vars

| Variable | Where | Purpose |
|----------|-------|---------|
| `APOLLO_API_KEY` | worker `.env` | Enrichment |
| `CRM_API_URL` | worker `.env` | Vercel app URL |
| `CRM_API_KEY` | worker `.env` + Vercel | Worker ↔ CRM auth |
| `ALERT_EMAIL` | worker `.env` | Failure alerts |
| `RESEND_API_KEY` | worker `.env` | Daily HTML email report |
| `APOLLO_API_KEY` | Vercel | Jobs page **Enrich** button |
