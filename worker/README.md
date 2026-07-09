# V Executive Search — Worker

Daily pipeline: JobSpy scrape → dedupe → Apollo enrich → CSV / CRM.

## Setup

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
# Edit .env with your APOLLO_API_KEY
```

## Run

```bash
# Full pipeline → CSV in output/
python scripts/run_daily.py

# Scrape + dedupe only (no Apollo credits)
python scripts/run_daily.py --dry-run

# With Hunter email fallback
python scripts/run_daily.py --waterfall
```

## Schedule (Mac mini)

```bash
cp launchd/com.vexecsearch.daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vexecsearch.daily.plist
```

Edit the plist paths to match your install location.

## Config

Edit `config/searches.yaml` for job titles, locations, boards, and target contact titles.
