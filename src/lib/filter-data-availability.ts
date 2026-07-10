import { getBacklogCompanies } from "@/lib/queries";
import { listingHasSalary, listingSalaryMax } from "@/lib/lead-filters";

export type FilterDataAvailability = {
  backlogTotal: number;
  industryFilled: number;
  industryPct: number;
  salaryAnyFilled: number;
  salaryAnyPct: number;
  salaryNumericFilled: number;
  salaryNumericPct: number;
  /** Show industry filter when fill rate meets threshold */
  industryFilterReady: boolean;
  /** Show salary filter when fill rate meets threshold */
  salaryFilterReady: boolean;
};

const FILTER_READY_PCT = 40;

function pct(filled: number, total: number): number {
  return total ? Math.round((1000 * filled) / total) / 10 : 0;
}

export async function getFilterDataAvailability(): Promise<FilterDataAvailability> {
  const backlog = await getBacklogCompanies();
  let industryFilled = 0;
  let salaryAnyFilled = 0;
  let salaryNumericFilled = 0;

  for (const company of backlog) {
    if (company.industry?.trim()) industryFilled++;
    if (company.jobListings.some((l) => listingHasSalary(l))) salaryAnyFilled++;
    if (company.jobListings.some((l) => listingSalaryMax(l) != null)) {
      salaryNumericFilled++;
    }
  }

  const backlogTotal = backlog.length;
  const industryPct = pct(industryFilled, backlogTotal);
  const salaryAnyPct = pct(salaryAnyFilled, backlogTotal);
  const salaryNumericPct = pct(salaryNumericFilled, backlogTotal);

  return {
    backlogTotal,
    industryFilled,
    industryPct,
    salaryAnyFilled,
    salaryAnyPct,
    salaryNumericFilled,
    salaryNumericPct,
    industryFilterReady: industryPct >= FILTER_READY_PCT,
    salaryFilterReady: salaryAnyPct >= FILTER_READY_PCT,
  };
}
