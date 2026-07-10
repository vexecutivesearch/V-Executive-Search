# Deployment & greenfield setup

Use this guide when standing up a **new Vercel environment**, **new Neon database**, or **new Mac worker machine**. The system has three independent surfaces that must be wired together.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel (Next.js CRM)          Neon Postgres                    │
│  • /today, /companies, /admin  • companies, contacts, settings  │
│  • /api/ingest, /api/pipeline  • pipeline_settings, job_boards  │
└────────────────────────────▲────────────────────────────────────┘
                             │ HTTPS + WORKER_API_KEY
┌────────────────────────────┴────────────────────────────────────┐
│  Mac worker (ONE machine only — residential IP)                   │
│  • launchd: JIT pipeline (2–6 AM ET) + 5-min poll                 │
│  • JobSpy scrape (boards from /admin)                             │
│  • Apollo + ContactOut API enrichment                             │
│  • worker/.env (never in git)                                     │
│  • iMessage checks (Mac-only)                                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Your MacBook / phone (optional — no worker install required)    │
│  • Browser → /admin → geo, job boards, titles, Run now           │
└─────────────────────────────────────────────────────────────────┘
```

**Rules:**

- Job scraping runs on **one home Mac** with a residential IP. Vercel hosts the CRM and admin UI only.
- ContactOut uses the **API only** (`CONTACTOUT_API_KEY`) — no browser automation.
- Job boards are toggled in `/admin` (stored in Postgres); the worker reads them on each run.

---

## Greenfield checklist

### Cloud (Vercel + Neon)

- [ ] Create Neon project → copy `DATABASE_URL`
- [ ] Import repo to Vercel (root directory **empty**, Framework: Next.js)
- [ ] Set Vercel environment variables (see table below)
- [ ] `npm run db:push` locally (adds `job_boards` and other schema)
- [ ] Deploy → verify `/today` and `/admin/login` return 200
- [ ] Log into `/admin` → geographic focus, job boards, job titles, notification email
- [ ] Generate a long random `WORKER_API_KEY` (same value on worker Mac)

### Mac worker (dedicated machine — often Mac mini)

- [ ] Clone repo on the **worker Mac**
- [ ] `cd worker && ./scripts/setup_mac.sh`
- [ ] Fill `worker/.env`: `CRM_API_URL`, `CRM_API_KEY`, `APOLLO_API_KEY`, `CONTACTOUT_API_KEY`, Resend keys
- [ ] `./scripts/install_launchd.sh` (daily + poll)
- [ ] `python scripts/health_check.py` → all critical checks pass
- [ ] Admin → **Run now** → confirm poll picks it up within 5 minutes

### Do NOT do on MacBook if Mac mini is the worker

- [ ] Do not install launchd on both machines (only one scheduler)

---

## Daily pipeline (JIT enrichment — Eastern Time)

The worker runs **staged jobs twice daily** (6 AM and 6 PM scrape) instead of enriching every net-new company:

| Time (ET) | Job | Credits |
|-----------|-----|---------|
| 06:00 | Scrape → `jobs_only` ingest (+ LinkedIn posters) | Free |
| 06:15 | Archive stale listings | Free |
| 06:30 | Rescore backlog | Free |
| 07:00 | Enrich top-N call sheet (default N=25) | Paid |
| 07:30 | iMessage + email MX presence checks | Free |
| 07:45 | Build + send ranked call sheet email | Free |
| 18:00 | Evening scrape → `jobs_only` ingest (+ LinkedIn posters) | Free |
| 18:30 | Evening rescore backlog | Free |

Admin **Run now** (5-min poll) runs scrape → rescore → enrich top-N — not enrich-all.

Configure **N** and score thresholds in `/admin` → Enrichment quotas.

**Today's Call Sheet** in the CRM uses a **6 AM – 6 AM Eastern** business day. Enriched leads appear on the call sheet tab; the backlog tab shows ranked companies awaiting enrichment.

Default job boards: **Indeed, Google Jobs, LinkedIn, ZipRecruiter**. Glassdoor is available but off by default. Toggle in `/admin` → Job boards.

### Legacy note

Older installs used a single 6 AM / 6 PM job (`com.vexecsearch.daily`). Re-run `cd worker && ./scripts/install_launchd.sh` to migrate to the JIT schedule.

---

## Daily pipeline (v1 — deprecated)

| Step | What happens |
|------|----------------|
| 1 | Load config from Vercel (`/api/pipeline/config`) — geo, searches, **job boards** |
| 2 | JobSpy scrapes each active title × geo zone on enabled boards |
| 3 | Dedupe by company; resolve domains; enrich **all** net-new until credit cap |
| 4 | Ingest to Neon; iMessage tags on worker Mac; daily email via Resend |

---

## Environment variables

### Vercel (+ local `.env.local`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | Neon Postgres |
| `WORKER_API_KEY` | Yes | Worker → CRM API auth |
| `ADMIN_PASSWORD` | Recommended | Admin login (defaults to `WORKER_API_KEY` if unset) |
| `APOLLO_API_KEY` | Yes | Enrich button + Apollo on company cards |
| `CONTACTOUT_API_KEY` | Recommended | Personal email/mobile on Enrich button |
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
| `APOLLO_API_KEY` | Yes | Contact discovery |
| `CRM_API_URL` | Yes | `https://your-project.vercel.app` (no trailing path) |
| `CRM_API_KEY` | Yes | **Must equal** Vercel `WORKER_API_KEY` |
| `ALERT_EMAIL` | Yes | Pipeline failure alerts |
| `RESEND_API_KEY` | Yes | Daily HTML report from worker |
| `REPORT_FROM_EMAIL` | Yes | Resend-verified sender |
| `CONTACTOUT_API_KEY` | Recommended | Personal email/mobile via LinkedIn URL |

See `worker/.env.example` for the full list.

---

## Vercel deploy

### Option A — New project

1. [vercel.com/new](https://vercel.com/new) → Import repo
2. **Root Directory** → leave **empty**
3. **Framework** → Next.js
4. Add env vars **before** first deploy
5. Deploy

### Option B — Update existing project

1. Push to `main` (auto-deploy) or **Deployments → Redeploy** in Vercel dashboard
2. Run `npm run db:push` after schema changes (e.g. `job_boards` column)
3. **Settings → General** → Root Directory **empty**

### Verify

- `https://YOUR-URL.vercel.app/today` → 200
- `https://YOUR-URL.vercel.app/admin/login` → 200
- `curl -H "Authorization: Bearer $WORKER_API_KEY" https://YOUR-URL.vercel.app/api/pipeline/config` → includes `boards` array

---

## New Mac worker machine

```bash
git clone git@github.com:proventheory/V-Executive-Search.git
cd V-Executive-Search/worker
chmod +x scripts/setup_mac.sh && ./scripts/setup_mac.sh
```

Edit `worker/.env`:

```env
CRM_API_URL=https://YOUR-VERCEL-URL.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY on Vercel>
CONTACTOUT_API_KEY=<your ContactOut API token>
```

Test ContactOut API:

```bash
source .venv/bin/activate
python scripts/test_contactout_hybrid.py
```

Schedule:

```bash
./scripts/install_launchd.sh
launchctl list | grep vexecsearch
```

| Agent | Schedule |
|-------|----------|
| `com.vexecsearch.daily` | 6:00 AM & 6:00 PM |
| `com.vexecsearch.poll` | Every 5 minutes |

---

## What transfers between machines

| Asset | Git | MacBook → Mac mini | Notes |
|-------|-----|-------------------|--------|
| Source code | Yes | `git clone` | |
| `worker/.env` (API keys) | **No** | Copy manually | Never commit |
| launchd plists | In repo | Re-run `install_launchd.sh` | Per macOS user |
| Neon data | N/A | Same `DATABASE_URL` | |
| Admin settings | N/A | In Postgres | Geo, boards, searches |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| **404 on Vercel** | Root Directory empty; redeploy |
| **Database not connected** | `DATABASE_URL` on Vercel + `db:push` |
| **Worker ingest 401** | `CRM_API_KEY` ≠ `WORKER_API_KEY` |
| **Run now does nothing** | Poll only on worker Mac; `launchctl list \| grep vexec` |
| **No LinkedIn jobs** | LinkedIn blocks scrapers sometimes; check daily log; toggle board off/on |
| **ContactOut no phones** | API plan may lack phone credits |
| **ContactOut HTTP 429** | Wait for cooldown; `rm worker/.contactout-rate-limited` after cooldown |
| **iMessage not tagging** | Messages signed in on worker Mac only |
| **Old boards after deploy** | Open `/admin` → Job boards → Save (or wait for auto-backfill) |

---

## Related docs

- [README.md](README.md) — repo overview
- [worker/README.md](worker/README.md) — worker scripts and env reference
