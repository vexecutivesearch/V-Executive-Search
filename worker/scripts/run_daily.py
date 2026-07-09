#!/usr/bin/env python3
from __future__ import annotations

import argparse
import logging
import os
import smtplib
import sys
from email.mime.text import MIMEText
from pathlib import Path

from dotenv import load_dotenv

# Allow running as `python scripts/run_daily.py` from worker/
WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

from src.pipeline import LOG_DIR, run_pipeline  # noqa: E402


def setup_logging(run_date_str: str, verbose: bool) -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"daily_{run_date_str}.log"

    handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(log_path, encoding="utf-8"),
    ]
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=handlers,
    )
    return log_path


def send_failure_alert(error_summary: str) -> None:
    import os

    alert_email = os.environ.get("ALERT_EMAIL")
    if not alert_email:
        return

    msg = MIMEText(f"V Executive Search pipeline failed:\n\n{error_summary}")
    msg["Subject"] = "[V Exec Search] Pipeline failure"
    msg["From"] = alert_email
    msg["To"] = alert_email

    try:
        with smtplib.SMTP("localhost", 25, timeout=10) as smtp:
            smtp.send_message(msg)
    except OSError as exc:
        logging.getLogger(__name__).warning("Could not send alert email: %s", exc)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily recruiter list pipeline")
    parser.add_argument("--dry-run", action="store_true", help="Scrape and dedupe only, no enrichment credits")
    parser.add_argument("--skip-crm", action="store_true", help="Skip CRM API calls")
    parser.add_argument("--waterfall", action="store_true", help="Use Apollo + Hunter email fallback")
    parser.add_argument("--config", type=Path, default=None, help="Path to searches.yaml")
    parser.add_argument("--limit", type=int, default=None, help="Max companies to enrich (for testing)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    load_dotenv(WORKER_ROOT / ".env")

    from datetime import date

    run_date_str = date.today().isoformat()
    log_path = setup_logging(run_date_str, args.verbose)
    logger = logging.getLogger(__name__)
    logger.info("Starting pipeline (dry_run=%s)", args.dry_run)

    if sys.platform == "darwin" and not args.dry_run:
        try:
            from src.enrich.contactout_dashboard import prepare_contactout_dashboard

            prepare_contactout_dashboard(interactive=False)
        except Exception as exc:
            logger.warning("ContactOut session prep failed (non-fatal): %s", exc)

    # Rotate old logs
    rotate_script = WORKER_ROOT / "scripts" / "rotate_logs.sh"
    if rotate_script.exists():
        import subprocess
        subprocess.run(["bash", str(rotate_script)], check=False)

    try:
        result = run_pipeline(
            dry_run=args.dry_run,
            skip_crm=args.skip_crm,
            skip_email=True,
            use_waterfall=args.waterfall,
            config_path=args.config,
            limit=args.limit,
        )
    except Exception as exc:
        logger.exception("Pipeline crashed: %s", exc)
        send_failure_alert(str(exc))
        return 1

    if result.errors:
        for err in result.errors:
            logger.warning("Error: %s", err)
        if result.listings_scraped == 0:
            send_failure_alert("\n".join(result.errors))
            return 1

    if not args.dry_run and not args.skip_crm:
        try:
            imessage_script = WORKER_ROOT / "scripts" / "check_imessage.py"
            if imessage_script.exists():
                import importlib.util

                spec = importlib.util.spec_from_file_location(
                    "check_imessage", imessage_script
                )
                if spec and spec.loader:
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
                    n = mod.run_imessage_checks(limit=50, delay=2.0)
                    logger.info("iMessage checks completed: %d contact(s)", n)
        except Exception as exc:
            logger.warning("iMessage check pass failed (non-fatal): %s", exc)

        try:
            from src.config_loader import load_config, get_notification_email
            from src.email_report import send_daily_report_for_pipeline

            config = load_config(args.config)
            notify = get_notification_email(config) or os.environ.get("ALERT_EMAIL")
            geo_label = (config.get("settings") or {}).get("geo_label", "Unknown")
            if notify:
                send_daily_report_for_pipeline(
                    to_email=notify,
                    pipeline_rows=result.rows,
                    result_summary={
                        "run_date": str(result.run_date),
                        "listings_scraped": result.listings_scraped,
                        "companies_enriched": result.companies_enriched,
                        "credits_used": result.credits_used,
                    },
                    geo_label=geo_label,
                )
        except Exception as exc:
            logger.warning("Daily email failed (non-fatal): %s", exc)

    logger.info("Log written to %s", log_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
