# V Executive Search

Automated recruiter list pipeline: scrape job postings, find decision-makers, enrich contacts, and surface a daily outreach list.

## Structure

```
├── worker/     Python pipeline (one home Mac — launchd)
├── src/        Next.js CRM app (Vercel + Neon)
└── package.json
```

## Quick start

### CRM (local or Vercel)

```bash
npm install
cp .env.example .env.local   # DATABASE_URL + WORKER_API_KEY
npm run db:push
npm run dev
```

### Worker (Mac mini — not your dev MacBook unless testing)

```bash
cd worker
./scripts/setup_mac.sh
# Edit worker/.env → CRM_API_URL, CRM_API_KEY, API keys
python scripts/run_daily.py --dry-run
```

### Connect worker → CRM

In `worker/.env` on the **machine that runs launchd**:

```env
CRM_API_URL=https://your-app.vercel.app
CRM_API_KEY=<same as WORKER_API_KEY on Vercel>
```

## Documentation

| Doc | When to read |
|-----|----------------|
| **[DEPLOY.md](DEPLOY.md)** | **New Vercel env, new Neon DB, new Mac worker, MacBook vs Mac mini** |
| [worker/README.md](worker/README.md) | Worker scripts, ContactOut self-healing, launchd, env vars |

**Important:** The Mac that runs `launchd` needs its own ContactOut session file and Keychain credentials. Your MacBook admin browser does not share them. See [DEPLOY.md — Three different “users”](DEPLOY.md#three-different-users-common-confusion).
