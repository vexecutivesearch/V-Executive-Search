from __future__ import annotations

from src.models import CompanyRecord

INDUSTRY_SECTORS = {
    "Healthcare & Life Sciences",
    "Financial Services",
    "Technology & Telecom",
    "Manufacturing & Industrial",
    "Construction & Real Estate",
    "Retail & Consumer Goods",
    "Professional & Business Services",
    "Education",
    "Transportation & Logistics",
    "Hospitality, Travel & Media",
    "Energy & Utilities",
    "Government & Nonprofit",
}

SECTOR_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    (
        "Healthcare & Life Sciences",
        ("health", "medical", "clinic", "hospital", "nurse", "dental", "pharma"),
    ),
    (
        "Financial Services",
        ("bank", "finance", "financial", "accounting", "accountant", "cpa", "tax"),
    ),
    (
        "Technology & Telecom",
        ("software", "technology", "telecom", "it ", "developer", "engineer"),
    ),
    (
        "Manufacturing & Industrial",
        ("manufacturing", "industrial", "factory", "machinery", "aerospace"),
    ),
    (
        "Construction & Real Estate",
        ("construction", "contractor", "real estate", "property", "superintendent"),
    ),
    (
        "Retail & Consumer Goods",
        ("retail", "restaurant", "store", "customer service", "food", "beverage"),
    ),
    (
        "Professional & Business Services",
        ("legal", "law", "paralegal", "attorney", "marketing", "human resources", "hr "),
    ),
    (
        "Education",
        ("school", "teacher", "education", "university", "college"),
    ),
    (
        "Transportation & Logistics",
        ("logistics", "warehouse", "driver", "transportation", "shipping"),
    ),
    (
        "Hospitality, Travel & Media",
        ("hotel", "hospitality", "travel", "media", "event", "entertainment"),
    ),
    (
        "Energy & Utilities",
        ("energy", "utility", "utilities", "solar", "environmental"),
    ),
    (
        "Government & Nonprofit",
        ("government", "nonprofit", "non-profit", "public", "municipal"),
    ),
]


def derive_coarse_sector(company: CompanyRecord) -> str | None:
    haystack = " ".join(
        [
            company.name,
            *(listing.job_title for listing in company.listings),
            *(listing.search_name for listing in company.listings),
        ]
    ).lower()
    normalized = f" {haystack} "
    for sector, keywords in SECTOR_KEYWORDS:
        if any(keyword in normalized for keyword in keywords):
            return sector
    return None


def apply_coarse_sectors(companies: list[CompanyRecord]) -> list[CompanyRecord]:
    for company in companies:
        if not company.industry:
            company.industry = derive_coarse_sector(company)
    return companies
