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

## Schedule on Mac (Mac mini — one machine only)

Must run on a **home Mac with residential IP** (job boards block cloud servers).  
Use a **dedicated worker Mac** (e.g. Mac mini). Your MacBook can use `/admin` in a browser but should not run launchd if the mini is the worker.

> **New machine?** Full checklist: [DEPLOY.md](../DEPLOY.md) (Vercel + Neon + Mac worker + ContactOut identities).

**One-command setup** (on the worker Mac, as the macOS user that will own launchd):

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

This installs three launchd agents:

| Agent | Schedule | Purpose |
|-------|----------|---------|
| `com.vexecsearch.daily` | 6:00 AM & 6:00 PM daily | Scrape → Apollo + ContactOut enrich → CRM → iMessage tags |
| `com.vexecsearch.poll` | Every 5 minutes | Picks up **Run now** / ContactOut sync from admin |
| `com.vexecsearch.contactout-keepalive` | Every 5 hours | Refreshes ContactOut session cookies (Layer 0) |

Verify:

```bash
launchctl list | grep vexecsearch
tail -f logs/launchd_stdout.log
tail -f logs/poll_stdout.log
```

Unload (e.g. when moving worker to a new Mac):

```bash
launchctl bootout gui/$(id -u)/com.vexecsearch.daily
launchctl bootout gui/$(id -u)/com.vexecsearch.poll
launchctl bootout gui/$(id -u)/com.vexecsearch.contactout-keepalive
```

### MacBook vs Mac mini

| | MacBook (dev / admin) | Mac mini (worker) |
|--|----------------------|-------------------|
| `/admin` in browser | Yes | Optional |
| `worker/.env` | Optional for testing | **Required** |
| launchd | **No** (if mini is worker) | **Yes** |
| `.contactout-session.json` | Not used | Created via `contactout_login.py` |
| Keychain ContactOut password | Not used | `contactout_store_credentials.py` |
| iMessage checks | Only if worker | Yes, if Messages signed in |

See [DEPLOY.md](../DEPLOY.md) for greenfield setup and identity separation (macOS user vs ContactOut email vs alert inbox).

## Config

Primary config is the **Admin UI** at `/admin` (geo focus, job titles, email).  
When `CONTACTOUT_API_KEY` is set (or `CONTACTOUT_MODE=dashboard` on Mac), the pipeline runs **Apollo → ContactOut**.

### ContactOut dashboard mode (Mac worker — unlimited plan workaround)

Use this when your ContactOut plan includes unlimited lookups in the **web dashboard** but not phone credits on the API.

**Run all steps on the worker Mac** (the macOS user that owns launchd). Credentials and session files do not sync from a MacBook.

1. Install Playwright in the worker venv:
   ```bash
   pip install -e ".[dashboard]"
   playwright install chromium
   ```
2. Log in **once** (saves cookies to `worker/.contactout-session.json` — not your daily Chrome):
   ```bash
   python scripts/contactout_login.py
   ```
3. In `worker/.env` on the **worker Mac**:
   ```bash
   CONTACTOUT_MODE=auto
   CONTACTOUT_KEYCHAIN_ACCOUNT=your-contactout-login@company.com   # not your macOS username
   ```
   Pin absolute paths (required for launchd):
   ```bash
   CONTACTOUT_SESSION_FILE=/Users/worker-macos-user/path/to/repo/worker/.contactout-session.json
   ```
4. The **5-minute poll** trickles dashboard lookups (`contactout_dashboard_sync.py`, 2 contacts per poll, 60–150s apart). Background runs use **headless Playwright Chromium** with the saved session file.

**Self-healing session ladder** (runs automatically — you only intervene on Layer 3):

| Layer | What | When |
|-------|------|------|
| **0** | `contactout_keepalive.py` — headless dashboard visit, refresh cookies | Every 5 hours (launchd) |
| **1** | Canary check before each pipeline run | 6 AM / 6 PM + Run now |
| **2** | Auto re-login via Keychain + email/password form (+ optional IMAP OTP) | When canary fails |
| **3** | Email alert + Apollo-only mode; backfill when session restored | When Layer 2 fails |

Enable Layer 2 (recommended):
```bash
python scripts/contactout_store_credentials.py   # macOS Keychain, email+password NOT Google SSO
```

Optional OTP via inbox (`hello@proventheory.co`):
```bash
# worker/.env
CONTACTOUT_OTP_IMAP_USER=hello@proventheory.co
CONTACTOUT_OTP_IMAP_PASSWORD=your-app-password
```

Re-run `./scripts/install_launchd.sh` to add the keepalive agent. ContactOut dashboard lookups happen in the background on the Mac — no LinkedIn browsing, only the ContactOut search portal.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTACTOUT_SESSION_FILE` | `worker/.contactout-session.json` | Saved login cookies (**absolute path** on worker Mac) |
| `CONTACTOUT_KEYCHAIN_ACCOUNT` | — | ContactOut login email for Keychain lookup |
| `CONTACTOUT_KEYCHAIN_SERVICE` | `v-execsearch-contactout` | Keychain service name |
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

Full greenfield / multi-machine guide: [DEPLOY.md](../DEPLOY.md).
