import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LocationRail,
  SUMMARY_CITY_LIMIT,
  SUMMARY_STATE_LIMIT,
} from "@/components/crm/LocationRail";
import type { LocationRailState } from "@/lib/crm-queries";

/** Alabama as the operator saw it: three real cities and a long tail of ones. */
const ALABAMA: LocationRailState = {
  stateName: "Alabama",
  stateAbbr: "AL",
  count: 41,
  cities: [
    { city: "Huntsville", count: 18 },
    { city: "Birmingham", count: 14 },
    { city: "Madison", count: 5 },
    ...Array.from({ length: 20 }, (_, i) => ({ city: `Hamlet ${i}`, count: 1 })),
  ],
};

const FLORIDA: LocationRailState = {
  stateName: "Florida",
  stateAbbr: "FL",
  count: 260,
  cities: [{ city: "West Palm Beach", count: 90 }],
};

function render(
  states: LocationRailState[],
  activeState = "",
  activeCity = "",
): string {
  return renderToStaticMarkup(
    createElement(LocationRail, {
      total: states.reduce((n, s) => n + s.count, 0),
      states,
      activeState,
      activeCity,
    }),
  );
}

describe("LocationRail — a summary, not a second set of controls", () => {
  it("sets nothing: no link can write a state or city", () => {
    const html = render([FLORIDA, ALABAMA], "AL");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("state=");
    expect(html).not.toContain("city=");
  });

  it("points at the controls that do own the scope", () => {
    expect(render([FLORIDA])).toContain("State and City filters");
  });

  it("reports the active scope with its counts", () => {
    const html = render([FLORIDA, ALABAMA], "AL", "Huntsville");
    expect(html).toContain("Alabama");
    expect(html).toContain("41");
    expect(html).toContain("Huntsville");
    expect(html).toContain("18");
  });
});

describe("LocationRail — the long tail stays out of the way", () => {
  it("caps the city breakdown instead of listing twenty one-company cities", () => {
    const html = render([ALABAMA], "AL");
    expect(html).toContain("Huntsville");
    expect(html).not.toContain("Hamlet 19");
    const remaining = ALABAMA.cities.length - SUMMARY_CITY_LIMIT;
    expect(html).toContain(`+${remaining} smaller Alabama cities`);
  });

  it("shows cities only for the state in scope", () => {
    const html = render([FLORIDA, ALABAMA], "FL");
    expect(html).toContain("West Palm Beach");
    expect(html).not.toContain("Huntsville");
  });

  it("caps the state list and says how many are left", () => {
    const many = Array.from({ length: SUMMARY_STATE_LIMIT + 4 }, (_, i) => ({
      stateName: `State ${String(i).padStart(2, "0")}`,
      stateAbbr: `S${i}`,
      count: 100 - i,
      cities: [],
    }));
    const html = render(many);
    expect(html).toContain("+4 more states");
  });

  it("never omits the state the list is scoped to, however small", () => {
    const many = Array.from({ length: SUMMARY_STATE_LIMIT + 4 }, (_, i) => ({
      stateName: `State ${String(i).padStart(2, "0")}`,
      stateAbbr: `S${i}`,
      count: 100 - i,
      cities: [],
    }));
    const tiny: LocationRailState = {
      stateName: "Wyoming",
      stateAbbr: "WY",
      count: 1,
      cities: [],
    };
    expect(render([...many, tiny], "WY")).toContain("Wyoming");
  });
});
