"""Funnel per-search invariant checks."""

from src.funnel import check_linkedin_per_search_invariants


def test_union_gte_max_draw():
    assert not check_linkedin_per_search_invariants(
        {
            "search": "HR Director — WPB",
            "linkedin_draws": [7, 6, 7],
            "linkedin_union": 8,
        },
    )


def test_union_lt_max_draw_violation():
    violations = check_linkedin_per_search_invariants(
        {
            "search": "HR Director — WPB",
            "linkedin_draws": [20, 18, 15],
            "linkedin_union": 7,
        },
    )
    assert violations == ["HR Director: union 7 < max(draw) 20"]


def test_in_focus_lte_union():
    assert not check_linkedin_per_search_invariants(
        {
            "search": "Head of Talent — WPB",
            "linkedin_draws": [18, 20, 22],
            "linkedin_union": 25,
            "linkedin_in_focus": 24,
        },
    )


def test_in_focus_gt_union_violation():
    violations = check_linkedin_per_search_invariants(
        {
            "search": "Head of Talent — WPB",
            "linkedin_draws": [10, 10, 10],
            "linkedin_union": 12,
            "linkedin_in_focus": 15,
        },
    )
    assert violations == ["Head of Talent: in-focus 15 > union 12"]
