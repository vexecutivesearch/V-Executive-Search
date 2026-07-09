from __future__ import annotations

from src.enrich.apollo import ApolloProvider
from src.enrich.provider import EnrichmentProvider

__all__ = ["EnrichmentProvider", "ApolloProvider", "get_provider"]


def get_provider(name: str) -> EnrichmentProvider:
    providers: dict[str, type[EnrichmentProvider]] = {
        "apollo": ApolloProvider,
    }
    cls = providers.get(name.lower())
    if not cls:
        raise ValueError(f"Unknown enrichment provider: {name}")
    return cls()
