import { describe, expect, it } from "vitest";
import { evaluateIcp } from "@/lib/icp-filter";
import { employeeBandForVertical } from "@/lib/discovery/verticals";

describe("evaluateIcp vertical-aware employee band", () => {
  it("passes a 12-employee law firm (legal band starts at 10)", () => {
    expect(
      evaluateIcp({
        companyName: "Rosen & Vega PLLC",
        estimatedEmployees: 12,
        vertical: "legal",
      }),
    ).toBe("pass");
  });

  it("passes a 600-employee construction company (band tops out at 750)", () => {
    expect(
      evaluateIcp({
        companyName: "Coastal Mechanical Contractors",
        estimatedEmployees: 600,
        vertical: "construction",
      }),
    ).toBe("pass");
  });

  it("keeps the legacy 20-500 band when there is no vertical", () => {
    expect(
      evaluateIcp({ companyName: "Rosen & Vega PLLC", estimatedEmployees: 12 }),
    ).toBe("fail");
    expect(
      evaluateIcp({
        companyName: "Coastal Mechanical Contractors",
        estimatedEmployees: 600,
      }),
    ).toBe("fail");
    expect(
      evaluateIcp({ companyName: "Steady Mid Co", estimatedEmployees: 120 }),
    ).toBe("pass");
  });

  it("fails outside the vertical band", () => {
    expect(
      evaluateIcp({
        companyName: "Rosen & Vega PLLC",
        estimatedEmployees: 8,
        vertical: "legal",
      }),
    ).toBe("fail");
    expect(
      evaluateIcp({
        companyName: "Coastal Mechanical Contractors",
        estimatedEmployees: 900,
        vertical: "construction",
      }),
    ).toBe("fail");
  });

  it("returns unknown — never fail — for a null employee count", () => {
    expect(
      evaluateIcp({
        companyName: "Small Firm Nobody Counted",
        estimatedEmployees: null,
        vertical: "legal",
      }),
    ).toBe("unknown");
    expect(
      evaluateIcp({ companyName: "Small Firm Nobody Counted" }),
    ).toBe("unknown");
  });

  it("still fails staffing agencies regardless of vertical", () => {
    expect(
      evaluateIcp({
        companyName: "Sunbelt Staffing Solutions",
        estimatedEmployees: 40,
        vertical: "general_professional",
      }),
    ).toBe("fail");
  });

  it("sources every vertical band from config", () => {
    expect(employeeBandForVertical("legal")).toEqual({ min: 10, max: 500 });
    expect(employeeBandForVertical("finance_accounting")).toEqual({
      min: 25,
      max: 750,
    });
    expect(employeeBandForVertical("construction")).toEqual({
      min: 15,
      max: 750,
    });
    expect(employeeBandForVertical("general_professional")).toEqual({
      min: 25,
      max: 750,
    });
    expect(employeeBandForVertical(null)).toEqual({ min: 20, max: 500 });
    expect(employeeBandForVertical("not_a_vertical")).toEqual({
      min: 20,
      max: 500,
    });
  });
});
