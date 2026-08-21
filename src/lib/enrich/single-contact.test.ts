import { describe, expect, it } from "vitest";
import {
  pickSingleDecisionMaker,
  type RankableCandidate,
} from "@/lib/enrich/single-contact";
import {
  decisionMakerTitles,
  verticalTitleRank,
} from "@/lib/discovery/verticals";

function candidate(
  over: Partial<RankableCandidate> & { name: string },
): RankableCandidate {
  return {
    contactId: `c-${over.name}`,
    title: null,
    revealStatus: null,
    locationMatched: true,
    priorityRank: 50,
    hasEmail: false,
    hasPhone: false,
    ...over,
  };
}

describe("vertical decision-maker titles", () => {
  it("matches the operator's per-vertical priority lists", () => {
    expect(decisionMakerTitles("legal")).toEqual([
      "Managing Partner",
      "Firm Administrator",
      "Executive Director",
      "HR Director",
      "HR Manager",
      "Recruiting Director",
      "Recruiting Manager",
      "Office Administrator",
    ]);
    expect(decisionMakerTitles("construction")).toEqual([
      "Owner",
      "President",
      "CEO",
      "COO",
      "General Manager",
      "VP Operations",
      "HR Director",
      "HR Manager",
    ]);
    expect(decisionMakerTitles("finance_accounting")).toEqual([
      "Managing Partner",
      "CEO",
      "CFO",
      "Controller",
      "Firm Administrator",
      "HR Director",
      "HR Manager",
    ]);
    expect(decisionMakerTitles("general_professional")).toEqual([
      "Owner",
      "CEO",
      "President",
      "COO",
      "HR Director",
      "HR Manager",
    ]);
  });

  it("ranks by position in the vertical list, best first", () => {
    expect(verticalTitleRank("Managing Partner", "legal")).toBe(0);
    expect(verticalTitleRank("Firm Administrator", "legal")).toBe(1);
    // Surrounding words are fine as long as the listed phrase is intact.
    expect(verticalTitleRank("Senior HR Director, East", "legal")).toBe(3);
    expect(verticalTitleRank("managing partner", "legal")).toBe(0);
  });

  it("ranks unknown titles and unknown verticals last", () => {
    expect(verticalTitleRank("Paralegal", "legal")).toBe(900);
    expect(verticalTitleRank("Managing Partner", null)).toBe(900);
    expect(verticalTitleRank(null, "legal")).toBe(900);
  });

  it("documents that matching is substring-only, so reordered titles miss", () => {
    // Known limitation: the config lists "HR Director", and the matcher is a
    // plain substring test, so these common real-world orderings fall through
    // to the sector fallback rank instead of the vertical list. Widening the
    // match would change which contact a reveal credit is spent on, so it is
    // left as an explicit operator decision rather than a silent change.
    expect(verticalTitleRank("Director of HR", "legal")).toBe(900);
    expect(verticalTitleRank("Director, Human Resources", "legal")).toBe(900);
  });
});

describe("pickSingleDecisionMaker", () => {
  it("prefers the highest-priority title for the vertical", () => {
    const picked = pickSingleDecisionMaker(
      [
        candidate({ name: "Office Admin", title: "Office Administrator" }),
        candidate({ name: "Partner", title: "Managing Partner" }),
        candidate({ name: "HR", title: "HR Director" }),
      ],
      "legal",
    );
    expect(picked?.name).toBe("Partner");
  });

  it("uses the same vertical order per vertical, not one global order", () => {
    const pool = [
      candidate({ name: "Owner", title: "Owner" }),
      candidate({ name: "Controller", title: "Controller" }),
    ];
    expect(pickSingleDecisionMaker(pool, "construction")?.name).toBe("Owner");
    expect(pickSingleDecisionMaker(pool, "finance_accounting")?.name).toBe(
      "Controller",
    );
  });

  it("falls back to the sector priority rank for off-list titles", () => {
    const picked = pickSingleDecisionMaker(
      [
        candidate({ name: "Weak", title: "Paralegal", priorityRank: 80 }),
        candidate({ name: "Strong", title: "Legal Ops Lead", priorityRank: 5 }),
      ],
      "legal",
    );
    expect(picked?.name).toBe("Strong");
  });

  it("never outranks a named vertical title with a sector fallback", () => {
    const picked = pickSingleDecisionMaker(
      [
        candidate({ name: "Fallback", title: "Legal Ops Lead", priorityRank: 0 }),
        candidate({
          name: "Listed",
          title: "Office Administrator",
          priorityRank: 99,
        }),
      ],
      "legal",
    );
    expect(picked?.name).toBe("Listed");
  });

  it("breaks ties on in-market first, then name", () => {
    const picked = pickSingleDecisionMaker(
      [
        candidate({
          name: "Remote",
          title: "Managing Partner",
          locationMatched: false,
        }),
        candidate({
          name: "Local",
          title: "Managing Partner",
          locationMatched: true,
        }),
      ],
      "legal",
    );
    expect(picked?.name).toBe("Local");
  });
});

describe("stop after one contact", () => {
  it("never returns a candidate whose email was already paid for", () => {
    const picked = pickSingleDecisionMaker(
      [
        candidate({
          name: "Paid",
          title: "Managing Partner",
          revealStatus: "revealed",
        }),
        candidate({ name: "Unpaid", title: "Office Administrator" }),
      ],
      "legal",
    );
    // The better title is already revealed, so the credit goes to the next one.
    expect(picked?.name).toBe("Unpaid");
  });

  it("treats an existing email as already revealed even without the status", () => {
    const picked = pickSingleDecisionMaker(
      [candidate({ name: "HasEmail", title: "Managing Partner", hasEmail: true })],
      "legal",
    );
    expect(picked).toBeNull();
  });

  it("returns nothing to buy when every candidate is revealed", () => {
    expect(
      pickSingleDecisionMaker(
        [
          candidate({ name: "A", revealStatus: "revealed" }),
          candidate({ name: "B", hasEmail: true }),
        ],
        "legal",
      ),
    ).toBeNull();
  });

  it("returns nothing for an empty candidate pool", () => {
    expect(pickSingleDecisionMaker([], "legal")).toBeNull();
  });

  it("picks exactly one candidate, never a list", () => {
    const picked = pickSingleDecisionMaker(
      Array.from({ length: 25 }, (_, i) =>
        candidate({ name: `HR ${i}`, title: "HR Director" }),
      ),
      "legal",
    );
    expect(picked).not.toBeNull();
    expect(Array.isArray(picked)).toBe(false);
  });
});
