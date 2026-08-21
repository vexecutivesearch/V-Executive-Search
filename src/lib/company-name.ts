/**
 * Company-name normalisation shared by every dedupe path (job-scrape ingest
 * and company-first discovery). Both must agree, or a company found by
 * discovery would be inserted a second time next to its scraped row.
 */
export function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(
      /\b(inc|incorporated|llc|l l c|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How much identity a normalised key still carries.
 *
 * The suffix stripper is aggressive on purpose — it has to make "Vega Law LLC"
 * and "Vega Law, PLLC" agree — but it also collapses "Ray Thomas Group" and
 * "Ray Thomas Co" onto the bare "ray thomas". A key that lost tokens and is
 * down to one word is too generic to merge two companies on: "Smith Group",
 * "Smith Holdings" and "Smith & Co" all reduce to "smith". A name that was
 * already a single word (e.g. "Salesforce") lost nothing and stays strong.
 */
export function companyNameKeyStrength(name: string): "strong" | "weak" | "empty" {
  const key = normalizeCompanyKey(name);
  if (!key) return "empty";
  if (key.includes(" ")) return "strong";
  const rawTokens = name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return rawTokens.length > 1 ? "weak" : "strong";
}
