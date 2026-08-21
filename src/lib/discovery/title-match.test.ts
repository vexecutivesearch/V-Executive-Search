import { describe, expect, it } from "vitest";
import {
  canonicalTitleTokens,
  matchTitleToTarget,
  rankTitleAgainstTargets,
  TITLE_RANK_DEMOTED_BASE,
  TITLE_RANK_UNMATCHED,
} from "@/lib/discovery/title-match";
import {
  decisionMakerTitles,
  verticalTitleRank,
} from "@/lib/discovery/verticals";

/**
 * These decide which contact a reveal credit is spent on, so both directions
 * matter: a miss sends the credit to whoever the generic sector rank happens
 * to like, and a false positive sends it to an assistant.
 */

describe("normalization folds the ways one role gets written", () => {
  const equivalent: Array<[string, string[]]> = [
    ["HR Director", ["Director of HR", "Director, Human Resources", "HR Director", "Human Resources Director", "director of human resources"]],
    ["VP Operations", ["VP of Operations", "VP, Operations", "Vice President of Operations", "VP Ops", "Vice President, Operations"]],
    ["CFO", ["Chief Financial Officer", "cfo", "C.F.O."]],
    ["CEO", ["Chief Executive Officer", "ceo"]],
    ["COO", ["Chief Operating Officer", "coo"]],
    ["Managing Partner", ["Partner, Managing", "managing partner", "Managing  Partner"]],
    ["General Manager", ["GM", "general manager", "Manager, General"]],
    ["Office Administrator", ["Office Manager", "office administrator", "Manager, Office"]],
    ["HR Manager", ["Human Resources Manager", "Manager, Human Resources", "People Operations Manager", "Personnel Manager"]],
    ["Recruiting Manager", ["Talent Acquisition Manager", "Recruitment Manager", "Manager, Recruiting"]],
    ["Recruiting Director", ["Director of Talent Acquisition", "Head of Recruiting", "Talent Acquisition Director"]],
  ];

  for (const [target, forms] of equivalent) {
    for (const form of forms) {
      it(`treats "${form}" as "${target}"`, () => {
        expect(matchTitleToTarget(form, target)).toBe("match");
      });
    }
  }

  it("is order-independent, which substring matching never was", () => {
    expect(canonicalTitleTokens("Director of HR")).toEqual(
      canonicalTitleTokens("HR Director"),
    );
    expect(canonicalTitleTokens("VP, Operations")).toEqual(
      canonicalTitleTokens("Operations VP"),
    );
  });

  it("ignores punctuation, case, possessives and extra whitespace", () => {
    expect(matchTitleToTarget("  hr   DIRECTOR  ", "HR Director")).toBe("match");
    expect(matchTitleToTarget("Director – Human Resources", "HR Director")).toBe(
      "match",
    );
  });
});

describe("modern names for the HR function", () => {
  const cases: Array<[string, string, "match" | "miss"]> = [
    ["Head of People", "HR Director", "match"],
    ["Director of People Operations", "HR Director", "match"],
    ["Chief People Officer", "HR Director", "match"],
    ["Head of Human Capital", "HR Director", "match"],
    ["People and Culture Manager", "HR Manager", "match"],
    ["Head of People", "HR Manager", "miss"],
  ];
  for (const [title, target, expected] of cases) {
    it(`${title} vs ${target} → ${expected}`, () => {
      expect(matchTitleToTarget(title, target)).toBe(expected);
    });
  }
});

describe("precision: token matching must not invent positives", () => {
  const hazards: Array<[string, string, "demoted" | "miss"]> = [
    // Assistants and deputies hold the title's name, not the role.
    ["Assistant to the HR Director", "HR Director", "demoted"],
    ["Executive Assistant to the CEO", "CEO", "demoted"],
    ["Deputy General Manager", "General Manager", "demoted"],
    ["Assistant Controller", "Controller", "demoted"],
    ["Associate Director of Human Resources", "HR Director", "demoted"],
    ["Junior HR Director", "HR Director", "demoted"],
    ["Interim Managing Partner", "Managing Partner", "demoted"],
    ["Owner's Representative", "Owner", "demoted"],

    // Wrong seniority: the role word is simply absent.
    ["HR Coordinator", "HR Director", "miss"],
    ["HR Generalist", "HR Manager", "miss"],
    ["Recruiting Coordinator", "Recruiting Manager", "miss"],

    // Wrong function.
    ["Regional Sales Manager", "General Manager", "miss"],
    ["Operations Manager", "VP Operations", "miss"],
    ["Director of Business Development", "Executive Director", "miss"],
    ["Partner", "Managing Partner", "miss"],
    ["Paralegal", "HR Director", "miss"],
  ];

  for (const [title, target, expected] of hazards) {
    it(`${title} is not ${target}`, () => {
      expect(matchTitleToTarget(title, target)).toBe(expected);
    });
  }

  it("does not match an abbreviation inside a longer word", () => {
    // The worst false positive substring matching had, and the reason it was
    // never as safe as it looked: "coordinator" contains "coo", so every
    // HR Coordinator and Office Coordinator ranked as the Chief Operating
    // Officer of a construction company and got the reveal credit ahead of
    // the General Manager.
    expect(verticalTitleRank("HR Coordinator", "construction")).toBe(
      TITLE_RANK_UNMATCHED,
    );
    expect(verticalTitleRank("Office Coordinator", "construction")).toBe(
      TITLE_RANK_UNMATCHED,
    );
    expect(verticalTitleRank("COO", "construction")).toBe(3);
  });

  it("does not let a vice president claim a President target", () => {
    // The specific hazard substring matching also had, in reverse: folding
    // "vice president" to the shared leader token leaves no `president` token
    // behind for a bare "President" target to find.
    expect(matchTitleToTarget("Vice President of Sales", "President")).toBe("miss");
    expect(matchTitleToTarget("VP, Finance", "President")).toBe("miss");
    expect(matchTitleToTarget("President", "President")).toBe("match");
  });

  it("keeps a senior prefix a promotion, not a demotion", () => {
    expect(matchTitleToTarget("Senior HR Director, East", "HR Director")).toBe(
      "match",
    );
    expect(matchTitleToTarget("SVP, Operations", "VP Operations")).toBe("match");
  });

  it("still matches when the target itself carries the qualifier", () => {
    expect(matchTitleToTarget("Assistant Controller", "Assistant Controller")).toBe(
      "match",
    );
  });
});

describe("ranking is deterministic and total", () => {
  const targets = ["Managing Partner", "CEO", "Controller"];

  it("returns the earliest matching target when a title matches several", () => {
    // "President & CEO" style dual titles are common; the operator's list
    // order decides, so the same input always produces the same pick.
    expect(rankTitleAgainstTargets("Managing Partner & CEO", targets)).toBe(0);
    expect(rankTitleAgainstTargets("CEO and Managing Partner", targets)).toBe(0);
  });

  it("ranks a demoted match below every real match but above nothing", () => {
    const demoted = rankTitleAgainstTargets("Assistant Controller", targets);
    expect(demoted).toBe(TITLE_RANK_DEMOTED_BASE + 2);
    expect(demoted).toBeGreaterThan(rankTitleAgainstTargets("Controller", targets));
    expect(demoted).toBeLessThan(TITLE_RANK_UNMATCHED);
  });

  it("prefers a real match at a worse position over a demoted better one", () => {
    // Assistant to the Managing Partner (target 0) vs a real Controller
    // (target 2): the Controller is the one who can actually decide.
    const assistant = rankTitleAgainstTargets(
      "Assistant to the Managing Partner",
      targets,
    );
    expect(rankTitleAgainstTargets("Controller", targets)).toBeLessThan(assistant);
  });

  it("gives every input exactly one number", () => {
    for (const title of ["", "   ", "???", "Paralegal", "CEO", null, undefined]) {
      const rank = rankTitleAgainstTargets(title, targets);
      expect(Number.isInteger(rank)).toBe(true);
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThanOrEqual(TITLE_RANK_UNMATCHED);
    }
  });

  it("is stable across repeated calls", () => {
    const once = rankTitleAgainstTargets("Director of HR", ["HR Director"]);
    for (let i = 0; i < 5; i += 1) {
      expect(rankTitleAgainstTargets("Director of HR", ["HR Director"])).toBe(once);
    }
  });
});

describe("each vertical keeps the operator's stated priority order", () => {
  /** [vertical, title, expected rank] — rank is the index in the config list. */
  const cases: Array<[string, string, number]> = [
    // Legal: Managing Partner, Firm Administrator, Executive Director,
    // HR Director, HR Manager, Recruiting Director, Recruiting Manager,
    // Office Administrator.
    ["legal", "Managing Partner", 0],
    ["legal", "Partner, Managing", 0],
    ["legal", "Firm Administrator", 1],
    ["legal", "Executive Director", 2],
    ["legal", "Director of HR", 3],
    ["legal", "Director, Human Resources", 3],
    ["legal", "Head of People", 3],
    ["legal", "Human Resources Manager", 4],
    ["legal", "Director of Talent Acquisition", 5],
    ["legal", "Talent Acquisition Manager", 6],
    ["legal", "Office Manager", 7],
    ["legal", "Office Administrator", 7],

    // Construction: Owner, President, CEO, COO, General Manager,
    // VP Operations, HR Director, HR Manager.
    ["construction", "Owner", 0],
    ["construction", "Co-Owner", 0],
    ["construction", "President", 1],
    ["construction", "Chief Executive Officer", 2],
    ["construction", "Chief Operating Officer", 3],
    ["construction", "GM", 4],
    ["construction", "VP of Operations", 5],
    ["construction", "Vice President, Operations", 5],
    ["construction", "Director of Operations", 5],
    ["construction", "HR Director", 6],
    ["construction", "HR Manager", 7],

    // Finance: Managing Partner, CEO, CFO, Controller, Firm Administrator,
    // HR Director, HR Manager.
    ["finance_accounting", "Managing Partner", 0],
    ["finance_accounting", "CEO", 1],
    ["finance_accounting", "Chief Financial Officer", 2],
    ["finance_accounting", "CFO", 2],
    ["finance_accounting", "Controller", 3],
    ["finance_accounting", "Financial Controller", 3],
    ["finance_accounting", "Firm Administrator", 4],
    ["finance_accounting", "Director of Human Resources", 5],

    // General professional: Owner, CEO, President, COO, HR Director, HR Manager.
    ["general_professional", "Owner", 0],
    ["general_professional", "CEO", 1],
    ["general_professional", "President", 2],
    ["general_professional", "COO", 3],
    ["general_professional", "Director of HR", 4],
    ["general_professional", "People Operations Manager", 5],
  ];

  for (const [vertical, title, expected] of cases) {
    it(`${vertical}: "${title}" ranks ${expected}`, () => {
      expect(verticalTitleRank(title, vertical)).toBe(expected);
    });
  }

  it("keeps the config lists as the operator stated them", () => {
    expect(decisionMakerTitles("legal")[0]).toBe("Managing Partner");
    expect(decisionMakerTitles("construction")[0]).toBe("Owner");
    expect(decisionMakerTitles("finance_accounting")[0]).toBe("Managing Partner");
    expect(decisionMakerTitles("general_professional")[0]).toBe("Owner");
  });

  it("ranks every vertical's own list in its own order", () => {
    for (const vertical of [
      "legal",
      "construction",
      "finance_accounting",
      "general_professional",
    ]) {
      const titles = decisionMakerTitles(vertical);
      titles.forEach((title, index) => {
        // A configured target must rank at its own position, or earlier if an
        // earlier entry also describes it. Never later, and never unmatched.
        expect(verticalTitleRank(title, vertical)).toBeLessThanOrEqual(index);
      });
    }
  });

  it("still ranks an unknown vertical and an unknown title last", () => {
    expect(verticalTitleRank("Managing Partner", null)).toBe(TITLE_RANK_UNMATCHED);
    expect(verticalTitleRank("Managing Partner", "not_a_vertical")).toBe(
      TITLE_RANK_UNMATCHED,
    );
    expect(verticalTitleRank(null, "legal")).toBe(TITLE_RANK_UNMATCHED);
    expect(verticalTitleRank("Paralegal", "legal")).toBe(TITLE_RANK_UNMATCHED);
  });
});
