"""Detect ContactOut API placeholder/sample responses (no real credits)."""


def is_contactout_sample_response(data: dict) -> bool:
    if not isinstance(data, dict):
        return False
    profile = data.get("profile") or data.get("data") or data
    if not isinstance(profile, dict):
        return False
    email = str(profile.get("email") or profile.get("personal_email") or "").lower()
    if "email@domain.com" in email or "example.com" in email:
        return True
    phone = str(profile.get("phone") or "")
    if "phone number 1" in phone.lower() or "000-000" in phone:
        return True
    return False
