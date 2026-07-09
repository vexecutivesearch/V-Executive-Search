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

from src.caffeinate_guard import prevent_sleep  # noqa: E402
from src.crm_client import CRMClient  # noqa: E402
from src.crm_config import post_pipeline_status  # noqa: E402
from src.pipeline import LOG_DIR, run_pipeline  # noqa: E402


def setup_logging(run_date_str: str, verbose: bool, suffix: str = "") -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    name = f"daily_{run_date_str}{f'_{suffix}' if suffix else ''}.log"
    log_path = LOG_DIR / name

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


def run_contactout_backfill(limit: int = 10) -> int:
    """Mac-only: ContactOut dashboard pass for contacts missing personal data."""
    if sys.platform != "darwin":
        return 0
    playwright_root = WORKER_ROOT.parent / "Playwright"
    script = playwright_root / "scripts" / "contactout_dashboard_sync.py"
    if not script.exists():
        return 0
    import importlib.util

    spec = importlib.util.spec_from_file_location("contactout_dashboard_sync", script)
    if not spec or not spec.loader:
        return 0
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return int(mod.run_dashboard_sync(limit=limit))


def run_presence_checks() -> None:
    """iMessage + email MX verification (Mac iMessage portion)."""
    script = WORKER_ROOT / "scripts" / "check_presence.py"
    if not script.exists():
        return
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_presence", script)
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.main()


def run_imessage_checks(limit: int) -> int:
    imessage_script = WORKER_ROOT / "scripts" / "check_imessage.py"
    if not imessage_script.exists():
        return 0
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_imessage", imessage_script)
    if not spec or not spec.loader:
        return 0
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return int(mod.run_imessage_checks(limit=limit, delay=2.0))


def send_call_sheet_email(config_path: Path | None) -> bool:
    from src.config_loader import get_notification_email, load_config
    from src.email_report import send_daily_report_for_pipeline

    config = load_config(config_path)
    notify = get_notification_email(config) or os.environ.get("ALERT_EMAIL")
    geo_label = (config.get("settings") or {}).get("geo_label", "Unknown")
    if not notify:
        return False
    return send_daily_report_for_pipeline(
        to_email=notify,
        pipeline_rows=[],
        result_summary={},
        geo_label=geo_label,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily recruiter list pipeline")
    parser.add_argument("--dry-run", action="store_true", help="Scrape and dedupe only, no enrichment credits")
    parser.add_argument("--skip-crm", action="store_true", help="Skip CRM API calls")
    parser.add_argument("--waterfall", action="store_true", help="Use Apollo + ContactOut waterfall")
    parser.add_argument("--config", type=Path, default=None, help="Path to searches.yaml")
    parser.add_argument("--limit", type=int, default=None, help="Max companies to enrich (for testing)")
    parser.add_argument(
        "--include-existing",
        action="store_true",
        help="(Legacy) ignored in v2 JIT pipeline",
    )
    parser.add_argument(
        "--scrape-only",
        action="store_true",
        help="Scrape + jobs_only ingest only (no enrichment)",
    )
    parser.add_argument(
        "--enrich-only",
        action="store_true",
        help="Enrich top-N from ranked queue only",
    )
    parser.add_argument(
        "--rescore-only",
        action="store_true",
        help="Re-score full backlog via CRM API",
    )
    parser.add_argument(
        "--email-only",
        action="store_true",
        help="Send call sheet email from CRM data",
    )
    parser.add_argument(
        "--imessage-only",
        action="store_true",
        help="Run iMessage checks on pending contacts",
    )
    parser.add_argument(
        "--presence-only",
        action="store_true",
        help="Run iMessage + email MX verification",
    )
    parser.add_argument(
        "--hygiene-only",
        action="store_true",
        help="Archive stale job listings",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    load_dotenv(WORKER_ROOT / ".env")

    from datetime import date

    run_date_str = date.today().isoformat()
    mode_suffix = ""
    if args.scrape_only:
        mode_suffix = "scrape"
    elif args.enrich_only:
        mode_suffix = "enrich"
    elif args.rescore_only:
        mode_suffix = "rescore"
    elif args.email_only:
        mode_suffix = "email"
    elif args.imessage_only:
        mode_suffix = "imessage"
    elif args.presence_only:
        mode_suffix = "presence"
    elif args.hygiene_only:
        mode_suffix = "hygiene"

    log_path = setup_logging(run_date_str, args.verbose, mode_suffix)
    logger = logging.getLogger(__name__)

    with prevent_sleep():
        try:
            post_pipeline_status("worker_heartbeat")
        except Exception:
            pass

        rotate_script = WORKER_ROOT / "scripts" / "rotate_logs.sh"
        if rotate_script.exists():
            import subprocess

            subprocess.run(["bash", str(rotate_script)], check=False)

        if args.rescore_only:
            logger.info("Rescore-only run")
            crm = CRMClient()
            if not crm.is_configured:
                logger.error("CRM not configured")
                return 1
            result = crm.rescore_backlog()
            logger.info(
                "Rescore complete — scored=%s icp_match=%s",
                result.get("scored"),
                result.get("icpMatch"),
            )
            logger.info("Log written to %s", log_path)
            return 0

        if args.email_only:
            logger.info("Email-only run")
            ok = send_call_sheet_email(args.config)
            logger.info("Call sheet email sent=%s", ok)
            logger.info("Log written to %s", log_path)
            return 0 if ok else 1

        if args.imessage_only:
            logger.info("iMessage-only run")
            n = run_imessage_checks(50)
            logger.info("iMessage checks completed: %d contact(s)", n)
            logger.info("Log written to %s", log_path)
            return 0

        if args.presence_only:
            logger.info("Presence-only run")
            import importlib.util

            script = WORKER_ROOT / "scripts" / "check_presence.py"
            spec = importlib.util.spec_from_file_location("check_presence", script)
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                return mod.main()
            return 0

        if args.hygiene_only:
            logger.info("Hygiene-only run")
            from src.crm_client import CRMClient

            crm = CRMClient()
            archived = crm.archive_stale_jobs()
            logger.info("Archived %s stale listings", archived.get("archived"))
            logger.info("Log written to %s", log_path)
            return 0

        stage_flags = sum(
            1 for flag in (args.scrape_only, args.enrich_only) if flag
        )
        if stage_flags > 1:
            logger.error("Use only one of --scrape-only or --enrich-only")
            return 1

        logger.info(
            "Starting pipeline (dry_run=%s scrape_only=%s enrich_only=%s)",
            args.dry_run,
            args.scrape_only,
            args.enrich_only,
        )

        try:
            result = run_pipeline(
                dry_run=args.dry_run,
                skip_crm=args.skip_crm,
                skip_email=True,
                use_waterfall=args.waterfall,
                config_path=args.config,
                limit=args.limit,
                include_existing=args.include_existing,
                scrape_only=args.scrape_only,
                enrich_only=args.enrich_only,
            )
        except Exception as exc:
            logger.exception("Pipeline crashed: %s", exc)
            send_failure_alert(str(exc))
            return 1

        if result.errors:
            for err in result.errors:
                logger.warning("Error: %s", err)
            if result.listings_scraped == 0 and not args.enrich_only:
                send_failure_alert("\n".join(result.errors))
                return 1

        if not args.dry_run and not args.skip_crm and not args.scrape_only:
            if result.contacts_enriched > 0 or args.enrich_only:
                try:
                    co_n = run_contactout_backfill(
                        limit=max(10, result.contacts_enriched * 2),
                    )
                    if co_n:
                        logger.info("ContactOut dashboard backfill updated %d contact(s)", co_n)
                except Exception as exc:
                    logger.warning("ContactOut backfill failed (non-fatal): %s", exc)

            try:
                run_presence_checks()
            except Exception as exc:
                logger.warning("Presence check failed (non-fatal): %s", exc)

        if not args.dry_run and not args.scrape_only and not args.enrich_only:
            try:
                from src.config_loader import get_notification_email, load_config
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
                            "icp_match_count": result.icp_match_count,
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
