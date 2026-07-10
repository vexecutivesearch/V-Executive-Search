import { config } from "dotenv";

config({ path: ".env.local" });

import { getBacklogCompanies } from "../src/lib/queries";
import { listingHasSalary, listingSalaryMax } from "../src/lib/lead-filters";

async function main() {
  const backlog = await getBacklogCompanies();
  let industryFilled = 0;
  let anySalary = 0;
  let numericSalary = 0;
  let titleFilled = 0;

  for (const c of backlog) {
    if (c.industry?.trim()) industryFilled++;
    if (c.jobListings.some((l) => listingHasSalary(l))) anySalary++;
    if (c.jobListings.some((l) => listingSalaryMax(l) != null)) numericSalary++;
    if (c.jobListings.some((l) => l.searchName?.trim())) titleFilled++;
  }

  const n = backlog.length;
  const pct = (x: number) => (n ? ((100 * x) / n).toFixed(1) : "0.0");

  console.log(
    JSON.stringify(
      {
        backlog_total: n,
        industry_filled: industryFilled,
        industry_pct: pct(industryFilled),
        salary_any_filled: anySalary,
        salary_any_pct: pct(anySalary),
        salary_numeric_filled: numericSalary,
        salary_numeric_pct: pct(numericSalary),
        job_title_filled: titleFilled,
        job_title_pct: pct(titleFilled),
      },
      null,
      2,
    ),
  );

  const industries = [
    ...new Set(backlog.map((c) => c.industry?.trim()).filter(Boolean)),
  ].sort();
  console.log(
    `\nDistinct industries (${industries.length}):`,
    industries.slice(0, 20).join(", ") + (industries.length > 20 ? "..." : ""),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
