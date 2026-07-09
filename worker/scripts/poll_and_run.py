#!/usr/bin/env python3
"""Poll CRM for run requests and execute pipeline when admin clicks Run Now."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

load_dotenv(WORKER_ROOT / ".env")

from src.caffeinate_guard import prevent_sleep  # noqa: E402
from src.crm_config import get_pipeline_status, post_pipeline_status  # noqa: E402
from src.pipeline import run_pipeline  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def main() -> int:
    if sys.platform == "darwin":
        try:
            post_pipeline_status("worker_heartbeat")
        except Exception:
            pass

        status = get_pipeline_status()
        imessage_limit = 50 if status.get("imessage_check_requested_at") else 20

        try:
            import importlib.util

            script = WORKER_ROOT / "scripts" / "check_imessage.py"
            spec = importlib.util.spec_from_file_location("check_imessage", script)
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                n = mod.run_imessage_checks(limit=imessage_limit, delay=1.5)
                if n:
                    logging.info("iMessage poll tagged %d contact(s)", n)
                if status.get("imessage_check_requested_at"):
                    post_pipeline_status("clear_imessage_check_request")
        except Exception as exc:
            logging.warning("iMessage poll pass failed (non-fatal): %s", exc)

    status = get_pipeline_status()
    if status.get("contactout_sync_requested_at"):
        logging.info(
            "ContactOut sync flag cleared — enrichment uses API only (no Mac browser worker)"
        )
        post_pipeline_status("clear_contactout_sync_request")

    if not status.get("run_requested_at"):
        logging.info("No run requested — exiting")
        return 0

    logging.info("Run requested from admin — starting pipeline")
    exit_code = 0
    with prevent_sleep():
        try:
            result = run_pipeline(skip_email=True)
            if result.errors and result.listings_scraped == 0 and result.companies_found == 0:
                exit_code = 1
            elif not result.errors or result.listings_scraped > 0 or result.companies_enriched > 0:
                if sys.platform == "darwin":
                    try:
                        import importlib.util

                        backfill = WORKER_ROOT / "scripts" / "run_daily.py"
                        spec = importlib.util.spec_from_file_location("run_daily_helpers", backfill)
                        if spec and spec.loader:
                            mod = importlib.util.module_from_spec(spec)
                            spec.loader.exec_module(mod)
                            co_n = mod.run_contactout_backfill(
                                limit=max(10, result.contacts_enriched * 2),
                            )
                            if co_n:
                                logging.info(
                                    "ContactOut dashboard backfill updated %d contact(s)",
                                    co_n,
                                )
                            mod.run_presence_checks()
                    except Exception as exc:
                        logging.warning("Post-enrich presence/backfill failed (non-fatal): %s", exc)

                try:
                    import os
                    from src.config_loader import load_config, get_notification_email
                    from src.email_report import send_daily_report_for_pipeline

                    config = load_config()
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
                    logging.warning("Daily email failed (non-fatal): %s", exc)
        except Exception:
            logging.exception("Pipeline crashed during admin-triggered run")
            exit_code = 1
        finally:
            if post_pipeline_status("mark_run_complete"):
                logging.info("Cleared admin run request")
            else:
                logging.warning("Failed to clear admin run request — check CRM_API_URL/KEY")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
