# Ops changelog — July 2026

Internal reference for what landed (or is in flight) on the Mac mini + CRM.
Canonical deploy steps: **[DEPLOY.md](../DEPLOY.md)**.

**CRM host (locked):** `https://v-executive-search-delta.vercel.app`  
Never ingest or email-link to legacy `v-executive-search.vercel.app`.

**Remotes:** `vexec` = `vexecutivesearch/V-Executive-Search` (product), `origin` = `proventheory/V-Executive-Search` (mirror). Promote `worker-production` on **both** when updating the mini.

---

## Status snapshot (as of 2026-07-20)

| Surface | Tip / note |
|---------|------------|
| Git `main` / typical Vercel CRM | Through **PR #18** (`621af33`) — SerpApi (#13), Pipeline TN filter (#15–16), morning forensics (#18), ICP annotate-after-ingest |
| `worker-production` (Mac release) | May **lead** `main` while **PR #14 (Outreach)** is stress-tested. Confirm Admin → Worker SHA = `origin/worker-production` |
| PR #14 Outreach Sequencer | **Pending** — tweak + full test this weekend before merge. Worker already carries IMAP OAuth helpers on the feature / production tip used for testing |

---

## Merged recently (must be on Mac via bootstrap)

### PR #13 — SerpApi credit optimization
- Google Jobs only via SerpApi (`SERPAPI_API_KEY`); JobSpy Google unused.
- Meter (local `~/.vsearch/serpapi_usage.json` + CRM), per-run cap, monthly budget guard.
- Schedule gate: Google on **AM + weekdays** by default (`GOOGLE_BOARD_RUNS` / `GOOGLE_BOARD_DAYS`).
- **Do not set** `SERPAPI_SCHEDULE_GATE_BYPASS` in production unless deliberately forcing Google.
- Zone collapse + marginal-yield pagination + adaptive titles.
- Runs page shows SerpApi meter when Google ran.

### PR #15–16 — Pipeline geography
- Pipeline **State** filter uses listing geography only.
- Scrape **market** stamped from worker/search names; board counts on Runs.

### PR #18 — Morning scrape forensics
- **Rescore never inserts** empty `daily_runs` rows (ghost “× no run”).
- **07:45 email waits** for `listings_scraped > 0` (default 2h: `EMAIL_WAIT_FOR_SCRAPE_SECONDS`).
- Google controller init failure cannot abort Indeed/LinkedIn.
- Admin **Send today’s call sheet** when Mac email fails (`/api/admin/send-daily-report`).

### ICP annotate after ingest
- `/api/ingest` calls `annotateCompaniesIcp` on touched companies (purple ICP / role / est. salary badges).
- Full backfill: `npx tsx scripts/icp-annotate.ts`.

### Pipeline ordering
- **Jobs-only ingest runs before LinkedIn poster crawl** (Stage 2 → Stage 2b). Posters must not block CRM landing.

---

## Pending — PR #14 (Outreach Sequencer)

Do **not** treat as production-complete until weekend stress tests pass and the PR merges.

Includes (when merged / when testing on worker tip):
- Admin Outreach UI, enrollments, flows, Resend webhooks, iMessage queue.
- Worker `outreach_pump.py` on the 5-min poll (iMessage + chat.db + IMAP replies).
- **Microsoft 365 IMAP via OAuth (XOAUTH2)** — GoDaddy tenants often lack app passwords:
  - Entra public client + Graph delegated `IMAP.AccessAsUser.All`
  - `OUTREACH_MS_CLIENT_ID` / `OUTREACH_MS_TENANT_ID` in `~/.vsearch/worker.env`
  - One-time: `scripts/outreach_imap_login.py` → `~/.vsearch/outreach_msal_token.json`
  - Prefer OAuth over `OUTREACH_IMAP_PASSWORD`

See DEPLOY.md → **Outreach IMAP (PR #14)**.

---

## Jul 20, 2026 incident (lesson)

| Symptom | Cause |
|---------|--------|
| Runs showed 0 listings / “× no run” | 06:30 rescore ghost row while 05:00 scrape still running |
| No 07:45 email | Email job failed (CRM/Resend network) **before** ingest (~09:00) |
| “SerpApi broke scrapes” | Mini had **not** been bootstrapped onto the SerpApi tip; heartbeat lagged `worker-production` |

**Rule:** After every `worker-production` move → **bootstrap on the mini** before assuming the schedule runs new code. Never bootstrap mid-scrape (kills long runs).

Nashville AM that day **did** ingest (~12.4k listings) once Stage 1 finished; catch-up `--email-only` works when CRM is healthy.

---

## Mac mini cheat sheet

```bash
# Promote (both remotes if used)
git push origin <sha>:refs/heads/worker-production
git push vexec <sha>:refs/heads/worker-production

# On mini — editable clone, Python ≥3.10 (Homebrew 3.12)
WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12 \
  bash worker/scripts/bootstrap_release.sh
bash worker/scripts/verify_release_launchd.sh
launchctl list | grep vexecsearch

# Catch-up email
cd ~/Projects/V-Executive-Search-release/worker
WORKER_ENV_FILE=~/.vsearch/worker.env .venv/bin/python scripts/run_daily.py --email-only
```

Canonical secrets: `~/.vsearch/worker.env` only (chmod 600). Never commit.

---

## Weekend plan (before merging PR #14)

1. Keep daily scrape/email healthy on the bootstrapped tip (`Admin` drift **false**).
2. Stress Outreach enroll → send → IMAP reply detect → pause (OAuth token refresh).
3. Confirm SerpApi AM gate + meter on Runs; no bypass in prod env.
4. Do **not** merge PR #14 until sign-off after stress tests.
5. Docs source of truth for deploy: **DEPLOY.md** (this file is the narrative changelog).
