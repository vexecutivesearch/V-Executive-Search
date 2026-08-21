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

function render(
  active: Partial<FilterBarProps["active"]>,
  variant: FilterBarProps["variant"] = "full",
): string {
  return renderToStaticMarkup(
    createElement(CrmFilterBar, {
      options: OPTIONS,
      tab: variant === "discovery" ? "discovery" : "all",
      variant,
      active: {
        state: "",
        city: "",
        sector: "",
        lane: "",
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
    expect(html).toMatch(/disabled=""[^>]*aria-label="Filter by city"/);
    expect(html).not.toContain("Adairsville, GA");
    expect(html).not.toContain("Miami, FL");
  });

  it("offers only the chosen state's cities", () => {
    const html = render({ state: "GA" });
    expect(html).toContain("All cities in Georgia");
    expect(html).toContain("Adairsville, GA");
    expect(html).not.toContain("Miami, FL");
    expect(html).not.toContain('disabled=""');
  });

  it("names the state scope in the city control", () => {
    expect(render({ state: "FL", city: "Miami" })).toContain(
      "All cities in Florida",
    );
  });

  it("cannot keep a city whose state is not selected", () => {
    // Nothing offers a city outside the state scope, at any breakpoint, so
    // `city=` can never be written without its `state=`.
    const html = render({ state: "FL" });
    const fromCitySelect = html.slice(
      html.indexOf('aria-label="Filter by city"'),
    );
    const cityOptions = fromCitySelect
      .slice(0, fromCitySelect.indexOf("</select>"))
      .match(/value="[^"]*"/g);
    expect(cityOptions).toEqual(['value=""', 'value="Miami"']);
  });
});

describe("CrmFilterBar — one control per location level", () => {
  it("offers a single state selector, on every breakpoint", () => {
    const html = render({});
    const stateControls = html.match(/aria-label="Filter by state"/g);
    expect(stateControls).toHaveLength(1);
    expect(html).not.toContain("lg:hidden");
  });

  it("names states the way the location summary does", () => {
    const html = render({});
    expect(html).toContain(">Florida</option>");
    expect(html).toContain(">Georgia</option>");
  });

  it("selects the active state", () => {
    expect(render({ state: "GA" })).toMatch(/<option value="GA" selected="">/);
  });
});

describe("CrmFilterBar — the discovery variant only searches", () => {
  it("shows no browse location control the review queue would ignore", () => {
    const html = render({}, "discovery");
    expect(html).not.toContain('aria-label="Filter by state"');
    expect(html).not.toContain('aria-label="Filter by city"');
    expect(html).toContain('aria-label="Search the review queue"');
  });

  it("promises only the fields the review queue actually searches", () => {
    const html = render({}, "discovery");
    expect(html).toContain("company, domain, industry");
    expect(html).not.toContain("Sort: ICP fit");
    expect(html).not.toContain("Hide categories");
  });
});

describe("CrmFilterBar — lead source lane", () => {
  it("offers every lane and defaults to all of them", () => {
    const html = render({});
    expect(html).toContain('aria-label="Filter by lead source"');
    expect(html).toContain("All lead sources");
    expect(html).toContain("Inbound — form");
    expect(html).toContain("Inbound — Meta");
  });

  it("selects the active lane", () => {
    const html = render({ lane: "inbound_form" });
    expect(html).toMatch(/<option value="inbound_form" selected="">/);
  });
});
