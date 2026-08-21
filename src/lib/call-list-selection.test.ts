import { describe, expect, it } from "vitest";
import {
  pruneSelection,
  selectAllState,
  toggleSelectAll,
  visibleCallListEntryIds,
} from "@/lib/call-list-selection";

describe("call-list selection", () => {
  it("select-all applies to visible rows only — closed stay out until expanded", () => {
    expect(
      visibleCallListEntryIds({
        activeIds: ["a", "b"],
        closedIds: ["c"],
        showClosed: false,
      }),
    ).toEqual(["a", "b"]);
    expect(
      visibleCallListEntryIds({
        activeIds: ["a", "b"],
        closedIds: ["c"],
        showClosed: true,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("select-all toggles every visible id and leaves hidden selection alone", () => {
    const hidden = new Set(["hidden"]);
    const selected = toggleSelectAll(["a", "b"], hidden);
    expect([...selected].sort()).toEqual(["a", "b", "hidden"]);
    expect([...toggleSelectAll(["a", "b"], selected)].sort()).toEqual(["hidden"]);
  });

  it("reports none / some / all against the visible set", () => {
    expect(selectAllState(["a", "b"], new Set())).toBe("none");
    expect(selectAllState(["a", "b"], new Set(["a"]))).toBe("some");
    expect(selectAllState(["a", "b"], new Set(["a", "b", "hidden"]))).toBe("all");
    expect(selectAllState([], new Set(["a"]))).toBe("none");
  });

  it("drops ids that are no longer on the loaded list", () => {
    expect([...pruneSelection(new Set(["a", "gone"]), new Set(["a"]))]).toEqual([
      "a",
    ]);
  });
});
