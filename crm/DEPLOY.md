# Deploying the CRM to Vercel + Neon

## Status

- [x] GitHub repo: `git@github.com:proventheory/V-Executive-Search.git`
- [x] Neon project created: **V-Executive-Search** (`late-haze-93186484`)
- [x] Database schema pushed (companies, contacts, job_listings, daily_runs)
- [x] Local env files written (`crm/.env.local`, `worker/.env`)
- [ ] Vercel deploy (requires your Vercel login — see step 4 below)

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

## 4. Vercel deploy (do this now)

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import **proventheory/V-Executive-Search** from GitHub
3. Set **Root Directory** to `crm` (click Edit → enter `crm`)
4. Add environment variables (copy from your local `crm/.env.local`):
   - `DATABASE_URL` = Neon connection string
   - `WORKER_API_KEY` = same value as in `crm/.env.local`
5. Click **Deploy**
6. After deploy, copy your Vercel URL (e.g. `https://v-executive-search.vercel.app`)
7. Update `worker/.env`:
   ```
   CRM_API_URL=https://your-actual-url.vercel.app
   ```

Or via CLI after `npx vercel login`:

```bash
cd crm
npx vercel --prod
npx vercel env add DATABASE_URL production
npx vercel env add WORKER_API_KEY production
```

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
| **404 NOT_FOUND** after deploy | Root Directory is wrong — see fix below |
| CRM shows "Database not connected" | Check `DATABASE_URL` in Vercel env vars; run `db:push` |
| Worker ingest 401 | Ensure `CRM_API_KEY` matches `WORKER_API_KEY` |
| Zero listings scraped | Check `config/searches.yaml`; try `--dry-run -v` |
| Apollo 403 | Use `/mixed_people/api_search` endpoint (already configured) |
| Credit burn too high | Lower `daily_credit_cap` in searches.yaml |

### Fix: 404 NOT_FOUND

This happens when Vercel deploys the **repo root** instead of the **`crm`** folder. The root has no Next.js app, so every route 404s.

1. Open your project in [vercel.com/dashboard](https://vercel.com/dashboard)
2. Go to **Settings → General**
3. Find **Root Directory** → click **Edit**
4. Enter `crm` and confirm
5. Go to **Deployments** → click **⋯** on the latest → **Redeploy**

Also verify under **Settings → General**:
- **Framework Preset**: Next.js
- **Build Command**: leave default (or `npm run build`)
- **Output Directory**: leave **empty** (do not set `.next`)

Do **not** use a custom `outputDirectory` in `vercel.json` — Vercel handles Next.js output automatically.
