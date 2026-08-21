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
