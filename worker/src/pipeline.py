from __future__ import annotations

import csv
import logging
import os
from datetime import date, datetime
from pathlib import Path
from typing import Any

from src.config_loader import load_config, get_notification_email
from src.crm_config import post_pipeline_status
from src.crm_client import CRMClient
from src.dedupe import collapse_to_companies, filter_existing_companies
from src.domain_resolver import resolve_domains
from src.enrich import get_provider
from src.enrich.contactout import get_contactout_client
from src.enrich.waterfall import WaterfallProvider
from src.models import EnrichedCompany, PipelineResult
from src.scrape import scrape_all
from src.timezone import business_today
from src.contact_phones import contact_phones_for_display
from src.email_report import send_daily_report_for_pipeline
from src.phone_utils import is_personal_email

logger = logging.getLogger(__name__)

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


def _rows_from_enriched(enriched: list[EnrichedCompany]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in enriched:
        company = item.company
        primary_listing = company.listings[0] if company.listings else None

        if not item.contacts:
            rows.append({
                "company": company.name,
                "domain": company.domain or "",
                "domain_confidence": company.domain_confidence.value,
                "contact_name": "",
                "title": "",
                "email": "",
                "phone": "",
                "linkedin_url": "",
                "job_title": primary_listing.job_title if primary_listing else "",
                "job_url": primary_listing.job_url if primary_listing else "",
                "board": primary_listing.board if primary_listing else "",
                "search_name": primary_listing.search_name if primary_listing else "",
            })
            continue

        for contact in item.contacts:
            personal_email = contact.personal_email
            work_email = contact.work_email
            if not personal_email and contact.email and is_personal_email(contact.email):
                personal_email = contact.email
            if not work_email and contact.email and not is_personal_email(contact.email):
                work_email = contact.email
            if work_email and personal_email and work_email == personal_email:
                work_email = None

            phones = contact_phones_for_display(
                {
                    "phones": contact.phones,
                    "phone": contact.phone,
                    "personal_phone": contact.personal_phone,
                    "company_phone": contact.company_phone,
                    "source_provider": contact.source_provider,
                }
            )

            rows.append({
                "company": company.name,
                "domain": company.domain or "",
                "domain_confidence": company.domain_confidence.value,
                "contact_name": contact.name,
                "title": contact.title,
                "email": contact.email or "",
                "work_email": work_email or "",
                "personal_email": personal_email or "",
                "phone": contact.phone or "",
                "personal_phone": contact.personal_phone or "",
                "company_phone": contact.company_phone or "",
                "phones": phones,
                "imessage_capable": None,
                "linkedin_url": contact.linkedin_url or "",
                "source_provider": contact.source_provider,
                "job_title": primary_listing.job_title if primary_listing else "",
                "job_url": primary_listing.job_url if primary_listing else "",
                "board": primary_listing.board if primary_listing else "",
                "search_name": primary_listing.search_name if primary_listing else "",
            })
    return rows


def _write_csv(rows: list[dict[str, Any]], run_date: date) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"daily_{run_date.isoformat()}.csv"
    if not rows:
        path.write_text("", encoding="utf-8")
        return path

    fieldnames = list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    return path


def _build_ingest_payload(
    enriched: list[EnrichedCompany],
    result: PipelineResult,
) -> dict[str, Any]:
    companies_payload = []
    for item in enriched:
        company = item.company
        companies_payload.append({
            "name": company.name,
            "domain": company.domain,
            "domain_confidence": company.domain_confidence.value,
            "contacts": [
                {
                    "name": c.name,
                    "title": c.title,
                    "email": c.email,
                    "work_email": c.work_email,
                    "personal_email": c.personal_email,
                    "phone": c.phone,
                    "personal_phone": c.personal_phone,
                    "company_phone": c.company_phone,
                    "phones": c.phones or [],
                    "linkedin_url": c.linkedin_url,
                    "apollo_id": c.apollo_id,
                    "source_provider": c.source_provider,
                    "location_matched": c.location_matched,
                    "contact_location": c.contact_location,
                    "job_location": c.job_location,
                }
                for c in item.contacts
            ],
            "job_listings": [
                {
                    "title": jl.job_title,
                    "board": jl.board,
                    "url": jl.job_url,
                    "location": jl.location,
                    "search_name": jl.search_name,
                    "posted_at": jl.date_posted.isoformat() if jl.date_posted else None,
                }
                for jl in company.listings
            ],
        })

    return {
        "run_date": result.run_date.isoformat(),
        "metadata": {
            "listings_scraped": result.listings_scraped,
            "companies_found": result.companies_found,
            "companies_skipped_existing": result.companies_skipped_existing,
            "companies_enriched": result.companies_enriched,
            "contacts_enriched": result.contacts_enriched,
            "credits_used": result.credits_used,
            "errors": result.errors,
        },
        "companies": companies_payload,
    }


def run_pipeline(
    *,
    dry_run: bool = False,
    skip_crm: bool = False,
    skip_email: bool = False,
    use_waterfall: bool = False,
    config_path: Path | None = None,
    limit: int | None = None,
) -> PipelineResult:
    run_date = business_today()
    config = load_config(config_path)
    enrichment_cfg = config.get("enrichment", {})

    target_titles = enrichment_cfg.get("target_titles") or config.get("target_titles", [])
    target_seniorities = enrichment_cfg.get("target_seniorities") or config.get(
        "target_seniorities", []
    )
    contacts_per_company = enrichment_cfg.get("contacts_per_company", 3)
    enrich_phone = enrichment_cfg.get("enrich_phone", False)
    daily_credit_cap = enrichment_cfg.get("daily_credit_cap", 100)
    provider_name = enrichment_cfg.get("provider", "apollo")

    if not dry_run:
        try:
            import sys
            from src.enrich.contactout_dashboard import prepare_contactout_dashboard

            if sys.platform == "darwin":
                prepare_contactout_dashboard()
        except Exception as exc:
            logger.warning("ContactOut session prep failed (non-fatal): %s", exc)

    result = PipelineResult(
        run_date=run_date,
        listings_scraped=0,
        companies_found=0,
        companies_skipped_existing=0,
        companies_enriched=0,
        contacts_enriched=0,
        credits_used=0,
    )

    # Stage 1: Scrape
    logger.info("=== Stage 1: Scraping job listings ===")
    listings = scrape_all(config)
    result.listings_scraped = len(listings)

    if not listings:
        result.errors.append("No listings scraped — check search config or board availability")
        return result

    # Stage 2: Dedupe
    logger.info("=== Stage 2: Deduping companies ===")
    companies = collapse_to_companies(listings)
    result.companies_found = len(companies)

    # Resolve domains before CRM skip check
    companies = resolve_domains(companies)

    crm = CRMClient()
    existing_domains: set[str] = set()
    if crm.is_configured and not skip_crm:
        domains_to_check = [c.domain for c in companies if c.domain]
        existing_domains = crm.get_existing_domains(domains_to_check)

    companies, skipped = filter_existing_companies(companies, existing_domains)
    result.companies_skipped_existing = skipped
    logger.info("Net-new companies after CRM skip: %d (skipped %d)", len(companies), skipped)

    if limit is not None:
        companies = companies[:limit]
        logger.info("Limited to %d companies for this run", len(companies))

    if dry_run:
        logger.info("Dry run — stopping before enrichment")
        result.rows = _rows_from_enriched([
            EnrichedCompany(company=c) for c in companies
        ])
        csv_path = _write_csv(result.rows, run_date)
        logger.info("Dry-run CSV written to %s", csv_path)
        return result

    # Stage 3: Enrich
    client = get_contactout_client()
    use_contactout = client.is_configured
    effective_provider = provider_name
    if use_waterfall or use_contactout:
        effective_provider = "apollo+contactout (waterfall)"
    logger.info("=== Stage 3: Enriching contacts via %s ===", effective_provider)
    if use_waterfall or use_contactout:
        provider = WaterfallProvider()
    else:
        provider = get_provider(provider_name)

    enriched: list[EnrichedCompany] = []
    for company in companies:
        if not company.domain:
            result.errors.append(f"No domain resolved for {company.name}")
            enriched.append(EnrichedCompany(company=company))
            continue

        credits_before = provider.credits_used
        if provider.credits_used >= daily_credit_cap:
            logger.warning("Daily credit cap (%d) reached — stopping enrichment", daily_credit_cap)
            result.errors.append(f"Credit cap reached at {daily_credit_cap}")
            break

        item = provider.enrich_company(
            company,
            target_titles,
            target_seniorities,
            contacts_per_company,
            enrich_phone,
        )
        credits_delta = provider.credits_used - credits_before
        item.credits_used = credits_delta
        enriched.append(item)

        if item.contacts:
            result.companies_enriched += 1
            result.contacts_enriched += len([c for c in item.contacts if c.enriched])

    result.credits_used = provider.credits_used
    result.rows = _rows_from_enriched(enriched)

    # Stage 4: Output
    logger.info("=== Stage 4: Writing output ===")
    csv_path = _write_csv(result.rows, run_date)
    logger.info("CSV written to %s (%d rows)", csv_path, len(result.rows))

    if crm.is_configured and not skip_crm:
        payload = _build_ingest_payload(enriched, result)
        if not crm.ingest_batch(payload):
            result.errors.append("CRM ingest failed")
        else:
            post_pipeline_status("mark_run_complete")

    notify = get_notification_email(config) or os.environ.get("ALERT_EMAIL")
    geo_label = (config.get("settings") or {}).get("geo_label", "Unknown")
    if notify and not dry_run and not skip_email:
        send_daily_report_for_pipeline(
            to_email=notify,
            pipeline_rows=result.rows,
            result_summary={
                "run_date": str(run_date),
                "listings_scraped": result.listings_scraped,
                "companies_enriched": result.companies_enriched,
                "credits_used": result.credits_used,
            },
            geo_label=geo_label,
        )

    logger.info(
        "Pipeline complete — listings=%d companies=%d enriched=%d contacts=%d credits=%d errors=%d",
        result.listings_scraped,
        result.companies_found,
        result.companies_enriched,
        result.contacts_enriched,
        result.credits_used,
        len(result.errors),
    )
    return result
