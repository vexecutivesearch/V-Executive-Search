from __future__ import annotations

import csv
import logging
import os
from datetime import date, datetime
from pathlib import Path
from typing import Any

from src.config_loader import load_config, get_notification_email
from src.coarse_sector import apply_coarse_sectors
from src.crm_config import post_pipeline_status
from src.crm_client import CRMClient
from src.dedupe import collapse_to_companies, normalize_company_name
from src.domain_resolver import _guess_domain, _search_org
from src.enrich import get_provider
from src.enrich.contactout import get_contactout_client
from src.enrich.waterfall import WaterfallProvider
from src.models import CompanyRecord, DomainConfidence, EnrichedCompany, JobListing, PipelineResult
from src.paid_egress import PaidEgressBlocked
from src.scrape import scrape_all
from src.timezone import business_list_date, business_run_slot
from src.contact_phones import contact_phones_for_display
from src.caffeinate_guard import prevent_sleep
from src.email_report import send_daily_report_for_pipeline
from src.phone_utils import is_personal_email

logger = logging.getLogger(__name__)

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


def _parse_pending_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _company_from_queue(item: dict[str, Any]) -> CompanyRecord:
    name = str(item.get("name") or "").strip()
    listings = [
        JobListing(
            company_name=name,
            job_title=str(jl.get("title") or "").strip(),
            location=str(jl.get("location") or "").strip(),
            board=str(jl.get("board") or "").strip(),
            job_url=str(jl.get("url") or "").strip(),
            date_posted=_parse_pending_date(jl.get("posted_at")),
            search_name=str(jl.get("search_name") or "").strip(),
        )
        for jl in item.get("job_listings") or []
    ]
    confidence = (
        DomainConfidence.HIGH
        if item.get("domain_confidence") == "high"
        else DomainConfidence.LOW
    )
    normalized = normalize_company_name(name)
    return CompanyRecord(
        name=name,
        normalized_name=normalized,
        domain=item.get("domain"),
        domain_confidence=confidence,
        listings=listings,
        crm_id=item.get("id"),
        lead_score=int(item.get("lead_score") or 0),
    )


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
                "job_location": primary_listing.location if primary_listing else "",
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
                "job_location": primary_listing.location if primary_listing else "",
                "job_url": primary_listing.job_url if primary_listing else "",
                "board": primary_listing.board if primary_listing else "",
                "search_name": primary_listing.search_name if primary_listing else "",
            })
    return rows


def _write_csv(
    rows: list[dict[str, Any]],
    run_date: date,
    run_slot: str = "am",
) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"daily_{run_date.isoformat()}_{run_slot}.csv"
    if not rows:
        path.write_text("", encoding="utf-8")
        return path

    fieldnames: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                fieldnames.append(key)

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return path


def _primary_poster(listing: JobListing):
    if not listing.posters:
        return None
    for poster in listing.posters:
        if poster.is_job_poster:
            return poster
    return listing.posters[0]


def _job_listing_payload(jl: JobListing) -> dict[str, Any]:
    poster = _primary_poster(jl)
    payload = {
        "title": jl.job_title,
        "board": jl.board,
        "url": jl.job_url,
        "location": jl.location,
        "search_name": jl.search_name,
        "posted_at": jl.date_posted.isoformat() if jl.date_posted else None,
        "salary_min": jl.salary_min,
        "salary_max": jl.salary_max,
        "salary_currency": jl.salary_currency,
        "salary_text": jl.salary_text,
    }
    if poster:
        payload["poster_name"] = poster.name
        payload["poster_title"] = poster.title or None
        payload["poster_linkedin_url"] = poster.linkedin_url
    return payload


def _seed_contacts_payload(company: CompanyRecord) -> list[dict[str, Any]]:
    return [
        {
            "name": c.name,
            "title": c.title,
            "linkedin_url": c.linkedin_url,
            "source_provider": c.source_provider,
            "location_matched": c.location_matched,
            "contact_location": c.contact_location,
            "job_location": c.job_location,
        }
        for c in company.seed_contacts
        if c.linkedin_url
    ]


def _build_jobs_only_payload(
    companies: list[CompanyRecord],
    result: PipelineResult,
    *,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    companies_payload = []
    for company in companies:
        payload: dict[str, Any] = {
            "name": company.name,
            "domain": company.domain,
            "domain_confidence": company.domain_confidence.value,
            "estimated_employees": company.estimated_employees,
            "industry": company.industry,
            "job_listings": [_job_listing_payload(jl) for jl in company.listings],
            "contacts": _seed_contacts_payload(company),
        }
        if company.crm_id:
            payload["id"] = company.crm_id
        companies_payload.append(payload)

    settings = (config or {}).get("settings") or {}
    market_label = (
        settings.get("market_label")
        or settings.get("geo_label")
        or None
    )

    return {
        "run_date": result.run_date.isoformat(),
        "run_slot": result.run_slot,
        "import_mode": "jobs_only",
        "metadata": {
            "listings_scraped": result.listings_scraped,
            "companies_found": result.companies_found,
            "companies_skipped_existing": result.companies_skipped_existing,
            "icp_match_count": result.icp_match_count,
            "companies_scored": result.companies_scored,
            "errors": result.errors,
            "market_label": market_label,
            "funnel": (
                result.scrape_funnel.to_metadata()
                if result.scrape_funnel is not None
                else None
            ),
        },
        "companies": companies_payload,
    }


def _build_enrich_payload(
    enriched: list[EnrichedCompany],
    result: PipelineResult,
) -> dict[str, Any]:
    companies_payload = []
    for item in enriched:
        company = item.company
        payload: dict[str, Any] = {
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
            "job_listings": [_job_listing_payload(jl) for jl in company.listings],
        }
        if company.crm_id:
            payload["id"] = company.crm_id
        payload["enrich_run_date"] = result.run_date.isoformat()
        companies_payload.append(payload)

    return {
        "run_date": result.run_date.isoformat(),
        "run_slot": result.run_slot,
        "import_mode": "enrich_only",
        "metadata": {
            "companies_enriched": result.companies_enriched,
            "contacts_enriched": result.contacts_enriched,
            "credits_used": result.credits_used,
            "enrichment_quota": result.enrichment_quota,
            "companies_deferred": result.companies_deferred,
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
    include_existing: bool = False,
    scrape_only: bool = False,
    enrich_only: bool = False,
    run_date_override: date | None = None,
    run_slot_override: str | None = None,
) -> PipelineResult:
    with prevent_sleep():
        return _run_pipeline_impl(
            dry_run=dry_run,
            skip_crm=skip_crm,
            skip_email=skip_email,
            use_waterfall=use_waterfall,
            config_path=config_path,
            limit=limit,
            include_existing=include_existing,
            scrape_only=scrape_only,
            enrich_only=enrich_only,
            run_date_override=run_date_override,
            run_slot_override=run_slot_override,
        )


def _run_pipeline_impl(
    *,
    dry_run: bool = False,
    skip_crm: bool = False,
    skip_email: bool = False,
    use_waterfall: bool = False,
    config_path: Path | None = None,
    limit: int | None = None,
    include_existing: bool = False,
    scrape_only: bool = False,
    enrich_only: bool = False,
    run_date_override: date | None = None,
    run_slot_override: str | None = None,
) -> PipelineResult:
    run_date = run_date_override or business_list_date()
    run_slot = run_slot_override or business_run_slot()
    config = load_config(config_path)
    enrichment_cfg = config.get("enrichment", {})

    target_titles = enrichment_cfg.get("target_titles") or config.get("target_titles", [])
    target_seniorities = enrichment_cfg.get("target_seniorities") or config.get(
        "target_seniorities", []
    )
    contacts_per_company = enrichment_cfg.get("contacts_per_company", 3)
    daily_credit_cap = enrichment_cfg.get("daily_credit_cap", 100)
    daily_enrich_quota = enrichment_cfg.get("daily_enrich_quota", 25)
    min_score_for_phone = enrichment_cfg.get("min_score_for_phone", 75)
    provider_name = enrichment_cfg.get("provider", "apollo")

    result = PipelineResult(
        run_date=run_date,
        run_slot=run_slot,
        listings_scraped=0,
        companies_found=0,
        companies_skipped_existing=0,
        companies_enriched=0,
        contacts_enriched=0,
        credits_used=0,
        enrichment_quota=daily_enrich_quota,
    )

    crm = CRMClient()

    if enrich_only:
        return _enrich_call_sheet(
            result=result,
            crm=crm,
            config=config,
            enrichment_cfg=enrichment_cfg,
            dry_run=dry_run,
            skip_crm=skip_crm,
            skip_email=skip_email,
            use_waterfall=use_waterfall,
            provider_name=provider_name,
            contacts_per_company=contacts_per_company,
            daily_credit_cap=daily_credit_cap,
            daily_enrich_quota=daily_enrich_quota,
            min_score_for_phone=min_score_for_phone,
            limit=limit,
        )

    # Stage 1: Scrape (free)
    logger.info("=== Stage 1: Scraping job listings ===")
    listings, scrape_funnel = scrape_all(config, run_slot=run_slot)
    result.listings_scraped = len(listings)
    result.scrape_funnel = scrape_funnel

    # Stage 2: Build batch and assign free coarse sectors.
    logger.info("=== Stage 2: Building company batch (jobs-only ingest) ===")
    companies = collapse_to_companies(listings)
    result.companies_found = len(companies)

    if not companies:
        result.errors.append("No companies from scrape")
        return result

    companies = apply_coarse_sectors(companies)

    if limit is not None:
        companies = companies[:limit]

    if dry_run:
        logger.info("Dry run — stopping before CRM ingest")
        result.rows = _rows_from_enriched([
            EnrichedCompany(company=c) for c in companies
        ])
        return result

    ingest_ok = False
    if crm.is_configured and not skip_crm:
        payload = _build_jobs_only_payload(companies, result, config=config)
        ingest_ok = crm.ingest_batch(payload)
        if not ingest_ok:
            result.errors.append("CRM jobs-only ingest failed")
        else:
            rescore = crm.rescore_backlog()
            result.companies_scored = int(rescore.get("scored") or 0)
            result.icp_match_count = int(rescore.get("icpMatch") or 0)

    # Poster crawl is optional enrichment AFTER listings are safely in CRM.
    # Previously this ran inside scrape_all and blocked ingest for hours.
    linkedin_listings = sum(1 for listing in listings if listing.board == "linkedin")
    if linkedin_listings and ingest_ok:
        from src.linkedin_posters import attach_linkedin_hiring_teams

        logger.info(
            "=== Stage 2b: LinkedIn hiring-team posters (post-ingest) ==="
        )
        posters_found = attach_linkedin_hiring_teams(
            listings, funnel=result.scrape_funnel
        )
        logger.info("LinkedIn hiring-team posters captured: %d", posters_found)
        if result.scrape_funnel is not None:
            logger.info(
                "Poster funnel: fetched=%d public_block=%d meet_team_html=%d parsed_listings=%d",
                result.scrape_funnel.poster_pages_fetched,
                result.scrape_funnel.poster_public_block_in_html,
                result.scrape_funnel.meet_team_in_html,
                result.scrape_funnel.poster_parsed,
            )
        if posters_found and crm.is_configured and not skip_crm:
            companies_with_posters = apply_coarse_sectors(
                collapse_to_companies(listings)
            )
            if limit is not None:
                companies_with_posters = companies_with_posters[:limit]
            poster_payload = _build_jobs_only_payload(
                companies_with_posters, result, config=config
            )
            # Avoid double-counting listings on additive daily_runs counters.
            meta = poster_payload.setdefault("metadata", {})
            meta["listings_scraped"] = 0
            meta["errors"] = []
            meta.pop("funnel", None)
            if not crm.ingest_batch(poster_payload):
                result.errors.append("CRM poster ingest failed")
            else:
                logger.info("Poster seed contacts ingested to CRM")

    if scrape_only:
        logger.info(
            "Scrape-only complete — %d listings, %d companies%s",
            result.listings_scraped,
            result.companies_found,
            " ingested" if ingest_ok else " (CRM ingest failed)",
        )
        return result

    if os.environ.get("ENABLE_SCHEDULED_ENRICH") != "true":
        logger.info("Scheduled enrichment skipped — paid egress requires explicit approval")
        return result

    return _enrich_call_sheet(
        result=result,
        crm=crm,
        config=config,
        enrichment_cfg=enrichment_cfg,
        dry_run=False,
        skip_crm=skip_crm,
        skip_email=skip_email,
        use_waterfall=use_waterfall,
        provider_name=provider_name,
        contacts_per_company=contacts_per_company,
        daily_credit_cap=daily_credit_cap,
        daily_enrich_quota=daily_enrich_quota,
        min_score_for_phone=min_score_for_phone,
        limit=limit,
    )


def _enrich_call_sheet(
    *,
    result: PipelineResult,
    crm: CRMClient,
    config: dict[str, Any],
    enrichment_cfg: dict[str, Any],
    dry_run: bool,
    skip_crm: bool,
    skip_email: bool,
    use_waterfall: bool,
    provider_name: str,
    contacts_per_company: int,
    daily_credit_cap: int,
    daily_enrich_quota: int,
    min_score_for_phone: int,
    limit: int | None,
) -> PipelineResult:
    target_titles = enrichment_cfg.get("target_titles") or config.get("target_titles", [])
    target_seniorities = enrichment_cfg.get("target_seniorities") or config.get(
        "target_seniorities", []
    )

    queue_limit = limit if limit is not None else daily_enrich_quota

    if crm.is_configured and not skip_crm:
        if not crm.check_pipeline_ready():
            result.errors.append("CRM v2 pipeline not ready — deploy CRM first")
            return result
        if os.environ.get("ENABLE_SCHEDULED_DOMAIN_BACKFILL") == "true":
            backfill = crm.backfill_domains(limit=queue_limit * 3)
            if backfill.get("updated"):
                logger.info("Domain backfill updated %s companies", backfill.get("updated"))
        else:
            logger.info("Domain backfill skipped — paid egress disabled for scheduled pipeline")

    queue_items = crm.get_enrichment_queue(limit=queue_limit) if crm.is_configured else []
    companies = [_company_from_queue(item) for item in queue_items]
    deferred = max(0, len(queue_items) - len(companies)) if queue_items else 0
    result.companies_deferred = deferred

    if not companies:
        result.errors.append("Enrichment queue empty — no ranked backlog leads")
        return result

    logger.info("=== Stage 3: Enriching top %d call-sheet companies ===", len(companies))

    client = get_contactout_client()
    use_contactout = client.is_configured
    effective_provider = provider_name
    if use_waterfall or use_contactout:
        effective_provider = "apollo+contactout (API)"
    logger.info("Provider: %s", effective_provider)
    if use_waterfall or use_contactout:
        provider = WaterfallProvider()
    else:
        provider = get_provider(provider_name)

    enriched: list[EnrichedCompany] = []
    org_search_credits = 0
    for company in companies:
        if not company.domain:
            guessed = _guess_domain(company.name)
            if guessed:
                company.domain = guessed
                company.domain_confidence = DomainConfidence.LOW
            elif os.environ.get("ENABLE_SCHEDULED_DOMAIN_BACKFILL") != "true":
                result.errors.append(f"No domain for {company.name}")
                enriched.append(EnrichedCompany(company=company))
                continue
        if company.domain_confidence == DomainConfidence.LOW and os.environ.get("ENABLE_SCHEDULED_DOMAIN_BACKFILL") == "true":
            try:
                lookup = _search_org(company.name, context="scheduled_pipeline")
            except PaidEgressBlocked as exc:
                result.errors.append(str(exc))
                enriched.append(EnrichedCompany(company=company))
                continue
            org_search_credits += 1
            if lookup.domain:
                company.domain = lookup.domain
                company.domain_confidence = lookup.confidence

        if provider.credits_used + org_search_credits >= daily_credit_cap:
            result.errors.append(f"Credit cap reached at {daily_credit_cap}")
            result.companies_deferred += 1
            break

        enrich_phone = bool(enrichment_cfg.get("enrich_phone", True)) and (
            company.lead_score >= min_score_for_phone
        )
        logger.info(
            "Enrich %s — score=%d phone_reveal=%s (threshold=%d)",
            company.name,
            company.lead_score,
            enrich_phone,
            min_score_for_phone,
        )
        credits_before = provider.credits_used
        item = provider.enrich_company(
            company,
            target_titles,
            target_seniorities,
            contacts_per_company,
            enrich_phone,
        )
        item.credits_used = provider.credits_used - credits_before
        enriched.append(item)

        if item.contacts:
            result.companies_enriched += 1
            result.contacts_enriched += len([c for c in item.contacts if c.enriched])

    result.credits_used = provider.credits_used + org_search_credits
    result.rows = _rows_from_enriched(enriched)

    csv_path = _write_csv(result.rows, result.run_date, result.run_slot)
    logger.info("CSV written to %s (%d rows)", csv_path, len(result.rows))

    if crm.is_configured and not skip_crm:
        payload = _build_enrich_payload(enriched, result)
        if not crm.ingest_batch(payload):
            result.errors.append("CRM enrich ingest failed")
        else:
            post_pipeline_status("mark_run_complete")
            enriched_ids = [
                item.company.crm_id
                for item in enriched
                if item.company.crm_id and item.contacts
            ]
            if enriched_ids:
                opener_result = crm.generate_openers(enriched_ids)
                logger.info(
                    "Openers generated=%s skipped=%s",
                    opener_result.get("generated"),
                    opener_result.get("skipped"),
                )

    if (
        (use_waterfall or use_contactout)
        and isinstance(provider, WaterfallProvider)
        and getattr(provider, "_contactout_api_locked", False)
    ):
        from src.credit_alert import send_credit_alert

        notify = get_notification_email(config) or os.environ.get("ALERT_EMAIL")
        if notify:
            send_credit_alert(
                to_email=notify,
                subject="ContactOut credits low",
                message=(
                    "ContactOut phone API credits appear exhausted during enrich run. "
                    "Apollo emails/phones still used — check your ContactOut plan."
                ),
            )

    notify = get_notification_email(config) or os.environ.get("ALERT_EMAIL")
    geo_label = (config.get("settings") or {}).get("geo_label", "Unknown")
    if notify and not dry_run and not skip_email:
        send_daily_report_for_pipeline(
            to_email=notify,
            pipeline_rows=result.rows,
            result_summary={
                "run_date": str(result.run_date),
                "run_slot": result.run_slot,
                "listings_scraped": result.listings_scraped,
                "icp_match_count": result.icp_match_count,
                "companies_enriched": result.companies_enriched,
                "credits_used": result.credits_used,
            },
            geo_label=geo_label,
        )

    logger.info(
        "Enrich complete — enriched=%d contacts=%d credits=%d deferred=%d",
        result.companies_enriched,
        result.contacts_enriched,
        result.credits_used,
        result.companies_deferred,
    )
    return result
