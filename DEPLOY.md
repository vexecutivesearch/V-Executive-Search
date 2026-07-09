# Deploying to Vercel + Neon

## Status

- [x] GitHub repo: `git@github.com:proventheory/V-Executive-Search.git`
- [x] Neon project: **V-Executive-Search** (`late-haze-93186484`)
- [x] Database schema pushed
- [x] Next.js app at **repo root** (no subdirectory config needed)

## Vercel deploy (start fresh if you see 404)

The 404 means **no successful deployment exists** on that domain yet. Do this:

### Option A — New project (recommended)

1. [vercel.com/new](https://vercel.com/new) → Import **proventheory/V-Executive-Search**
2. **Root Directory** → leave **empty** (app is at repo root, NOT `crm`)
3. **Framework** → Next.js (auto-detected)
4. **Environment Variables** → add before first deploy:
   - `DATABASE_URL`
   - `WORKER_API_KEY`
5. Click **Deploy**
6. Use the URL Vercel gives you (e.g. `https://v-executive-search-xxxx.vercel.app`)

### Option B — Fix existing project

1. [vercel.com/dashboard](https://vercel.com/dashboard) → your project → **Settings → General**
2. **Root Directory** → **clear it** (must be empty, not `crm`)
3. **Framework Preset** → Next.js
4. **Output Directory** → empty
5. **Settings → Environment Variables** → confirm `DATABASE_URL` and `WORKER_API_KEY`
6. **Deployments** → **Redeploy**

### Verify

After a successful deploy, these should return **200** (not 404):

- `https://YOUR-URL.vercel.app/today`
- `https://YOUR-URL.vercel.app/companies`

## Local env

```bash
cp .env.example .env.local
npm install
npm run db:push
npm run dev
```

## Worker connection

After deploy, update `worker/.env`:

```env
CRM_API_URL=https://your-actual-url.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY>
```

## Troubleshooting

| Issue | Fix |
|---|---|
| **404 NOT_FOUND** | Clear Root Directory in Vercel settings; redeploy |
| Commit email blocked | Use `250740121+proventheory@users.noreply.github.com` as git email |
| Database not connected | Set `DATABASE_URL` in Vercel env vars |
| Worker ingest 401 | `CRM_API_KEY` must match `WORKER_API_KEY` |

## Git identity (one-time)

```bash
git config user.name "proventheory"
git config user.email "250740121+proventheory@users.noreply.github.com"
```
