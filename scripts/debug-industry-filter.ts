/**
 * Debug/verify sector filter: selecting Financial Services must not include
 * unknown-industry or hospitality/retail rows.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { getBacklogForDateRange } = await import("../src/lib/queries");
  const { resolveListDateRange } = await import("../src/lib/list-date-range");
  const {
    companyMatchesLeadFilters,
    DEFAULT_LEAD_FILTER,
  } = await import("../src/lib/lead-filters");
  const { sectorFromIndustry } = await import("../src/lib/industry-sectors");

  const range = resolveListDateRange({});
  const companies = await getBacklogForDateRange(range);

  const leaky = {
    ...DEFAULT_LEAD_FILTER,
    industry: "Financial Services",
    includeUnknownIndustry: true,
  };
  const strict = {
    ...DEFAULT_LEAD_FILTER,
    industry: "Financial Services",
    includeUnknownIndustry: false,
  };

  const leakyMatched = companies.filter((c) =>
    companyMatchesLeadFilters(c, leaky),
  );
  const strictMatched = companies.filter((c) =>
    companyMatchesLeadFilters(c, strict),
  );

  function breakdown(
    rows: typeof companies,
  ): Record<string, number> {
    const map: Record<string, number> = {};
    for (const c of rows) {
      const key = !c.industry?.trim()
        ? "NO_INDUSTRY"
        : (sectorFromIndustry(c.industry) ?? "unmapped");
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }

  const crumbelStrict = strictMatched.find((c) =>
    c.name.toLowerCase().includes("crumbl"),
  );
  const nonFinancialStrict = strictMatched.filter((c) => {
    const s = sectorFromIndustry(c.industry);
    return s !== "Financial Services";
  });

  console.log(
    JSON.stringify(
      {
        backlog: companies.length,
        leakyMatched: leakyMatched.length,
        leakyBreakdown: breakdown(leakyMatched),
        strictMatched: strictMatched.length,
        strictBreakdown: breakdown(strictMatched),
        crumblInStrict: crumbelStrict?.name ?? null,
        nonFinancialInStrict: nonFinancialStrict.map((c) => ({
          name: c.name,
          industry: c.industry,
          sector: sectorFromIndustry(c.industry),
        })),
        sampleStrict: strictMatched.slice(0, 8).map((c) => ({
          name: c.name,
          industry: c.industry,
          sector: sectorFromIndustry(c.industry),
        })),
      },
      null,
      2,
    ),
  );

  if (nonFinancialStrict.length > 0) {
    console.error("FAIL: strict Financial Services filter leaked other sectors");
    process.exit(1);
  }
  if (crumbelStrict) {
    console.error("FAIL: Crumbl still appears under Financial Services");
    process.exit(1);
  }
  console.error("PASS: strict Financial Services filter is sector-accurate");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
