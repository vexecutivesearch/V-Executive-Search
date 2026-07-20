"""Unit tests for Outreach IMAP XOAUTH2 helpers (no network)."""

from __future__ import annotations

from src.outreach_imap_oauth import xoauth2_sasl


def test_xoauth2_sasl_format() -> None:
    raw = xoauth2_sasl("odv@example.com", "tok_abc")
    assert raw == b"user=odv@example.com\x01auth=Bearer tok_abc\x01\x01"
