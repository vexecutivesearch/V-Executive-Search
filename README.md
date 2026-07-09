# V Executive Search

Automated recruiter list pipeline: scrape job postings, find decision-makers, enrich contacts, and surface a daily outreach list.

## Structure

```
├── worker/     Python pipeline (Mac mini, launchd)
├── src/        Next.js CRM app (Vercel + Neon)
└── package.json
```

## Quick start

### Worker (Mac mini)

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env   # add APOLLO_API_KEY
python scripts/run_daily.py --dry-run
```

### CRM (local)

```bash
npm install
cp .env.example .env.local   # add DATABASE_URL + WORKER_API_KEY
npm run db:push
npm run dev
```

### Connect worker → CRM

In `worker/.env`:
```
CRM_API_URL=https://your-app.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY in .env.local>
```

See [DEPLOY.md](DEPLOY.md) for full Vercel + Neon setup.
