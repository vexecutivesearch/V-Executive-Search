from src.crm_client import _chunk_companies


def test_chunk_companies_by_count():
    companies = [{"name": f"Co{i}", "job_listings": []} for i in range(25)]
    chunks = _chunk_companies(companies, max_companies=10, max_bytes=10_000_000)
    assert [len(c) for c in chunks] == [10, 10, 5]
    assert sum(len(c) for c in chunks) == 25


def test_chunk_companies_by_bytes():
    # Each company ~100+ bytes; force byte-based splits.
    companies = [
        {"name": f"Company-{i}", "job_listings": [{"title": "x" * 50}]}
        for i in range(8)
    ]
    chunks = _chunk_companies(companies, max_companies=100, max_bytes=400)
    assert len(chunks) > 1
    assert sum(len(c) for c in chunks) == 8
    assert all(len(c) >= 1 for c in chunks)
