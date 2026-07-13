import { describe, expect, it } from "vitest";
import { classifyRoleFamily, ROLE_FAMILIES } from "@/lib/role-families";

describe("classifyRoleFamily", () => {
  it("matches Legal keywords", () => {
    expect(classifyRoleFamily("Litigation Paralegal")).toBe("Legal");
    expect(classifyRoleFamily("Corporate Attorney")).toBe("Legal");
    expect(classifyRoleFamily("General Counsel")).toBe("Legal");
    expect(classifyRoleFamily("Legal Assistant")).toBe("Legal");
  });

  it("matches HR keywords", () => {
    expect(classifyRoleFamily("HR Director")).toBe("HR");
    expect(classifyRoleFamily("Human Resources Manager")).toBe("HR");
    expect(classifyRoleFamily("Talent Acquisition Specialist")).toBe("HR");
    expect(classifyRoleFamily("People Ops Lead")).toBe("HR");
    expect(classifyRoleFamily("Benefits Coordinator")).toBe("HR");
  });

  it("matches Finance & Accounting keywords", () => {
    expect(classifyRoleFamily("Staff Accountant")).toBe("Finance & Accounting");
    expect(classifyRoleFamily("Controller")).toBe("Finance & Accounting");
    expect(classifyRoleFamily("CFO")).toBe("Finance & Accounting");
    expect(classifyRoleFamily("Financial Analyst")).toBe("Finance & Accounting");
    expect(classifyRoleFamily("AP/AR Clerk")).toBe("Finance & Accounting");
  });

  it("matches Marketing keywords", () => {
    expect(classifyRoleFamily("Marketing Manager")).toBe("Marketing");
    expect(classifyRoleFamily("Digital Marketing Specialist")).toBe("Marketing");
    expect(classifyRoleFamily("SEO Analyst")).toBe("Marketing");
    expect(classifyRoleFamily("Brand Manager")).toBe("Marketing");
    expect(classifyRoleFamily("Demand Gen Lead")).toBe("Marketing");
  });

  it("matches Construction keywords", () => {
    expect(classifyRoleFamily("Construction Manager")).toBe("Construction");
    expect(classifyRoleFamily("Estimator")).toBe("Construction");
    expect(classifyRoleFamily("Site Superintendent")).toBe("Construction");
    expect(classifyRoleFamily("Civil Engineer")).toBe("Construction");
    expect(
      classifyRoleFamily("Project Manager — Construction"),
    ).toBe("Construction");
  });

  it("does not classify clear negatives", () => {
    expect(classifyRoleFamily("Barista")).toBeNull();
    expect(classifyRoleFamily("Cashier")).toBeNull();
    expect(classifyRoleFamily("Warehouse Associate")).toBeNull();
    expect(classifyRoleFamily("Mixer (dough) Mornings")).toBeNull();
    expect(classifyRoleFamily("Software Engineer")).toBeNull();
    // IT PM without construction context
    expect(classifyRoleFamily("IT Project Manager")).toBeNull();
  });

  it("covers all five families in ROLE_FAMILIES", () => {
    expect(ROLE_FAMILIES).toEqual([
      "Legal",
      "HR",
      "Finance & Accounting",
      "Marketing",
      "Construction",
    ]);
  });
});
