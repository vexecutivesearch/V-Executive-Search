from __future__ import annotations

from typing import Protocol

from src.models import CompanyRecord, ContactRecord, EnrichedCompany


class EnrichmentProvider(Protocol):
    def enrich_company(
        self,
        company: CompanyRecord,
        target_titles: list[str],
        target_seniorities: list[str],
        contacts_per_company: int,
        enrich_phone: bool,
    ) -> EnrichedCompany: ...

    @property
    def credits_used(self) -> int: ...

    def reset_credits(self) -> None: ...
