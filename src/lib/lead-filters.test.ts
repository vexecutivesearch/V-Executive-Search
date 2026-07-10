import { describe, expect, it } from "vitest";
import {
  companyMatchesEmailReportFilters,
  companyMatchesLeadFilters,
  listingHasSalary,
  listingMatchesJobTitle,
} from "@/lib/lead-filters";

const baseListing = {
  title: "HR Director",
  searchName: "HR Director",
  salaryMin: null as number | null,
  salaryMax: null as number | null,
  salaryText: null as string | null,
};

describe("listingMatchesJobTitle", () => {
  it("matches search profile name prefix", () => {
    expect(
      listingMatchesJobTitle(
        { title: "Director of HR", searchName: "HR Director" },
        "HR Director",
      ),
    ).toBe(true);
  });

  it("returns true when filter empty", () => {
    expect(listingMatchesJobTitle(baseListing, "")).toBe(true);
  });
});

describe("listingHasSalary", () => {
  it("detects min/max and text", () => {
    expect(listingHasSalary({ ...baseListing, salaryMin: 90000 })).toBe(true);
    expect(listingHasSalary({ ...baseListing, salaryText: "$120k" })).toBe(true);
    expect(listingHasSalary(baseListing)).toBe(false);
  });
});

describe("companyMatchesLeadFilters", () => {
  const company = {
    industry: "Healthcare",
    jobListings: [
      { ...baseListing, salaryMax: 95000 },
      {
        ...baseListing,
        title: "VP People",
        searchName: "VP People",
        salaryMax: null,
      },
    ],
  };

  it("filters by job title", () => {
    expect(
      companyMatchesLeadFilters(company, {
        jobTitle: "VP People",
        industry: "",
        salaryFilter: "any",
        salaryMinUsd: 80000,
        includeUnknownIndustry: true,
        includeUnknownSalary: true,
      }),
    ).toBe(true);
    expect(
      companyMatchesLeadFilters(company, {
        jobTitle: "Head of Talent",
        industry: "",
        salaryFilter: "any",
        salaryMinUsd: 80000,
      }),
    ).toBe(false);
  });

  it("filters by sector rollup", () => {
    expect(
      companyMatchesLeadFilters(
        {
          industry: "hospital & health care",
          jobListings: company.jobListings,
        },
        {
          jobTitle: "",
          industry: "Healthcare & Life Sciences",
          salaryFilter: "any",
          salaryMinUsd: 80000,
          includeUnknownIndustry: false,
          includeUnknownSalary: true,
        },
      ),
    ).toBe(true);
    expect(
      companyMatchesLeadFilters(
        {
          industry: "hospital & health care",
          jobListings: company.jobListings,
        },
        {
          jobTitle: "",
          industry: "Financial Services",
          salaryFilter: "any",
          salaryMinUsd: 80000,
          includeUnknownIndustry: false,
          includeUnknownSalary: true,
        },
      ),
    ).toBe(false);
  });

  it("filters by legacy industry substring", () => {
    expect(
      companyMatchesLeadFilters(company, {
        jobTitle: "",
        industry: "health",
        salaryFilter: "any",
        salaryMinUsd: 80000,
        includeUnknownIndustry: false,
        includeUnknownSalary: true,
      }),
    ).toBe(true);
  });

  it("includes unknown industry by default when filtering", () => {
    expect(
      companyMatchesLeadFilters(
        { industry: null, jobListings: company.jobListings },
        {
          jobTitle: "",
          industry: "health",
          salaryFilter: "any",
          salaryMinUsd: 80000,
          includeUnknownIndustry: true,
          includeUnknownSalary: true,
        },
      ),
    ).toBe(true);
  });

  it("filters by minimum salary", () => {
    expect(
      companyMatchesLeadFilters(company, {
        jobTitle: "",
        industry: "",
        salaryFilter: "min_salary",
        salaryMinUsd: 100000,
        includeUnknownIndustry: true,
        includeUnknownSalary: false,
      }),
    ).toBe(false);
    expect(
      companyMatchesLeadFilters(company, {
        jobTitle: "",
        industry: "",
        salaryFilter: "min_salary",
        salaryMinUsd: 90000,
        includeUnknownIndustry: true,
        includeUnknownSalary: false,
      }),
    ).toBe(true);
  });
});

describe("companyMatchesEmailReportFilters", () => {
  const company = {
    industry: "Financial Services",
    jobListings: [
      {
        ...baseListing,
        searchName: "HR Director",
        salaryMax: 110000,
      },
    ],
  };

  it("ORs across selected job titles", () => {
    expect(
      companyMatchesEmailReportFilters(company, {
        jobTitleFilters: ["VP People", "HR Director"],
        industryFilters: [],
        salaryFilter: "any",
      }),
    ).toBe(true);
  });

  it("ORs across selected sectors", () => {
    expect(
      companyMatchesEmailReportFilters(company, {
        jobTitleFilters: [],
        industryFilters: ["Healthcare & Life Sciences", "Financial Services"],
        salaryFilter: "any",
      }),
    ).toBe(true);
  });

  it("requires has_salary when configured", () => {
    expect(
      companyMatchesEmailReportFilters(
        {
          industry: "Tech",
          jobListings: [{ ...baseListing, salaryMax: null }],
        },
        { salaryFilter: "has_salary" },
      ),
    ).toBe(false);
  });

  it("includes unknown industry when email industry filters are set", () => {
    expect(
      companyMatchesEmailReportFilters(
        {
          industry: null,
          jobListings: [{ ...baseListing, searchName: "HR Director" }],
        },
        {
          jobTitleFilters: [],
          industryFilters: ["Healthcare"],
          salaryFilter: "any",
        },
      ),
    ).toBe(true);
  });
});
