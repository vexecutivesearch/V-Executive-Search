import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/crm",
  useSearchParams: () => new URLSearchParams(),
}));

const { CrmListingsFilterBar } = await import(
  "@/components/crm/CrmListingsFilterBar"
);
type BarProps = Parameters<typeof CrmListingsFilterBar>[0];

const OPTIONS: BarProps["options"] = {
  markets: [],
  states: ["AL", "FL"],
  cities: [
    { city: "Huntsville", stateAbbr: "AL" },
    { city: "Miami", stateAbbr: "FL" },
  ],
  sectors: [],
};

function render(active: Partial<BarProps["active"]> = {}): string {
  return renderToStaticMarkup(
    createElement(CrmListingsFilterBar, {
      boards: ["linkedin"],
      options: OPTIONS,
      active: { q: "", board: "", sort: "newest", state: "", city: "", ...active },
    }),
  );
}

describe("CrmListingsFilterBar — Job listings can set its own location", () => {
  it("carries the same State → City pair as the leads bar", () => {
    // This tab had no location control of its own and leaned on the rail, so
    // making the rail a summary would have left it unfilterable by location.
    const html = render();
    expect(html).toContain('aria-label="Filter by state"');
    expect(html).toContain('aria-label="Filter by city"');
    expect(html).toContain(">Alabama</option>");
  });

  it("gates city on state here too", () => {
    expect(render()).toContain("All cities — pick a state first");
    expect(render({ state: "AL" })).toContain("All cities in Alabama");
    expect(render({ state: "AL" })).not.toContain("Miami, FL");
  });

  it("counts the location scope as an active filter", () => {
    expect(render({ state: "AL" })).toMatch(/rounded-full[^>]*>1</);
  });
});
