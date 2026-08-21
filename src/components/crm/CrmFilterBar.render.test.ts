import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/crm",
  useSearchParams: () => new URLSearchParams(),
}));

const { CrmFilterBar } = await import("@/components/crm/CrmFilterBar");
type FilterBarProps = Parameters<typeof CrmFilterBar>[0];

const OPTIONS: FilterBarProps["options"] = {
  markets: [],
  states: ["FL", "GA"],
  cities: [
    { city: "Adairsville", stateAbbr: "GA" },
    { city: "Atlanta", stateAbbr: "GA" },
    { city: "Miami", stateAbbr: "FL" },
  ],
  sectors: [],
};

function render(active: Partial<FilterBarProps["active"]>): string {
  return renderToStaticMarkup(
    createElement(CrmFilterBar, {
      options: OPTIONS,
      tab: "all",
      active: {
        state: "",
        city: "",
        sector: "",
        status: "",
        q: "",
        callable: false,
        enriched: false,
        discovered: false,
        role: "",
        size: "",
        comp: "",
        includeEstimated: true,
        icpMin: "",
        hide: [],
        sort: "icp",
        ...active,
      },
    }),
  );
}

describe("CrmFilterBar — city is scoped by the state scope", () => {
  it("offers no city until a state is chosen", () => {
    const html = render({});
    expect(html).toContain("All cities — pick a state first");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Adairsville, GA");
    expect(html).not.toContain("Miami, FL");
  });

  it("offers only the chosen state's cities", () => {
    const html = render({ state: "GA" });
    expect(html).toContain("All cities in Georgia");
    expect(html).toContain("Adairsville, GA");
    expect(html).not.toContain("Miami, FL");
  });

  it("names the state scope where the rail replaces the state dropdown", () => {
    expect(render({ state: "FL", city: "Miami" })).toContain("Florida");
  });
});
