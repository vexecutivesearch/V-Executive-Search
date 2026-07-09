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

from src.crm_config import get_pipeline_status, post_pipeline_status  # noqa: E402
from src.pipeline import run_pipeline  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def main() -> int:
    status = get_pipeline_status()
    if not status.get("run_requested_at"):
        logging.info("No run requested — exiting")
        return 0

    logging.info("Run requested from admin — starting pipeline")
    exit_code = 0
    try:
        result = run_pipeline()
        if result.errors and result.listings_scraped == 0:
            exit_code = 1
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
