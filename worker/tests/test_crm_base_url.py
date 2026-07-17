from __future__ import annotations

import os
import unittest
from unittest import mock

from src.crm_config import FORBIDDEN_CRM_HOSTS, crm_base_url


class CrmBaseUrlTests(unittest.TestCase):
    def test_requires_crm_api_url(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                crm_base_url(required=True)

    def test_rejects_legacy_host(self) -> None:
        self.assertIn("v-executive-search.vercel.app", FORBIDDEN_CRM_HOSTS)
        with mock.patch.dict(
            os.environ,
            {"CRM_API_URL": "https://v-executive-search.vercel.app"},
            clear=False,
        ):
            with self.assertRaises(RuntimeError) as ctx:
                crm_base_url(required=True)
            self.assertIn("forbidden legacy host", str(ctx.exception))

    def test_accepts_delta_host(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"CRM_API_URL": "https://v-executive-search-delta.vercel.app/"},
            clear=False,
        ):
            self.assertEqual(
                crm_base_url(required=True),
                "https://v-executive-search-delta.vercel.app",
            )


if __name__ == "__main__":
    unittest.main()
