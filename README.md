# V Executive Search

Automated recruiter list pipeline: scrape job postings from multiple boards, find decision-makers, enrich contacts, and surface a daily outreach list.

## Structure

```
├── worker/     Python pipeline (one home Mac — launchd + JobSpy)
├── src/        Next.js CRM app (Vercel + Neon)
└── package.json
```

## What runs automatically

On a **home Mac worker** (launchd), twice daily at **6 AM and 6 PM**:

1. **Scrape** — JobSpy pulls jobs from boards enabled in `/admin` (default: Indeed, LinkedIn, ZipRecruiter; Google Jobs off — use SerpApi)
2. **Dedupe** — collapse listings to companies; skip domains already in CRM
3. **Enrich** — Apollo (contacts + work email) → ContactOut API (personal email/mobile via LinkedIn URL)
4. **Sync** — push to Neon via Vercel `/api/ingest`
5. **Tag** — iMessage capability check (Mac only, Messages signed in)
6. **Email** — daily HTML report via Resend

Admin **Run now** uses the same pipeline via a 5-minute poll.

## Quick start

### CRM (local or Vercel)

```bash
npm install
cp .env.example .env.local   # DATABASE_URL, WORKER_API_KEY, APOLLO_API_KEY
npm run db:push
npm run dev
```

Open `/admin` to set geographic focus, job title searches, **job boards**, and notification email.

### Worker (Mac mini — not your dev MacBook unless testing)

```bash
cd worker
./scripts/setup_mac.sh
# Edit worker/.env → CRM_API_URL, CRM_API_KEY, API keys
python scripts/health_check.py
python scripts/run_daily.py --dry-run
./scripts/install_launchd.sh   # 6 AM / 6 PM + 5-min poll
```

### Connect worker → CRM

In `worker/.env` on the **machine that runs launchd**:

```env
CRM_API_URL=https://your-app.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY on Vercel>
CONTACTOUT_API_KEY=<ContactOut API token>
```

## Admin configuration (no redeploy needed)

| Setting | Where | Notes |
|---------|-------|-------|
| Geographic focus | `/admin` | City, county, or state multi-select |
| Job title searches | `/admin` | Active profiles × geo zones |
| **Job boards** | `/admin` | Indeed, Google, LinkedIn, ZipRecruiter, Glassdoor |
| Notification email | `/admin` | Daily report recipient |
| Run now | `/admin` | Worker picks up within 5 minutes |

## Documentation

| Doc | When to read |
|-----|----------------|
| **[DEPLOY.md](DEPLOY.md)** | New Vercel env, Neon DB, Mac worker, env vars |
| [worker/README.md](worker/README.md) | Worker scripts, launchd, JobSpy boards, ContactOut API |
| [Playwright/README.md](Playwright/README.md) | **Archived** dashboard automation (not in production) |

**Important:** Scraping and launchd run on **one home Mac** with a residential IP. Vercel hosts the CRM only. Your MacBook browser is enough for `/admin` — it does not need the worker installed unless it *is* the worker Mac.
