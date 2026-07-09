from __future__ import annotations

from typing import Any


def is_contactout_sample_response(data: dict[str, Any]) -> bool:
    """ContactOut returns placeholder data when phone API credits are unavailable."""
    message = str(data.get("message", "")).lower()
    if "sample response" in message:
        return True

    profile = data.get("profile")
    if not isinstance(profile, dict):
        return False

    url = str(profile.get("url", "")).lower()
    if "example-person" in url:
        return True

    for key in ("email", "personal_email", "work_email"):
        values = profile.get(key)
        if not isinstance(values, list):
            continue
        for entry in values:
            if "example.com" in str(entry).lower():
                return True

    for key in ("phone", "phones"):
        values = profile.get(key)
        if not isinstance(values, list):
            continue
        for entry in values:
            text = str(entry).lower()
            if "phone number 1" in text or "+1234567891" in text:
                return True

    return False
