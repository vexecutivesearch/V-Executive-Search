/** ContactOut returns placeholder data when phone API credits are unavailable. */
export function isContactOutSampleResponse(data: Record<string, unknown>): boolean {
  const message = String(data.message ?? "").toLowerCase();
  if (message.includes("sample response")) return true;

  const profile = (data.profile ?? data.data ?? data) as Record<string, unknown>;
  if (!profile || typeof profile !== "object") return false;

  const url = String(profile.url ?? "").toLowerCase();
  if (url.includes("example-person")) return true;

  for (const key of ["email", "personal_email", "work_email"]) {
    const values = profile[key];
    if (!Array.isArray(values)) continue;
    for (const entry of values) {
      if (String(entry).toLowerCase().includes("example.com")) return true;
    }
  }

  for (const key of ["phone", "phones"]) {
    const values = profile[key];
    if (!Array.isArray(values)) continue;
    for (const entry of values) {
      const text = String(entry).toLowerCase();
      if (text.includes("phone number 1") || text.includes("+1234567891")) {
        return true;
      }
    }
  }

  return false;
}
