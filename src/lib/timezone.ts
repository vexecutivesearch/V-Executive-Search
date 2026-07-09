/** Business timezone for daily list boundaries (recruiter is US-based). */
export const BUSINESS_TIMEZONE = "America/New_York";

export function businessToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
  });
}
