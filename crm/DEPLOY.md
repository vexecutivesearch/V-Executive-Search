# Deploying the CRM to Vercel + Neon

## 1. Neon database

1. Go to [neon.tech](https://neon.tech) and create a free project
2. Copy the **connection string** (pooled, with `?sslmode=require`)
3. Save it — you'll use it as `DATABASE_URL`

## 2. Push schema

```bash
cd crm
cp .env.example .env.local
# Paste DATABASE_URL into .env.local

npm run db:push
```

This creates `companies`, `contacts`, `job_listings`, and `daily_runs` tables.

## 3. Generate API key

```bash
openssl rand -hex 32
```

Use the output as `WORKER_API_KEY` in both:
- `crm/.env.local` (and Vercel env vars)
- `worker/.env` as `CRM_API_KEY`

## 4. Vercel deploy

1. Push the repo to GitHub
2. [vercel.com/new](https://vercel.com/new) → Import repo
3. Set **Root Directory** to `crm`
4. Add environment variables:
   - `DATABASE_URL` = your Neon connection string
   - `WORKER_API_KEY` = the shared secret from step 3
5. Deploy

## 5. Configure Mac mini worker

Edit `worker/.env`:

```env
APOLLO_API_KEY=your_apollo_key
CRM_API_URL=https://your-app.vercel.app
CRM_API_KEY=same_as_WORKER_API_KEY
ALERT_EMAIL=you@example.com
```

Test the connection:

```bash
cd worker
source .venv/bin/activate
python scripts/run_daily.py
```

## 6. Enable daily schedule

```bash
cp worker/launchd/com.vexecsearch.daily.plist ~/Library/LaunchAgents/
# Edit python path in plist if your install location differs
launchctl load ~/Library/LaunchAgents/com.vexecsearch.daily.plist
```

Verify: `launchctl list | grep vexecsearch`

## Troubleshooting

| Issue | Fix |
|---|---|
| CRM shows "Database not connected" | Check `DATABASE_URL` in Vercel env vars; run `db:push` |
| Worker ingest 401 | Ensure `CRM_API_KEY` matches `WORKER_API_KEY` |
| Zero listings scraped | Check `config/searches.yaml`; try `--dry-run -v` |
| Apollo 403 | Use `/mixed_people/api_search` endpoint (already configured) |
| Credit burn too high | Lower `daily_credit_cap` in searches.yaml |
