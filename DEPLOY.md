# Deploying to Vercel + Neon

## Status

- [x] GitHub repo: `git@github.com:proventheory/V-Executive-Search.git`
- [x] Neon project: **V-Executive-Search** (`late-haze-93186484`)
- [x] Database schema pushed
- [x] Next.js app at **repo root** (no subdirectory config needed)

## Vercel deploy

1. Go to [vercel.com/dashboard](https://vercel.com/dashboard) → your project
2. **Settings → General → Root Directory** → leave **empty** (repo root)
3. **Framework Preset** → **Next.js**
4. **Output Directory** → leave **empty**
5. **Settings → Environment Variables** (Production):
   - `DATABASE_URL` = Neon connection string
   - `WORKER_API_KEY` = shared secret (same as `worker/.env` `CRM_API_KEY`)
6. **Deployments → Redeploy**

If you previously set Root Directory to `crm`, **clear it** — the app now lives at repo root.

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
