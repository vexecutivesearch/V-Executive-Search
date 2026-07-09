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
| `com.vexecsearch.daily` | 6:00 AM & 6:00 PM daily | Scrape → Apollo + ContactOut enrich → CRM → iMessage tags |
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
When `CONTACTOUT_API_KEY` is set (or `CONTACTOUT_MODE=dashboard` on Mac), the pipeline runs **Apollo → ContactOut**.

### ContactOut dashboard mode (Mac mini — unlimited plan workaround)

Use this when your ContactOut plan includes unlimited lookups in the **web dashboard** but not phone credits on the API.

1. Install Playwright in the worker venv:
   ```bash
   pip install -e ".[dashboard]"
   playwright install chromium
   ```
2. Log in **once** (saves cookies to `worker/.contactout-session.json` — not your daily Chrome):
   ```bash
   python scripts/contactout_login.py
   ```
3. In `worker/.env`:
   ```bash
   CONTACTOUT_MODE=auto
   ```
   For launchd/cron, pin the session path (absolute):
   ```bash
   CONTACTOUT_SESSION_FILE=/Users/you/path/V Executive Search/worker/.contactout-session.json
   ```
4. The **5-minute poll** trickles dashboard lookups (`contactout_dashboard_sync.py`, 2 contacts per poll, 60–150s apart). Background runs use **headless Playwright Chromium** with the saved session file.

Apollo still runs in the daily pipeline. ContactOut dashboard lookups happen in the background on the Mac — no LinkedIn browsing, only the ContactOut search portal.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTACTOUT_DASHBOARD_DELAY_MIN` | 60 | Min seconds between lookups |
| `CONTACTOUT_DASHBOARD_DELAY_MAX` | 150 | Max seconds between lookups |
| `CONTACTOUT_HEADLESS` | true | Set `false` to debug the browser |

Fallback: `config/searches.yaml` if CRM is unreachable.

### iMessage check (Mac mini only)

Runs **automatically at the end of each 6 AM / 6 PM pipeline** on macOS (Messages must be signed in). Manual run:

```bash
python scripts/check_imessage.py --limit 20
```

## Required env vars

| Variable | Where | Purpose |
|----------|-------|---------|
| `APOLLO_API_KEY` | worker `.env` | Enrichment |
| `CRM_API_URL` | worker `.env` | Vercel app URL |
| `CRM_API_KEY` | worker `.env` + Vercel | Worker ↔ CRM auth |
| `ALERT_EMAIL` | worker `.env` | Failure alerts |
| `RESEND_API_KEY` | worker `.env` | Daily HTML email report |
| `REPORT_FROM_EMAIL` | worker `.env` | Email sender address |
| `APOLLO_API_KEY` | worker `.env` + Vercel | Discovery + work email (Enrich button) |
| `CONTACTOUT_API_KEY` | worker `.env` + Vercel | Personal email/mobile via LinkedIn |
