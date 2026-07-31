# Deployment & greenfield setup

Use this guide when standing up a **new Vercel environment**, **new Neon database**, or **new Mac worker machine**. The system has three independent surfaces that must be wired together.

**Ops changelog (Jul 2026 SerpApi, morning email wait, ICP annotate, Outreach/IMAP):**  
[docs/OPS-CHANGELOG-JUL-2026.md](docs/OPS-CHANGELOG-JUL-2026.md)

**Canonical CRM (locked):** `https://v-executive-search-delta.vercel.app`  
Worker `CRM_API_URL` and email “Open CRM” links must **never** point at legacy `v-executive-search.vercel.app`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel (Next.js CRM) — delta host only        Neon Postgres    │
│  • /crm Pipeline, /runs, /admin                • companies, …   │
│  • /api/ingest (+ ICP annotate), /api/pipeline • daily_runs     │
└────────────────────────────▲────────────────────────────────────┘
                             │ HTTPS + WORKER_API_KEY
┌────────────────────────────┴────────────────────────────────────┐
│  Mac worker (ONE machine — residential IP)                        │
│  • launchd on release checkout = origin/worker-production         │
│  • Scrape → jobs-only ingest → LinkedIn posters (Stage 2b)        │
│  • SerpApi Google (metered/gated); Indeed/LinkedIn always         │
│  • 07:45 email WAITS for ingest; rescore never invents ghost runs │
│  • Canonical env: ~/.vsearch/worker.env (never in git)            │
│  • Paid enrich MANUAL ONLY; Outreach IMAP OAuth (PR #14 testing)  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Your MacBook / phone (optional — no worker install required)    │
│  • Browser → /admin → state/market, boards, titles, Run now       │
│  • Admin → Send today’s call sheet if Mac 07:45 email fails       │
└─────────────────────────────────────────────────────────────────┘
```

**Rules:**

- Job scraping runs on **one home Mac** with a residential IP. Vercel hosts the CRM and admin UI only.
- ContactOut uses the **API only** (`CONTACTOUT_API_KEY`) — no browser automation.
- Job boards and geo are toggled in `/admin` (Postgres); the worker reads them on each run.
- Promote worker code via `worker-production` (**both** `origin` and `vexec` remotes if you use both), not raw `main`. See [Worker release promotion](#worker-release-promotion).
- **Always bootstrap after promoting** — a tip move without `bootstrap_release.sh` leaves the mini on a stale SHA (Admin drift).
- **Never bootstrap mid-scrape** — swapping the release worktree kills long Stage 1 / poster runs.

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
- [ ] Install **Python ≥ 3.10** (Homebrew `python@3.12`); system `/usr/bin/python3` (3.9) is too old for the worker package
- [ ] Grant Full Disk Access to the frozen interpreter so inbound texts work — see [Full Disk Access](#full-disk-access-inbound-texts)
- [ ] Create canonical env: `mkdir -p ~/.vsearch && cp worker/.env.example ~/.vsearch/worker.env` and fill keys  
      Set `CRM_API_URL=https://v-executive-search-delta.vercel.app` (no trailing slash)
- [ ] Promote a tested SHA to `worker-production` on **origin and vexec**, then:

```bash
bash worker/scripts/bootstrap_release.sh
bash worker/scripts/verify_release_launchd.sh
```

  Bootstrap builds the release venv against the frozen interpreter at
  `~/.vsearch/python/...` (installing it first if missing) — see
  [Full Disk Access](#full-disk-access-inbound-texts). Do **not** override
  `WORKER_BOOTSTRAP_PYTHON` with a Homebrew path; that reintroduces the
  upgrade-voids-the-grant bug.

- [ ] Admin → Worker status: SHA matches `worker-production`, **drift false**
- [ ] Confirm `SERPAPI_SCHEDULE_GATE_BYPASS` is **unset** in `~/.vsearch/worker.env`
- [ ] From the release checkout: `python scripts/health_check.py` → critical checks pass (no paid egress)
- [ ] Admin → **Run now** → confirm poll picks it up within 5 minutes

### Do NOT do on MacBook if Mac mini is the worker

- [ ] Do not install launchd on both machines (only one scheduler)

---

## Daily pipeline (JIT enrichment — Eastern Time)

The worker runs **staged free jobs twice daily** (5 AM and 6 PM scrape) instead of enriching every net-new company:

| Time (ET) | Job | Credits |
|-----------|-----|---------|
| 05:00 | Scrape → chunked `jobs_only` ingest → LinkedIn posters (Stage 2b) | Free |
| 06:15 | Archive stale listings | Free |
| 06:30 | Rescore backlog (**never** creates empty ghost `daily_runs`) | Free |
| 07:30 | iMessage + email MX presence checks | Free |
| 07:45 | Call sheet email — **waits** until today’s `listings_scraped > 0` (default 2h) | Free |
| 18:00 | Evening scrape → chunked `jobs_only` ingest → posters | Free |
| 18:30 | Evening rescore backlog | Free |
| Every 5 min | Poll: Admin **Run now**, optional Outreach pump (PR #14) | Free |

**Ordering:** ingest lands in Neon **before** LinkedIn poster crawl. A slow Stage 1 (often finishing ~09:00 on large markets) must not leave Runs empty — if email fires first, it now polls CRM until ingest exists (or timeout).

Admin **Run now** (5-min poll) runs scrape-only/jobs-only ingest by default.
Apollo and ContactOut paid egress are manual-only.

Large scrapes POST companies in chunks (~200 companies / ~3.5 MB) so Vercel
does not return **413 Request Entity Too Large**. Later chunks zero
`listings_scraped` so additive `daily_runs` counters stay correct.

After each ingest chunk, CRM **ICP-annotates** touched companies (`company_icp`) so Pipeline badges (ICP N / role / est. salary) appear without a manual script.

Configure **N** and score thresholds in `/admin` → Enrichment quotas.
LinkedIn hiring-team poster crawl defaults on (`LINKEDIN_FETCH_HIRING_TEAM=true`);
set `false` for faster scrape-only validation runs.

**Business day** for Runs / call sheet: **5 AM – 5 AM Eastern**.

Default job boards: **Indeed, LinkedIn, ZipRecruiter**. **Google Jobs** uses **SerpApi** when `SERPAPI_API_KEY` is set on the Mac worker (auto-enabled at scrape time). JobSpy’s Google scraper is not used. Glassdoor is available but off. Toggle in `/admin` → Job boards.

If Mac **07:45 email fails**, use Admin → **Send today’s call sheet** (Vercel Resend) once ingest is present.

### SerpApi credit optimization (Google board only)

The pipeline still runs **both 5 AM and 6 PM, seven days a week** — Indeed and
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
- **Schedule gate**: Google runs the **AM** slot only, weekdays only — logged as
  `board_skipped: schedule_gate` (informational, never a failure). A manual
  afternoon "Run now" therefore skips Google; force with
  `SERPAPI_SCHEDULE_GATE_BYPASS=1` or widen `GOOGLE_BOARD_RUNS`/`GOOGLE_BOARD_DAYS`.
  **Production:** leave the bypass **unset**.
- **Marginal-yield pagination** (NOT a fixed page cap): pages continue while
  the per-page net-new ratio ≥ `GOOGLE_PAGE_MIN_YIELD` (0.3); `GOOGLE_MAX_PAGES`
  (5) is a circuit breaker and cold markets get `GOOGLE_MAX_PAGES_COLD` (10).
  If the CRM known-listings lookup is down, pagination stops (never spend
  blind). Per-page ratios are logged in the funnel.
- **Adaptive title frequency**: titles with zero net-new companies in a market
  for 3 consecutive runs drop to every-2-days there; any net-new promotes
  back to daily. `GOOGLE_ADAPTIVE_ENABLED=false` reverts to daily everywhere.
- Controller init errors are isolated — Indeed/LinkedIn still complete.

### Outreach IMAP (PR #14 — testing; do not treat as merged until weekend sign-off)

GoDaddy Microsoft 365 often **hides app passwords**. Prefer **OAuth device-code**:

1. Entra → App registration (single-tenant) → Allow public client flows = Yes  
2. API permissions → Microsoft Graph → Delegated → `IMAP.AccessAsUser.All` → Grant admin consent  
3. In `~/.vsearch/worker.env`:

```env
OUTREACH_IMAP_HOST=outlook.office365.com
OUTREACH_IMAP_USER=odv@vexecutivesearch.com
OUTREACH_MS_CLIENT_ID=<app client id>
OUTREACH_MS_TENANT_ID=<directory id>
OUTREACH_IMAP_AUTH=auto
```

4. One-time on the mini (release or editable venv with `msal`):

```bash
WORKER_ENV_FILE=~/.vsearch/worker.env \
  .venv/bin/python scripts/outreach_imap_login.py
```

Token cache: `~/.vsearch/outreach_msal_token.json` (chmod 600). Poll agent refreshes silently.

Legacy `OUTREACH_IMAP_PASSWORD` remains a fallback only for tenants that still allow basic IMAP.

Full product notes: [docs/OPS-CHANGELOG-JUL-2026.md](docs/OPS-CHANGELOG-JUL-2026.md).

### Outreach Sequencer (email + iMessage automation)

Reply-aware sequencing lives at **/admin/outreach** (+ `/admin/outreach/flows`
visual builder). It ships **OFF + dry-run + approval-gated** — nothing sends
until the switches are flipped deliberately.

**Live auto-send** (Call List add → draft + queue + send) requires all of:
Master send **On**, Dry-run **Off**, Approval gate **Off** (or Call List
auto-approve), and Auto-enroll **On**. Day 0 queues intro email **and** a
same-day iMessage when the contact is iMessage-capable; email goes out via
Resend in the contact-local send window; SMS only leaves when the **Mac worker**
is running and polling `/api/outreach/imessage-queue`.

#### Text Message Forwarding (green-bubble SMS fallback)

Most business mobiles are **not** iMessage accounts. Messages.app accepts an
iMessage to one anyway and then shows a blue "Not Delivered" bubble, so the
worker never trusts the AppleScript return. It decides the transport up front
from Apple's own IDS registry, verifies the send against `chat.db`, and retries
once over the **SMS** service when iMessage provably cannot deliver.

That fallback needs an SMS service to exist on the Mac, which only happens with
**Text Message Forwarding** enabled for this Mac on the paired iPhone (iPhone →
Settings → Messages → Text Message Forwarding). Without it there is no green
bubble to fall back to and non-iMessage numbers simply cannot be texted from
here — the worker reports that explicitly rather than marking the send `sent`.
Confirm from launchd (a terminal inherits the parent app's Automation grant and
gives a false pass):

```bash
launchctl kickstart -k gui/$UID/com.vexecsearch.poll
grep -E 'sent via|no iMessage account|late verify|Text Message Forwarding' \
  ~/Projects/V-Executive-Search-release/worker/logs/poll_stderr.log | tail -5
```

##### Which signals actually work

Measured on the release Mac's `chat.db` (210 messages, 98 outbound) — the
obvious columns are the wrong ones:

| Signal | Reality | Verdict |
| --- | --- | --- |
| `error != 0` | **0 of 210** rows, including a genuinely failed send | useless alone; kept as a backstop |
| `is_delivered` | `1` on **all 95** outbound iMessage rows, including 2 never delivered | never trusted for iMessage |
| `date_delivered` | set on all 93 real receipts (p50 0.39s, p90 0.98s, **max 5.08s**), NULL on both failures | **the delivery signal** |
| `was_downgraded` | `1` on the one row Messages re-sent as SMS itself | already delivered — never retry |
| IDS `com.apple.madrid` status | `1` for all 4 numbers with delivered blue bubbles, `2` for all 3 with no Apple account | **the capability signal** |

`identityservicesd` caches every capability lookup Messages performs in
`~/Library/IdentityServices/ids-query.db`. A handle it resolved for iMessage is
in `ZIDSQUERYSDADDRESSABLE` with `ZIDSQUERYSDSTATUS.ZSTATUS = 1`; one it could
not is `ZSTATUS = 2` and never addressable. That is the only trustworthy
capability answer on the box — `buddy "x" of service` is an AppleScript
reference specifier that resolves for any well-formed string, and
`handle.service` in `chat.db` optimistically says `iMessage` for numbers that
have none. Any problem reading the store (missing, renamed tables) degrades to
"unknown", which sends iMessage-first exactly as before.

##### How a failed send gets rescued

1. **Before sending**, a number IDS says has no Apple account goes out as SMS
   directly — no undeliverable blue bubble is ever created.
2. **Inline**, for `OUTREACH_SEND_VERIFY_SECONDS` (default 20, ~4× the 5.08s
   worst-case receipt), the pump watches the row. The send itself triggers the
   IDS lookup, so "no Apple account" normally lands within a second or two and
   the SMS retry happens on the same tick.
3. **Asynchronously**, a send still lacking a receipt is recorded in
   `~/.vsearch/outreach_state.json` against its `chat.db` ROWID and reported
   `sent` (so the queue cannot serve it twice). Later ticks re-read that exact
   row — Messages rewrites rows in place, so the ROWID survives a downgrade.

The re-check never blocks a poll and cannot double-send. A record authorises at
most **one** SMS retry, and the flag is persisted *before* the send so a crash
leaves the message unretried rather than retried twice. It retries only when IDS
confirms the number has no Apple account: a receipt-less iMessage to a real
Apple account (phone off, no signal) still arrives later, and texting again
would duplicate it. A `was_downgraded` row is treated as delivered-over-SMS, not
as a fresh failure. Nothing is retried inside
`OUTREACH_PENDING_GRACE_SECONDS` (default 120), and after
`OUTREACH_PENDING_MAX_AGE_SECONDS` (default 3600) the message is marked
**failed** with a manual-send note instead of being watched forever.

Set `OUTREACH_SMS_FALLBACK=0` in `~/.vsearch/worker.env` for iMessage-only sends.

The transport the CRM records lands in the enrollment event payload
(`transport`), and a send that was reported `sent` but never delivered is
corrected to `failed` by the late verification.

The learned transport is derived from `chat.db` at send time and cached
nowhere, so a number "forgets" only when its Messages conversation is deleted.
To re-run the full transport ladder without destroying that history, set
`OUTREACH_TRANSPORT_RESET` in `~/.vsearch/worker.env` to a comma-separated list
of numbers (or `all`). It outranks both the learned transport and the IDS
shortcut, so the number really does start from iMessage and exercise the whole
ladder. It takes effect on the next poll tick — the pump reloads the env each
run, so no launchd reload is needed.

#### Automation (Apple Events) permission

Driving Messages.app also needs TCC **Automation**, granted per
(client, target) pair. macOS prompts once for the worker interpreter → Messages
and stores the grant keyed to the interpreter's absolute path **and** its exact
code-signature hash. Because the interpreter is frozen at
`~/.vsearch/python/…` (see [Full Disk Access](#full-disk-access-inbound-texts)),
one Allow lasts across polls and reboots. Re-running
`install_stable_python.sh --force`, or moving to a new interpreter such as
Python 3.13, changes the hash or path and re-prompts.

Setup checklist:

1. `npm run db:push` — creates the outreach tables (templates, enrollments,
   messages, inbound, suppressions, enrollment_events audit log, notifications,
   flows + immutable versions, sending_profiles, outreach_settings).
2. Vercel env: `ANTHROPIC_API_KEY` (drafting + reply classification),
   `OUTREACH_FROM_EMAIL` (fallback sender until domain profiles exist),
   optional `OUTREACH_SENDER_NAME/TITLE/FIRM/PHONE`,
   `OUTREACH_SCHEDULING_LINK` (defaults to the ODV Calendly 15 min link
   `https://calendly.com/odv-vexecutivesearch/15m` when unset; included on all
   positive / positive_link_request auto-replies. If this var is already set on
   Vercel it wins over the default, so change it there too when the booking link
   changes — the reply copy takes its call length from the slug),
   `RESEND_WEBHOOK_SECRET`, Google Calendar free/busy
   (`GOOGLE_CALENDAR_CLIENT_ID/SECRET/REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`).
3. Resend dashboard: add a webhook → `https://<crm>/api/webhooks/resend?token=<RESEND_WEBHOOK_SECRET>`
   for `email.delivered`, `email.bounced`, `email.complained`. The handler
   matches `resend_id` against outreach messages and ignores transactional app
   emails (a bounced daily report never dings a profile or suppresses anyone).
   **Verify it is live**: Admin → Outreach → Analytics profile counters —
   `delivered` stuck at 0 while `sent` grows means the webhook is not
   configured or the token mismatches, and bounces/complaints are invisible
   (this was the case as of Jul 30, 2026 — 12 sends, 0 delivered events).
   - Deliverability headers: outreach sends carry RFC 8058
     `List-Unsubscribe` / `List-Unsubscribe-Post` (one-click) pointing at
     `/api/unsubscribe`. Tokens are HMAC-signed with
     `OUTREACH_UNSUBSCRIBE_SECRET` (falls back to `WORKER_API_KEY`); the URL
     uses `NEXT_PUBLIC_APP_URL`. Both must be set on Vercel or the header is
     omitted. GET shows a confirm page (mail scanners follow GETs); only POST
     suppresses.
   - Known junk signal, config not code: the From domain (`vexecsearch.com`
     profiles) differs from the Reply-To domain (`vexecutivesearch.com`
     watched mailbox). Fix by either watching a mailbox on the sending root
     domain or sending from the watched domain — do NOT just drop Reply-To,
     or replies stop reaching the IMAP poll and the whole reply loop dies.
4. Call List statuses are funnel-ordered and automated writes only move
   forward: a positive reply lands on **Replied — Interested**
   (`replied_interested`); **Call Booked** (`meeting_scheduled`) is written
   only by a real Calendly booking, and once booked no later reply intent can
   demote the row (only a Calendly cancellation, or a terminal status like
   opt-out). Manual edits in the UI can still set anything.
5. Calendly → CRM Call Booked: create a webhook subscription for
   `invitee.created` + `invitee.canceled` →
   `https://v-executive-search-delta.vercel.app/api/webhooks/calendly?token=<CALENDLY_WEBHOOK_SECRET>`.
   Vercel env: `CALENDLY_WEBHOOK_SECRET` (required for `?token=`), optional
   `CALENDLY_WEBHOOK_SIGNING_KEY` (HMAC header verify), optional
   `CALENDLY_API_TOKEN` (hydrate start/end when the payload is URI-only).
   Outlook invites come from Calendly’s connected calendar for `odv@vexecutivesearch.com` (already set up) — the CRM does not push to Outlook.
6. Worker env (`~/.vsearch/worker.env`) for the Reply-To mailbox:
   - `OUTREACH_IMAP_HOST=outlook.office365.com`
   - `OUTREACH_IMAP_USER=…`
   - **Preferred (M365 / GoDaddy):** `OUTREACH_MS_CLIENT_ID` (+ optional
     `OUTREACH_MS_TENANT_ID`), then one-time
     `scripts/outreach_imap_login.py` (device-code OAuth → MSAL cache).
     Entra app must be a public client with delegated
     `IMAP.AccessAsUser.All` (Office 365 Exchange Online).
   - **Legacy:** `OUTREACH_IMAP_PASSWORD` (app password) when the tenant still
     allows basic IMAP auth.
   The existing 5-min poll agent pumps iMessage sends, chat.db inbound scans,
   and IMAP replies (`worker/scripts/outreach_pump.py`). Inbound texts also
   need [Full Disk Access](#full-disk-access-inbound-texts).
7. Domain rotation: Admin → Outreach → Domains → add a sending subdomain →
   create the shown SPF/DKIM/DMARC records → Verify DNS. Unverified profiles
   cannot send; verified ones warm up 5/day → +5 per clean week → ~50/day with
   automatic rollback on bounce >2% / complaint >0.1%.
8. Crons are already in `vercel.json` (`/api/cron/outreach-dispatch` every
   15 min). Contact-local send window defaults to **9–22** (9 AM–10 PM).
   Vercel cron is UTC: `*/15 12-23 * * 1-5` plus `*/15 0-6 * * 2-6` so
   dispatch keeps running through 10 PM Pacific year-round (and later ET).

#### Testing send window (temporary override)

Testing outside business hours used to mean widening the production window,
which ratcheted it from 17 to 22 in one evening and never got put back — a
window that wide means a real prospect can be texted at 10 PM. Instead use
**Admin → Outreach → Overview → Testing send window**: set the hours and a
duration, and the widened window applies immediately (no deploy, no SQL) and
**reverts on its own** when it expires. Max 12 hours per override; renew if a
session runs long. While it is on, an amber banner sits at the top of the
Overview tab with a live countdown and an **End now** button.

Production `sendWindowStartHour`/`sendWindowEndHour` are what apply whenever
the override is off, so leave them at genuine business hours.

Cron interaction: an override cannot widen dispatch beyond what the crons
cover — past **22** contact-local there is no cron running for West-Coast
contacts. Day-0 sends are unaffected because enrollment dispatches inline, but
later flow steps scheduled past that hour wait for the next cron day. The
admin UI warns when the chosen end hour crosses that line.

That **22** is set by Pacific *standard* time, the slowest zone: local 22:59
PST is 06:59 UTC, past the 06:45 last tick of `*/15 0-6`. Under DST the same
local hour is 05:59 UTC, so an end hour of **23** is in fact fully covered for
every continental zone (ET/CT/MT/PT all dispatch within a minute) — which is
why a summer testing override to 23 dispatches normally, and the same override
in January would strand West-Coast flow steps. Alaska and Hawaii sit outside
cron coverage at both 22 and 23. Re-derive with the schedules in `vercel.json`
before assuming; do not raise `CRON_COVERED_END_HOUR` to match a summer run.

The three `testing_window_*` columns on `outreach_settings` are nullable, so
adding them ahead of a deploy is backward compatible with the running build.

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

### Full Disk Access (inbound texts)

Reading `~/Library/Messages/chat.db` needs Full Disk Access. macOS TCC ignores
the launcher (`caffeinate`) and the venv symlink and judges the **interpreter
binary it resolves to**, keyed to an absolute path plus that binary's exact
code-signature hash.

So the grant must go on a path Homebrew never rewrites. `install_stable_python.sh`
copies the Homebrew framework to `~/.vsearch/python/`, rewrites the three Mach-O
files that hardcode the versioned Cellar path, and re-signs ad-hoc. The result is
frozen: `brew upgrade python@3.12` cannot move or modify it, so one grant lasts.
The script is idempotent and refuses to rebuild without `--force`, because
rewriting the binary changes its hash and voids the grant.

One-time grant on a new worker Mac:

```bash
bash worker/scripts/install_stable_python.sh     # prints the exact path
open ~/.vsearch/python/Python.framework/Versions/3.12/bin
```

Then drag `python3.12` from that Finder window onto **System Settings → Privacy
& Security → Full Disk Access** and switch it on. Drag-and-drop is required —
the `+` button will not select a bare unix binary.

Verify from launchd, never from a terminal (a terminal inherits its parent app's
Full Disk Access and reports a false pass):

```bash
launchctl kickstart -k gui/$UID/com.vexecsearch.poll
grep chat.db ~/Projects/V-Executive-Search-release/worker/logs/poll_stderr.log | tail -3
```

`chat.db scan: N row(s) past rowid=…` is healthy. `chat.db unreadable — inbound
texts are NOT being ingested` means the grant is missing or lapsed. To check the
interpreter directly, run `worker/scripts/check_full_disk_access.py` from a
launchd job.

Switching an already-live venv onto the frozen interpreter (grant it **first**,
or inbound texts stop):

```bash
bash worker/scripts/point_venv_at_stable_python.sh <release>/worker/.venv
bash worker/scripts/point_venv_at_stable_python.sh --revert <release>/worker/.venv   # rollback
```

### Legacy note

Older installs used a single 6 AM / 6 PM job (`com.vexecsearch.daily`). Re-run bootstrap (or `install_launchd.sh`) to migrate to the JIT **5 AM / 6 PM** schedule.

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
| `CRM_API_URL` | Yes | **`https://v-executive-search-delta.vercel.app`** (no path; never legacy host) |
| `CRM_API_KEY` | Yes | **Must equal** Vercel `WORKER_API_KEY` |
| `ALERT_EMAIL` | Yes | Pipeline failure alerts |
| `RESEND_API_KEY` | Yes | Daily HTML report from worker |
| `REPORT_FROM_EMAIL` | Yes | Resend-verified sender |
| `CONTACTOUT_API_KEY` | Recommended | Personal email/mobile via LinkedIn URL |
| `SERPAPI_API_KEY` | Optional | Google Jobs via SerpApi on the Mac worker (auto-enables Google board) |
| `EMAIL_WAIT_FOR_SCRAPE_SECONDS` | Optional | Default `7200` — 07:45 waits for ingest |
| `EMAIL_WAIT_POLL_SECONDS` | Optional | Default `60` |
| `OUTREACH_MS_CLIENT_ID` | PR #14 | Entra app client ID for IMAP OAuth |
| `OUTREACH_MS_TENANT_ID` | PR #14 | Entra directory ID (or `organizations`) |
| `OUTREACH_IMAP_HOST` / `USER` | PR #14 | Usually `outlook.office365.com` + mailbox UPN |
| `WORKER_SELF_SYNC_ENABLED` | Optional | Opt-in: sync to `WORKER_RELEASE_REF` before a run |
| `WORKER_RELEASE_REF` | Optional | Default `origin/worker-production` (never raw `main`) |
| `WORKER_ENV_FILE` | Recommended | Canonical secrets path, usually `~/.vsearch/worker.env` |
| `WORKER_BOOTSTRAP_PYTHON` | Recommended | e.g. `/opt/homebrew/bin/python3.12` |
| `LINKEDIN_FETCH_HIRING_TEAM` | Optional | Default `true`; set `false` to skip poster crawl (much faster) |

See `worker/.env.example` for the full list (SerpApi knobs, LinkedIn draws, Outreach).

---

## Worker release promotion

Worker runtime code is promoted on a **dedicated ref**, not by pulling `main` into the live launchd checkout.

1. Land changes on a feature branch; merge/push as usual (CRM → Vercel on `main`).
2. After tests, `db:push` (if schema), and Vercel deploy: move `worker-production` to the tested SHA on **both remotes**:

```bash
git fetch origin vexec
git push origin <tested-sha>:refs/heads/worker-production
git push vexec <tested-sha>:refs/heads/worker-production
```

If the tip is not a fast-forward (e.g. Outreach branch diverged from `main`), **merge `worker-production` into the feature branch first**, then push the merge commit — or use an explicit force only when intentional.

3. On the Mac mini, from the **editable** clone (when **no scrape is running**):

```bash
WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12 \
  bash worker/scripts/bootstrap_release.sh
bash worker/scripts/verify_release_launchd.sh
launchctl list | grep vexecsearch
```

Bootstrap:

- Fetches `origin/worker-production`
- Builds a clean **detached** worktree (default `…/V-Executive-Search-release`)
- Creates a fresh `.venv` (needs Python ≥ 3.10), symlinks `~/.vsearch/worker.env` → `worker/.env`
- Reinstalls all eight launchd agents against that release
- Keeps the previous release worktree for rollback

Admin **Worker status** compares the mini’s reported SHA to the expected release ref. Detached `HEAD` is healthy when the SHA matches and **drift is false**.

Optional auto-sync before runs: set `WORKER_SELF_SYNC_ENABLED=true` in the canonical env (still only advances to `WORKER_RELEASE_REF`).

### Catch-up / forensics commands

```bash
# Email only (uses wait-for-ingest when listings already present → immediate send)
cd ~/Projects/V-Executive-Search-release/worker
WORKER_ENV_FILE=~/.vsearch/worker.env .venv/bin/python scripts/run_daily.py --email-only

# Logs (path after bootstrap)
tail -200 logs/email_stderr.log
tail -200 logs/scrape_am_stdout.log
```

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
| **Worker ingest 413** | Need chunked ingest (`crm_client.ingest_batch`); promote + bootstrap current tip |
| **Run now does nothing** | Poll only on worker Mac; agents must target release checkout |
| **Admin SHA drift** | Promote + **bootstrap** so heartbeat matches `worker-production` |
| **Runs shows × no run / 0 listings** | Check DB: real ingest may have landed later; ghost rescore rows are blocked by PR #18. Hard-refresh `/runs`. Old ghosts: delete zero-listing rows if still present |
| **No morning email** | Check `logs/daily_*_email.log` / `email_stderr.log`. Network/Resend failures exit 1. After PR #18, email waits for ingest; use Admin **Send today’s call sheet** as backup |
| **Email has 0 enriched leads** | Expected for scrape-only — report still includes top job posts / hot listings when configured |
| **Bootstrap fails `requires Python >=3.10`** | Set `WORKER_BOOTSTRAP_PYTHON=/opt/homebrew/bin/python3.12` |
| **Google skipped afternoon** | Schedule gate — normal; unset `SERPAPI_SCHEDULE_GATE_BYPASS` in prod |
| **No LinkedIn jobs** | LinkedIn blocks scrapers sometimes; check daily log; toggle board off/on |
| **ZipRecruiter 0 / 403** | Cloudflare blocks common; non-blocking `board_failure` — Indeed/LinkedIn still count |
| **IMAP LOGIN failed (M365)** | Use OAuth device login (PR #14), not mailbox password with MFA |
| **ContactOut no phones** | API plan may lack phone credits |
| **ContactOut HTTP 429** | Wait for cooldown; clear rate-limit marker after cooldown |
| **iMessage not tagging** | Messages signed in on worker Mac only |
| **Old boards after deploy** | Open `/admin` → Job boards → Save (or wait for auto-backfill) |
| **Wrong market hubs** | Confirm Admin Market; re-seed with `node scripts/seed-state-geo-configs.mjs` |
| **Scraping legacy CRM host** | Set `CRM_API_URL` to delta only; worker forbids legacy hostname |

---

## Related docs

- [README.md](README.md) — repo overview
- [worker/README.md](worker/README.md) — worker scripts and env reference
- [docs/OPS-CHANGELOG-JUL-2026.md](docs/OPS-CHANGELOG-JUL-2026.md) — SerpApi, morning forensics, IMAP, PR #14
- [docs/state-geo-expanded-coverage.md](docs/state-geo-expanded-coverage.md) — market counties / excluded hubs
- [docs/V-EXECUTIVE-SEARCH-SYSTEM.md](docs/V-EXECUTIVE-SEARCH-SYSTEM.md) — product + pipeline model
- [docs/V-Executive-Search-Playbook.md](docs/V-Executive-Search-Playbook.md) — operator playbook
