# Deployment & greenfield setup

Use this guide when standing up a **new Vercel environment**, **new Neon database**, or **new Mac worker machine**. The system has three independent surfaces that must be wired together.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel (Next.js CRM)          Neon Postgres                    │
│  • /today, /companies, /admin  • companies, contacts, settings  │
│  • /api/ingest, /api/pipeline  • pipeline_settings, job_listings │
└────────────────────────────▲────────────────────────────────────┘
                             │ HTTPS + WORKER_API_KEY
┌────────────────────────────┴────────────────────────────────────┐
│  Mac worker (ONE machine only — residential IP)                   │
│  • launchd: daily pipeline, 5-min poll, ContactOut keepalive    │
│  • worker/.env, session file, macOS Keychain (never in git)      │
│  • Playwright + iMessage (Mac-only)                             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Your MacBook / phone (optional — no worker install required)    │
│  • Browser → /admin → Run now, geo settings, ContactOut sync    │
└─────────────────────────────────────────────────────────────────┘
```

**Rule:** Scraping and ContactOut dashboard automation run on **one home Mac** with a residential IP. Vercel hosts the CRM and admin UI only.

---

## Greenfield checklist

Copy this when launching from scratch:

### Cloud (Vercel + Neon)

- [ ] Create Neon project → copy `DATABASE_URL`
- [ ] Import repo to Vercel (root directory **empty**, Framework: Next.js)
- [ ] Set Vercel environment variables (see table below)
- [ ] `npm run db:push` locally or rely on first deploy + manual push
- [ ] Deploy → verify `/today` and `/admin/login` return 200
- [ ] Log into `/admin` → set geographic focus, job titles, notification email
- [ ] Generate a long random `WORKER_API_KEY` (use same value on worker Mac)

### Mac worker (dedicated machine — often Mac mini)

- [ ] Clone repo on the **worker Mac** (can be a different macOS user than your MacBook)
- [ ] `cd worker && ./scripts/setup_mac.sh` (or manual venv + `.env`)
- [ ] Fill `worker/.env` with **this Vercel URL** and matching `CRM_API_KEY`
- [ ] ContactOut: `pip install -e ".[dashboard]" && playwright install chromium`
- [ ] ContactOut: `python scripts/contactout_login.py` **on the worker Mac**
- [ ] ContactOut: `python scripts/contactout_store_credentials.py` **on the worker Mac**
- [ ] `./scripts/install_launchd.sh` (daily + poll + keepalive)
- [ ] `python scripts/health_check.py` → all critical checks pass
- [ ] Admin → **Run now** → confirm poll picks it up within 5 minutes

### Do NOT do on MacBook if Mac mini is the worker

- [ ] Do not install launchd on both machines (only one scheduler)
- [ ] Do not assume Keychain or session file from MacBook transfers to mini
- [ ] Do not log into ContactOut in your daily Chrome and expect the worker to use it

---

## Three different “users” (common confusion)

These are **independent**. Mixing them up is the #1 setup mistake.

| Identity | Example | Where it lives | Purpose |
|----------|---------|----------------|---------|
| **macOS account** | `vexec` on mini, `miguel` on MacBook | Per physical Mac | Owns Keychain, launchd, files on that Mac |
| **ContactOut login** | `hello@proventheory.co` | contactout.com | Dashboard session + auto re-login (Layer 2) |
| **Alert / OTP inbox** | `hello@proventheory.co` | Email / IMAP | Failure alerts, optional verification codes |

- `CONTACTOUT_KEYCHAIN_ACCOUNT` = **ContactOut.com email**, not your Mac username.
- Keychain passwords are stored in the **macOS user that runs launchd** on the worker Mac.
- Your MacBook only needs a browser for `/admin`; it does **not** need ContactOut session files or Keychain entries.

---

## Environment variables

### Vercel (+ local `.env.local`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | Neon Postgres |
| `WORKER_API_KEY` | Yes | Worker → CRM API auth |
| `ADMIN_PASSWORD` | Recommended | Admin login (defaults to `WORKER_API_KEY` if unset) |
| `APOLLO_API_KEY` | Yes | Enrich button + Apollo webhook on Vercel |
| `RESEND_API_KEY` | Optional | Daily email if sent from Vercel routes |
| `NEXT_PUBLIC_APP_URL` | Optional | Public URL (Vercel sets `VERCEL_URL` automatically) |

```bash
cp .env.example .env.local
npm install
npm run db:push
npm run dev
```

### Worker (`worker/.env` on the Mac that runs launchd)

| Variable | Required | Purpose |
|----------|----------|---------|
| `APOLLO_API_KEY` | Yes | Scrape pipeline enrichment |
| `CRM_API_URL` | Yes | `https://your-project.vercel.app` (no trailing path) |
| `CRM_API_KEY` | Yes | **Must equal** Vercel `WORKER_API_KEY` |
| `ALERT_EMAIL` | Yes | Pipeline failures + ContactOut Layer 3 alerts |
| `RESEND_API_KEY` | Yes | Daily HTML report from worker |
| `REPORT_FROM_EMAIL` | Yes | Resend-verified sender |
| `CONTACTOUT_API_KEY` | Recommended | API emails (phones often need dashboard) |
| `CONTACTOUT_MODE` | Default `auto` | `auto` \| `api` \| `dashboard` |

**Pin absolute paths on the worker Mac** (launchd cwd may differ):

```env
CONTACTOUT_SESSION_FILE=/Users/WORKER_MAC_USER/path/to/repo/worker/.contactout-session.json
CONTACTOUT_KEYCHAIN_ACCOUNT=your-contactout-login@company.com
```

Optional ContactOut auto re-login + OTP:

```env
CONTACTOUT_KEYCHAIN_SERVICE=v-execsearch-contactout
CONTACTOUT_OTP_IMAP_HOST=imap.gmail.com
CONTACTOUT_OTP_IMAP_USER=hello@proventheory.co
CONTACTOUT_OTP_IMAP_PASSWORD=app-specific-password
CONTACTOUT_OTP_FROM_FILTER=contactout
```

See `worker/.env.example` for the full list.

---

## Vercel deploy

### Option A — New project (recommended for new environment)

1. [vercel.com/new](https://vercel.com/new) → Import repo
2. **Root Directory** → leave **empty**
3. **Framework** → Next.js
4. Add env vars from table above **before** first deploy
5. Deploy → use assigned URL (e.g. `https://v-executive-search.vercel.app`)

### Option B — Fix existing project

1. **Settings → General** → Root Directory **empty** (not `crm`)
2. **Settings → Environment Variables** → confirm all required vars
3. **Deployments → Redeploy**

### Verify

- `https://YOUR-URL.vercel.app/today` → 200
- `https://YOUR-URL.vercel.app/admin/login` → 200
- Worker: `curl -H "Authorization: Bearer $WORKER_API_KEY" https://YOUR-URL.vercel.app/api/pipeline/config` → 200

---

## New Mac worker machine

Perform these steps **logged into the macOS account that will own launchd** (SSH or locally). This can be a different person/email than your MacBook.

### 1. Clone and base setup

```bash
git clone git@github.com:proventheory/V-Executive-Search.git
cd V-Executive-Search/worker
chmod +x scripts/setup_mac.sh
./scripts/setup_mac.sh
```

Edit `worker/.env`:

```env
CRM_API_URL=https://YOUR-VERCEL-URL.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY on Vercel>
CONTACTOUT_SESSION_FILE=/Users/<worker-macos-user>/.../worker/.contactout-session.json
CONTACTOUT_KEYCHAIN_ACCOUNT=<contactout-login-email>
```

### 2. ContactOut dashboard (Mac-only)

Uses a **dedicated automation browser** + cookie file — not your daily Chrome profile.

```bash
source .venv/bin/activate
pip install -e ".[dashboard]"
playwright install chromium

# Layer 1 — initial session (run ON THIS MAC)
python scripts/contactout_login.py

# Layer 2 — Keychain auto re-login (run ON THIS MAC)
python scripts/contactout_store_credentials.py
# Use ContactOut email + password (NOT Google SSO)
```

**Self-healing ladder** (automatic after setup):

| Layer | Behavior |
|-------|----------|
| 0 | Keepalive every 5h refreshes session cookies |
| 1 | Canary before each pipeline run |
| 2 | Keychain + form login (+ optional IMAP OTP) |
| 3 | Email alert; Apollo-only until session restored |

Details: [worker/README.md](worker/README.md#contactout-dashboard-mode-mac-mini--unlimited-plan-workaround)

### 3. Schedule (one Mac only)

```bash
./scripts/install_launchd.sh
launchctl list | grep vexecsearch
```

| Agent | Schedule |
|-------|----------|
| `com.vexecsearch.daily` | 6:00 AM & 6:00 PM |
| `com.vexecsearch.poll` | Every 5 minutes |
| `com.vexecsearch.contactout-keepalive` | Every 5 hours |

Unload on old machine before enabling on new:

```bash
launchctl bootout gui/$(id -u)/com.vexecsearch.daily
launchctl bootout gui/$(id -u)/com.vexecsearch.poll
launchctl bootout gui/$(id -u)/com.vexecsearch.contactout-keepalive
```

### 4. Verify

```bash
python scripts/health_check.py
python scripts/run_daily.py --dry-run
```

From phone/browser: Admin → **Run now** → within 5 min check `worker/logs/poll_stdout.log`.

---

## What transfers between machines

| Asset | Git | MacBook → Mac mini | Notes |
|-------|-----|-------------------|--------|
| Source code | Yes | `git clone` | |
| `worker/.env` values (API keys) | **No** | Copy manually | Never commit |
| `.contactout-session.json` | **No** | **No** | Create on worker Mac via `contactout_login.py` |
| macOS Keychain (ContactOut password) | **No** | **No** | `contactout_store_credentials.py` on worker Mac |
| launchd plists | In repo | Re-run `install_launchd.sh` | Installed per macOS user |
| Neon data | N/A | Same `DATABASE_URL` | New Vercel env may use new Neon DB |
| Admin geo / searches | N/A | In Postgres | Set in `/admin` per environment |

---

## New Vercel environment (same Mac worker)

If you point the worker at a **new** Vercel deployment:

1. Deploy new Vercel project with fresh `WORKER_API_KEY` + `DATABASE_URL`
2. `npm run db:push` against new Neon
3. Update **only** on worker Mac: `CRM_API_URL`, `CRM_API_KEY` in `worker/.env`
4. Re-configure `/admin` (geo, job titles, email)
5. ContactOut session is **unchanged** (tied to ContactOut account, not Vercel)

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| **404 on Vercel** | Root Directory empty; redeploy |
| **Database not connected** | `DATABASE_URL` on Vercel + `db:push` |
| **Worker ingest 401** | `CRM_API_KEY` ≠ `WORKER_API_KEY` |
| **Run now does nothing** | Poll only on worker Mac; check `launchctl list \| grep vexec` |
| **ContactOut random Chrome profile** | Use `contactout_login.py` on worker Mac; session file not daily Chrome |
| **ContactOut login loops** | Allow Python in BlockBlock; only one Mac runs poll; use email/password not Google SSO |
| **ContactOut phones missing** | API may lack phone credits; dashboard mode + session on worker Mac |
| **Layer 3 alert email** | Check `ALERT_EMAIL` + `RESEND_API_KEY` on worker |
| **iMessage not tagging** | Messages signed in on worker Mac only |

---

## Git identity (one-time, if Vercel blocks commits)

```bash
git config user.name "proventheory"
git config user.email "250740121+proventheory@users.noreply.github.com"
```

---

## Related docs

- [README.md](README.md) — repo overview
- [worker/README.md](worker/README.md) — worker scripts, ContactOut ladder, env reference
