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
│  • launchd on a clean release checkout (origin/worker-production) │
│  • JobSpy scrape (boards + geo from /admin) → jobs-only ingest    │
│  • Free rescore / hygiene / email; paid enrich is manual-only     │
│  • Canonical env: ~/.vsearch/worker.env (never in git)            │
│  • iMessage checks (Mac-only)                                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Your MacBook / phone (optional — no worker install required)    │
│  • Browser → /admin → state/market, boards, titles, Run now       │
└─────────────────────────────────────────────────────────────────┘
```

**Rules:**

- Job scraping runs on **one home Mac** with a residential IP. Vercel hosts the CRM and admin UI only.
- ContactOut uses the **API only** (`CONTACTOUT_API_KEY`) — no browser automation.
- Job boards and geo are toggled in `/admin` (Postgres); the worker reads them on each run.
- Promote worker code via `origin/worker-production`, not raw `main`. See [Worker release promotion](#worker-release-promotion).

---

## Greenfield checklist

### Cloud (Vercel + Neon)

- [ ] Create Neon project → copy `DATABASE_URL`
- [ ] Import repo to Vercel (root directory **empty**, Framework: Next.js)
- [ ] Set Vercel environment variables (see table below)
- [ ] `npm run db:push` locally (adds `job_boards` and other schema)
- [ ] Deploy → verify `/today` and `/admin/login` return 200
- [ ] Log into `/admin` → **state + market**, job boards, job titles, notification email
- [ ] Seed geo presets if needed: `node scripts/seed-state-geo-configs.mjs` (14 states / 61 markets)
- [ ] Generate a long random `WORKER_API_KEY` (same value on worker Mac)

### Mac worker (dedicated machine — often Mac mini)

- [ ] Clone repo on the **worker Mac** (editable checkout for promote/bootstrap only)
- [ ] Create canonical env: `mkdir -p ~/.vsearch && cp worker/.env.example ~/.vsearch/worker.env` and fill keys
- [ ] Promote a tested SHA to `worker-production`, then `bash worker/scripts/bootstrap_release.sh`
- [ ] `bash worker/scripts/verify_release_launchd.sh` → all agents point at the release worktree
- [ ] From the release checkout: `python scripts/health_check.py` → critical checks pass (no paid egress)
- [ ] Admin → **Run now** → confirm poll picks it up within 5 minutes

### Do NOT do on MacBook if Mac mini is the worker

- [ ] Do not install launchd on both machines (only one scheduler)

---

## Daily pipeline (JIT enrichment — Eastern Time)

The worker runs **staged free jobs twice daily** (5 AM and 6 PM scrape) instead of enriching every net-new company:

| Time (ET) | Job | Credits |
|-----------|-----|---------|
| 05:00 | Scrape → chunked `jobs_only` ingest (+ optional LinkedIn posters) | Free |
| 06:15 | Archive stale listings | Free |
| 06:30 | Rescore backlog | Free |
| 07:30 | iMessage + email MX presence checks | Free |
| 07:45 | Build + send ranked call sheet email | Free |
| 18:00 | Evening scrape → chunked `jobs_only` ingest (+ optional LinkedIn posters) | Free |
| 18:30 | Evening rescore backlog | Free |

Admin **Run now** (5-min poll) runs scrape-only/jobs-only ingest by default.
Apollo and ContactOut paid egress are manual-only and require a per-company
manual enrich context.

Large scrapes POST companies in chunks (~200 companies / ~3.5 MB) so Vercel
does not return **413 Request Entity Too Large**. Later chunks zero
`listings_scraped` so additive `daily_runs` counters stay correct.

Configure **N** and score thresholds in `/admin` → Enrichment quotas.
LinkedIn hiring-team poster crawl defaults on (`LINKEDIN_FETCH_HIRING_TEAM=true`);
set `false` for faster scrape-only validation runs.

**Today's Call Sheet** in the CRM uses a **5 AM – 5 AM Eastern** business day. Enriched leads appear on the call sheet tab; the backlog tab shows ranked companies awaiting enrichment.

Default job boards: **Indeed, LinkedIn, ZipRecruiter**. **Google Jobs** uses **SerpApi** when `SERPAPI_API_KEY` is set on the Mac worker (auto-enabled at scrape time). JobSpy’s Google scraper is not used. Glassdoor is available but off. Toggle in `/admin` → Job boards.

### SerpApi credit optimization (Google board only)

The pipeline still runs **both 6 AM and 6 PM, seven days a week** — Indeed and
LinkedIn scrape in both runs. The Google/SerpApi board is metered, capped, and
gated (all knobs config-driven — CRM `serpapi` config block overridable by
worker env; see `worker/.env.example`):

- **Meter first**: every SerpApi request (failures included — they bill) is
  counted per run and month-to-date (resets on the plan renewal day, default
  the 11th). Shown on the Runs page: `google: 42 searches · 3,812 this month ·
  plan 15,000`. The worker's local counter (`~/.vsearch/serpapi_usage.json`)
  reconciles as **max(local, CRM usage events)** — the guard can only ever
  over-count, never blind-overspend.
- **Hard per-run cap** (`SERPAPI_RUN_CAP`, default 200): loop bugs can't drain
  the month. Trips → `board_failure: serpapi_run_cap`; the rest of the run is
  normal.
- **Monthly budget guard** (default 80% of plan): trips → alert email +
  `board_failure: serpapi_budget`; Google skips, Indeed/LinkedIn carry the
  run, the backlog is protected by the outage guard.
- **Zone collapse**: Google queries 1–2 zones per market (metro center;
  per-market override via `state_geo_configs.metro_presets[].googleZones`,
  e.g. DFW adds Fort Worth). Free boards keep the full 8-hub list.
- **Schedule gate**: Google runs 6 AM only, weekdays only — logged as
  `board_skipped: schedule_gate` (informational, never a failure). A manual
  afternoon "Run now" therefore skips Google; force with
  `SERPAPI_SCHEDULE_GATE_BYPASS=1` or widen `GOOGLE_BOARD_RUNS`/`GOOGLE_BOARD_DAYS`.
- **Marginal-yield pagination** (NOT a fixed page cap): pages continue while
  the per-page net-new ratio ≥ `GOOGLE_PAGE_MIN_YIELD` (0.3); `GOOGLE_MAX_PAGES`
  (5) is a circuit breaker and cold markets get `GOOGLE_MAX_PAGES_COLD` (10).
  If the CRM known-listings lookup is down, pagination stops (never spend
  blind). Per-page ratios are logged in the funnel.
- **Adaptive title frequency**: titles with zero net-new companies in a market
  for 3 consecutive runs drop to every-2-days there; any net-new promotes
  back to daily. `GOOGLE_ADAPTIVE_ENABLED=false` reverts to daily everywhere.

### Outreach Sequencer (email + iMessage automation)

Reply-aware sequencing lives at **/admin/outreach** (+ `/admin/outreach/flows`
visual builder). It ships **OFF + dry-run + approval-gated** — nothing sends
until the switches are flipped deliberately.

Setup checklist:

1. `npm run db:push` — creates the outreach tables (templates, enrollments,
   messages, inbound, suppressions, enrollment_events audit log, notifications,
   flows + immutable versions, sending_profiles, outreach_settings).
2. Vercel env: `ANTHROPIC_API_KEY` (drafting + reply classification),
   `OUTREACH_FROM_EMAIL` (fallback sender until domain profiles exist),
   optional `OUTREACH_SENDER_NAME/TITLE/FIRM/PHONE`, `OUTREACH_SCHEDULING_LINK`,
   `RESEND_WEBHOOK_SECRET`, Google Calendar free/busy
   (`GOOGLE_CALENDAR_CLIENT_ID/SECRET/REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`).
3. Resend dashboard: add a webhook → `https://<crm>/api/webhooks/resend?token=<RESEND_WEBHOOK_SECRET>`
   for `email.delivered`, `email.bounced`, `email.complained`. The handler
   matches `resend_id` against outreach messages and ignores transactional app
   emails (a bounced daily report never dings a profile or suppresses anyone).
4. Worker env (`~/.vsearch/worker.env`): `OUTREACH_IMAP_HOST/USER/PASSWORD`
   for the Reply-To mailbox. The existing 5-min poll agent pumps iMessage
   sends, chat.db inbound scans, and IMAP replies (`worker/scripts/outreach_pump.py`).
5. Domain rotation: Admin → Outreach → Domains → add a sending subdomain →
   create the shown SPF/DKIM/DMARC records → Verify DNS. Unverified profiles
   cannot send; verified ones warm up 5/day → +5 per clean week → ~50/day with
   automatic rollback on bounce >2% / complaint >0.1%.
6. Crons are already in `vercel.json` (`/api/cron/outreach-dispatch` every
   15 min in the send window).

Enrollment: automatic at the end of enrich ingest (verified-deliverable email,
company status `new`, ICP pass, never previously enrolled, per-channel
suppression check, 2–3 contacts/company with staggered intros; contacts
without a verified iMessage number get email-only sequences). All steps are
LLM-drafted at enrollment from the winning-template bank and must pass the
anti-spam sanitizer or no enrollment is created.

Replies (email via IMAP, texts via chat.db, bounces via webhook) converge in
one pipeline: heuristics (STOP/OOO/bounce) → LLM intent classifier → rule
engine (positive → threaded auto-reply with live calendar windows + cancel
sibling sequences; opt-out → per-channel suppression; OOO → +3 business days;
data deletion → purge + suppress). Every decision lands in the
`enrollment_events` audit log.

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
| `SERPAPI_API_KEY` | Optional | Google Jobs via SerpApi (when wiring API path; JobSpy Google is broken) |
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
| `SERPAPI_API_KEY` | Optional | Google Jobs via SerpApi on the Mac worker (auto-enables Google board) |
| `WORKER_SELF_SYNC_ENABLED` | Optional | Opt-in: sync to `WORKER_RELEASE_REF` before a run |
| `WORKER_RELEASE_REF` | Optional | Default `origin/worker-production` (never raw `main`) |
| `WORKER_ENV_FILE` | Recommended | Canonical secrets path, usually `~/.vsearch/worker.env` |
| `LINKEDIN_FETCH_HIRING_TEAM` | Optional | Default `true`; set `false` to skip poster crawl (much faster) |

See `worker/.env.example` for the full list.

---

## Worker release promotion

Worker runtime code is promoted on a **dedicated ref**, not by pulling `main` into the live launchd checkout.

1. Land changes on a feature branch; merge/push as usual.
2. After tests, `db:push` (if schema), and Vercel deploy: move `worker-production` to the tested SHA:

```bash
git fetch origin
git push origin <tested-sha>:refs/heads/worker-production
# or: git branch -f worker-production <tested-sha> && git push origin worker-production
```

3. On the Mac mini, from the **editable** clone:

```bash
WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12 \
  bash worker/scripts/bootstrap_release.sh
bash worker/scripts/verify_release_launchd.sh
```

Bootstrap:

- Fetches `origin/worker-production`
- Builds a clean **detached** worktree (default `…/V-Executive-Search-release`)
- Creates a fresh `.venv`, symlinks `~/.vsearch/worker.env` → `worker/.env`
- Reinstalls all eight launchd agents against that release
- Keeps the previous release worktree for rollback

Admin **Worker status** compares the mini’s reported SHA to the expected release ref. Detached `HEAD` is healthy when the SHA matches the promoted release.

Optional auto-sync before runs: set `WORKER_SELF_SYNC_ENABLED=true` in the canonical env (still only advances to `WORKER_RELEASE_REF`).

---

## Geographic markets (DB-backed)

- **14 states / 61 markets** grounded in OMB 2023 CBSA delineations + Census ACS 2023 5-year geography.
- Full metro county sets include **cross-state** counties; hubs keep their true state (`Rock Hill, SC` in Charlotte).
- Admin **Market** dropdown reloads focus cities, counties, scrape hubs (max 8), and aliases.
- Regenerate seeds: `python3 scripts/generate-state-geo-expanded-seed.py`
- Upsert DB: `node scripts/seed-state-geo-configs.mjs`
- Coverage report: [docs/state-geo-expanded-coverage.md](docs/state-geo-expanded-coverage.md)

**Charlotte first-market validation (Jul 2026):** scrape-only with `LINKEDIN_FETCH_HIRING_TEAM=false` ingested ~15.8k listings / ~1.5k companies; Rock Hill locations only as SC; Apollo/ContactOut usage unchanged (manual-only). Chunked ingest required after a single-payload **413**.

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
git clone git@github.com:vexecutivesearch/V-Executive-Search.git
cd V-Executive-Search
mkdir -p ~/.vsearch
cp worker/.env.example ~/.vsearch/worker.env
# Edit ~/.vsearch/worker.env — CRM_API_URL, CRM_API_KEY (= WORKER_API_KEY), API keys
```

Promote and install launchd on a release checkout:

```bash
# After origin/worker-production points at a tested SHA:
WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12 \
  bash worker/scripts/bootstrap_release.sh
bash worker/scripts/verify_release_launchd.sh
launchctl list | grep vexecsearch
```

Test ContactOut API from the **release** worker:

```bash
cd /path/to/V-Executive-Search-release/worker
source .venv/bin/activate
python scripts/test_contactout_hybrid.py
```

| Agent | Schedule |
|-------|----------|
| `com.vexecsearch.scrape` | 5:00 AM |
| `com.vexecsearch.hygiene` | 6:15 AM |
| `com.vexecsearch.rescore` | 6:30 AM |
| `com.vexecsearch.presence` | 7:30 AM |
| `com.vexecsearch.email` | 7:45 AM |
| `com.vexecsearch.scrape-pm` | 6:00 PM |
| `com.vexecsearch.rescore-pm` | 6:30 PM |
| `com.vexecsearch.poll` | Every 5 minutes |

---

## What transfers between machines

| Asset | Git | MacBook → Mac mini | Notes |
|-------|-----|-------------------|--------|
| Source code | Yes | `git clone` + promote `worker-production` | Live launchd uses release worktree |
| `~/.vsearch/worker.env` | **No** | Copy manually | Never commit; not checkout-local |
| launchd plists | In repo | Re-run bootstrap / `install_launchd.sh` | Per macOS user |
| Neon data | N/A | Same `DATABASE_URL` | |
| Admin settings | N/A | In Postgres | State/market, boards, searches |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| **404 on Vercel** | Root Directory empty; redeploy |
| **Database not connected** | `DATABASE_URL` on Vercel + `db:push` |
| **Worker ingest 401** | `CRM_API_KEY` ≠ `WORKER_API_KEY` |
| **Worker ingest 413** | Need chunked ingest (`crm_client.ingest_batch`); promote worker ≥ `c4879bb` |
| **Run now does nothing** | Poll only on worker Mac; agents must target release checkout |
| **Admin SHA drift** | Promote + bootstrap so heartbeat matches `origin/worker-production` |
| **No LinkedIn jobs** | LinkedIn blocks scrapers sometimes; check daily log; toggle board off/on |
| **ZipRecruiter 0 / 403** | Cloudflare blocks common; non-blocking `board_failure` — Indeed/LinkedIn still count |
| **ContactOut no phones** | API plan may lack phone credits |
| **ContactOut HTTP 429** | Wait for cooldown; clear rate-limit marker after cooldown |
| **iMessage not tagging** | Messages signed in on worker Mac only |
| **Old boards after deploy** | Open `/admin` → Job boards → Save (or wait for auto-backfill) |
| **Wrong market hubs** | Confirm Admin Market; re-seed with `node scripts/seed-state-geo-configs.mjs` |

---

## Related docs

- [README.md](README.md) — repo overview
- [worker/README.md](worker/README.md) — worker scripts and env reference
- [docs/state-geo-expanded-coverage.md](docs/state-geo-expanded-coverage.md) — market counties / excluded hubs
- [docs/V-EXECUTIVE-SEARCH-SYSTEM.md](docs/V-EXECUTIVE-SEARCH-SYSTEM.md) — product + pipeline model
