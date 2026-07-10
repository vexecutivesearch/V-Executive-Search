"""Fixture tests: parser must extract every publicly-present poster."""
from __future__ import annotations

import unittest
from pathlib import Path

from src.funnel import html_poster_signals
from src.linkedin_posters import parse_hiring_team_from_html

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "linkedin_html"


class LinkedInPosterFixtureTests(unittest.TestCase):
    def test_with_poster_fixtures_all_parse(self):
        if not FIXTURES.exists():
            self.skipTest("Run scripts/collect_linkedin_fixtures.py first")
        for path in sorted((FIXTURES / "with_poster").glob("*.html")):
            html = path.read_text(encoding="utf-8")
            pub, meet = html_poster_signals(html)
            posters = parse_hiring_team_from_html(html)
            with self.subTest(job_id=path.stem):
                self.assertTrue(pub, f"{path.name} expected public poster block")
                self.assertGreaterEqual(
                    len(posters),
                    1,
                    f"parser missed poster in {path.name}",
                )

    def test_without_poster_fixtures_do_not_false_positive(self):
        if not FIXTURES.exists():
            self.skipTest("Run scripts/collect_linkedin_fixtures.py first")
        for path in sorted((FIXTURES / "without_poster").glob("*.html")):
            html = path.read_text(encoding="utf-8")
            pub, meet = html_poster_signals(html)
            posters = parse_hiring_team_from_html(html)
            with self.subTest(job_id=path.stem):
                self.assertFalse(meet, f"{path.name} should not have meet-the-team in guest HTML")
                if not pub:
                    self.assertEqual(
                        len(posters),
                        0,
                        f"parser false-positive on {path.name}",
                    )


if __name__ == "__main__":
    unittest.main()
