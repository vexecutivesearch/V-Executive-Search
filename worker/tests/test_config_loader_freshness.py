from __future__ import annotations

import unittest
from unittest.mock import patch


class ConfigLoaderFreshnessTest(unittest.TestCase):
    def test_load_config_fetches_crm_config_every_call(self) -> None:
        from src import config_loader

        calls = 0

        def fetch() -> dict[str, object]:
            nonlocal calls
            calls += 1
            return {
                "searches": [{"name": f"run-{calls}", "location": "Atlanta, GA"}],
                "settings": {"geo_label": f"fresh-{calls}"},
            }

        with patch.object(config_loader, "fetch_pipeline_config", side_effect=fetch):
            first = config_loader.load_config()
            second = config_loader.load_config()

        self.assertEqual(calls, 2)
        self.assertEqual(first["settings"]["geo_label"], "fresh-1")
        self.assertEqual(second["settings"]["geo_label"], "fresh-2")


if __name__ == "__main__":
    unittest.main()
