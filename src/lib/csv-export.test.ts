import { describe, expect, it } from "vitest";
import { companiesToScrapeRows, rowsToCsv } from "@/lib/csv-export";
import type { CompanyCardData } from "@/components/CompanyCard";

describe("csv export", () => {
  it("escapes commas and quotes in CSV cells", () => {
    const csv = rowsToCsv(["name"], [{ name: 'Acme, "LLC"' }]);
    expect(csv).toBe('name\n"Acme, ""LLC"""');
  });

  it("flattens companies to one row per job", () => {
    const company = {
      id: "1",
      name: "Test Co",
      domain: "test.com",
      domainConfidence: "high",
      status: "new",
      firstSeen: "2026-07-12",
      leadScore: 80,
      icpStatus: "pass",
      contacts: [],
      jobListings: [
        {
          id: "j1",
          title: "HR Director",
          board: "indeed",
          location: "Miami, FL",
          url: "https://example.com/job",
          searchName: "Scan",
          salaryText: "$100k",
          lastSeenRunDate: "2026-07-12",
        },
        {
          id: "j2",
          title: "Recruiter",
          board: "linkedin",
          location: "Miami, FL",
          url: "https://example.com/job2",
          searchName: "Scan",
          lastSeenRunDate: "2026-07-12",
        },
      ],
    } as unknown as CompanyCardData;

    expect(companiesToScrapeRows([company])).toHaveLength(2);
  });
});
