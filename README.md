# V Executive Search

Automated recruiter list pipeline: scrape job postings, find decision-makers, enrich contacts, and surface a daily outreach list.

## Structure

```
├── worker/     Python pipeline (Mac mini, launchd)
└── crm/        Next.js CRM (Vercel + Neon)
```

## Quick start

### 1. Worker (Mac mini)

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env   # add APOLLO_API_KEY
python scripts/run_daily.py --dry-run
```

### 2. CRM (Vercel)

```bash
cd crm
npm install
cp .env.example .env.local   # add DATABASE_URL + WORKER_API_KEY
npm run db:push
npm run dev
```

### 3. Connect worker → CRM

In `worker/.env`:
```
CRM_API_URL=https://your-app.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY in crm/.env.local>
```

In `crm/.env.local` (and Vercel env vars):
```
DATABASE_URL=<neon connection string>
WORKER_API_KEY=<shared secret>
```

### 4. Schedule daily run

```bash
cp worker/launchd/com.vexecsearch.daily.plist ~/Library/LaunchAgents/
# Edit paths in plist if needed
launchctl load ~/Library/LaunchAgents/com.vexecsearch.daily.plist
```

## Deploy CRM to Vercel

1. Create a [Neon](https://neon.tech) project and copy the connection string
2. Push `crm/` to GitHub
3. Import in [Vercel](https://vercel.com) — set root directory to `crm`
4. Add environment variables: `DATABASE_URL`, `WORKER_API_KEY`
5. After deploy, run `npm run db:push` locally (or use Neon SQL editor with generated migration)
6. Point Mac mini `CRM_API_URL` at your Vercel URL

## Daily workflow

1. **6:00 AM** — launchd runs `run_daily.py` on Mac mini
2. JobSpy scrapes Indeed, Google Jobs, ZipRecruiter
3. Companies deduped, domains resolved, Apollo enriches contacts
4. Results POSTed to CRM `/api/ingest`
5. Open **Today's List** in the CRM and start outreach

## Costs

| Item | ~Monthly |
|---|---|
| JobSpy | $0 |
| Apollo (40–100 enrichments/day) | $79–199 |
| Vercel + Neon | $0 (free tier) |
