# Playwright — Archived ContactOut Dashboard Automation

> **NOT ENABLED IN PRODUCTION.** The live worker uses **ContactOut API only** (`worker/`).  
> This folder preserves the previous dashboard/browser approach for reference, experiments, or future opt-in use.

ContactOut dashboard scraping is fragile: Cloudflare Turnstile, session cookies, strict rate limits (~91 email lookups/day per account), and IP/session tracking. Use the API path in production.

---

## What is here

Recovered and optimized ContactOut **dashboard** automation:

| Component | Purpose |
|-----------|---------|
| `src/stealth_browser.py` | Patchright/Playwright launch, proxies, CDP fingerprint alignment |
| `src/human_behavior.py` | Random 3–7s pauses, human typing |
| `src/rate_limit.py` | 429 handling, Retry-After, exponential backoff |
| `src/enrich/contactout_dashboard.py` | Dashboard search + reveal emails/phones |
| `src/enrich/contactout_session.py` | Self-healing login ladder (canary → Keychain → OTP) |
| `src/enrich/contactout_hybrid.py` | API first, dashboard fallback |
| `scripts/contactout_login.py` | One-time interactive login |
| `scripts/contactout_keepalive.py` | Session cookie refresh |
| `scripts/contactout_dashboard_sync.py` | Trickle CRM backfill |

---

## Stealth stack (recommended order)

### 1. Patchright (default)

Drop-in Playwright replacement that patches automation flags (`navigator.webdriver`, `--disable-blink-features=AutomationControlled`, etc.).

```bash
pip install patchright
patchright install chrome
CONTACTOUT_BROWSER_ENGINE=patchright
```

### 2. Undetected-Playwright (alternative)

Python package that spoofs TLS/headless indicators. Swap import in `stealth_browser.py` if you prefer it over Patchright.

### 3. Camoufox (Firefox anti-detect)

Configurable Firefox-based anti-detect browser (WebGL, device fingerprints, proxy geo).

```bash
pip install -e ".[camoufox]"
CONTACTOUT_BROWSER_ENGINE=camoufox
```

See [Camoufox](https://github.com/daijro/camoufox).

### 4. SeleniumBase CDP hijack (advanced reCAPTCHA)

For hard reCAPTCHA flows: launch a stealth browser with SeleniumBase CDP mode, connect Playwright to the CDP endpoint. Not wired by default — see [SeleniumBase CDP guide](https://seleniumbase.io/examples/cdp_mode/ReadMe/).

---

## Best-practice tweaks (built in or via `.env`)

| Practice | Config |
|----------|--------|
| **Residential proxies** | `CONTACTOUT_PROXY_URL` or `CONTACTOUT_PROXY_LIST` (rotate per session) |
| **Headed mode** | `CONTACTOUT_HEADLESS=false` (default) — avoid headless for login/Turnstile |
| **Human delays** | `CONTACTOUT_HUMAN_DELAY_MIN_MS=3000`, `MAX_MS=7000` after clicks/navigation |
| **Profile pacing** | `CONTACTOUT_DASHBOARD_DELAY_MIN=60`, `MAX=150` seconds between lookups |
| **CDP alignment** | `CONTACTOUT_CDP_TIMEZONE`, `CONTACTOUT_CDP_LOCALE` match proxy geography |
| **System Chrome profile** | `CONTACTOUT_USE_SYSTEM_CHROME=true` + `CONTACTOUT_CHROME_PROFILE` for Turnstile |

---

## Fixing 429 / account lockouts

ContactOut enforces **hard credit and volume caps** tied to session + IP. Automation that loops profiles instantly triggers 429.

This folder implements:

1. **Exponential backoff** — on HTTP 429, honor `Retry-After` or sleep 2s → 4s → 8s → … (cap 15 min)
2. **Global cooldown file** — `.contactout-rate-limited` pauses all lookups
3. **Human session pacing** — 60–150s between dashboard profile lookups (not per-second loops)
4. **UI rate-limit detection** — stops when page body contains "too many requests" / "rate limit"
5. **Proxy rotation** — different residential IP per session when `CONTACTOUT_PROXY_LIST` is set

**Do not** run more than a handful of dashboard lookups per hour on one account. Prefer the API for production volume.

---

## Setup (isolated venv)

```bash
cd Playwright
chmod +x scripts/setup.sh scripts/install_launchd.sh
./scripts/setup.sh
cp .env.example .env   # if setup didn't
# Edit .env — session paths, Keychain account, proxies
```

### First login (Mac only)

```bash
source .venv/bin/activate
python scripts/contactout_login.py
```

Complete Cloudflare Turnstile manually in the **dedicated Chrome profile** (not your daily browser).

### Optional Keychain auto re-login

```bash
python scripts/contactout_store_credentials.py
```

### Test one lookup

```bash
python -c "
from dotenv import load_dotenv; load_dotenv('.env')
from src.enrich.contactout_dashboard import ContactOutDashboardClient
c = ContactOutDashboardClient()
print(c.enrich_linkedin('https://www.linkedin.com/in/example'))
c.close()
"
```

### Optional launchd (NOT production worker)

```bash
./scripts/install_launchd.sh
```

---

## Self-healing session ladder

| Layer | Script | When |
|-------|--------|------|
| 0 | `contactout_keepalive.py` | Every 5h — refresh cookies |
| 1 | `canary_check()` | Before each run |
| 2 | Keychain + IMAP OTP | Session dead |
| 3 | Email alert | Layer 2 fails |

---

## Why this is not in `worker/`

- High maintenance (Turnstile, DOM changes, 429 lockouts)
- ContactOut API is sufficient for most plans
- Residential Mac + manual session care does not scale for multi-client SaaS

Keep experiments here. Wire back to `worker/` only if you explicitly accept the operational cost.

---

## Related

- Production worker: [worker/README.md](../worker/README.md)
- Deployment: [DEPLOY.md](../DEPLOY.md)
