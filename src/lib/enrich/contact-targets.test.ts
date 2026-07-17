import { describe, expect, it } from "vitest";
import {
  detectSector,
  fallbackTitles,
  getContactTargetsConfig,
  resolveSizeBand,
  titlePriorityRank,
  titlesForDiscovery,
} from "./contact-targets";

const cfg = getContactTargetsConfig();
const legal = cfg.contact_targets.legal;

describe("legal detection — strong signal only", () => {
  it("detects legal from strong name patterns alone", () => {
    expect(detectSector("Smith & Jones LLP", null)).toBe("legal");
    expect(detectSector("Coastal PLLC", null)).toBe("legal");
    expect(detectSector("Morgan Attorneys at Law", null)).toBe("legal");
    expect(detectSector("Boca Law Offices", null)).toBe("legal");
  });

  it("detects legal from the sector/industry signal", () => {
    expect(detectSector("Generic Name Co", "Law Practice")).toBe("legal");
    expect(detectSector("Generic Name Co", "Legal Services")).toBe("legal");
  });

  it("does NOT treat weak patterns alone as legal (uncertain → generic)", () => {
    // These match consulting/accounting/architecture too.
    expect(detectSector("Smith & Associates", null)).toBe("default");
    expect(detectSector("Peachtree Group", null)).toBe("default");
    expect(detectSector("Riverside Partners", null)).toBe("default");
  });

  it("a consulting firm named 'Smith & Associates' is not a law firm", () => {
    expect(detectSector("Smith & Associates", "Management Consulting")).toBe(
      "default",
    );
  });
});

describe("size band resolution", () => {
  it("uses headcount when known", () => {
    expect(resolveSizeBand(20, null, legal)).toBe("small");
    expect(resolveSizeBand(200, null, legal)).toBe("large");
  });

  it("falls back to the ICP size band", () => {
    expect(resolveSizeBand(null, "small", legal)).toBe("small");
    expect(resolveSizeBand(null, "mid", legal)).toBe("large");
    expect(resolveSizeBand(null, "large", legal)).toBe("large");
  });

  it("stays unknown when nothing is known", () => {
    expect(resolveSizeBand(null, null, legal)).toBe("unknown");
    expect(resolveSizeBand(null, "unknown", legal)).toBe("unknown");
  });
});

describe("titlesForDiscovery — allowlist + union", () => {
  it("small firm searches only the small-firm titles", () => {
    const { titles, usedUnion } = titlesForDiscovery("legal", "small");
    expect(usedUnion).toBe(false);
    expect(titles).toContain("Managing Partner");
    expect(titles).toContain("Firm Administrator");
    // Never search litigation chairs / practice-group leaders (not on list).
    expect(titles.join(" ").toLowerCase()).not.toContain("litigation");
    expect(titles.join(" ").toLowerCase()).not.toContain("practice group");
    expect(titles).not.toContain("HR Director");
  });

  it("large firm uses the HR Director-led list", () => {
    const { titles } = titlesForDiscovery("legal", "large");
    expect(titles[0]).toBe("HR Director");
    expect(titles).toContain("Recruiting Director");
    expect(titles).toContain("Legal Recruiting Manager");
  });

  it("unknown size searches the UNION of both lists in one pass, deduped", () => {
    const { titles, usedUnion } = titlesForDiscovery("legal", "unknown");
    expect(usedUnion).toBe(true);
    expect(titles).toContain("Managing Partner"); // small
    expect(titles).toContain("HR Director"); // large
    // Firm Administrator is on both lists — deduped to one entry.
    expect(titles.filter((t) => t === "Firm Administrator")).toHaveLength(1);
  });

  it("expands piped title variants (Founder|Named Partner)", () => {
    const { titles } = titlesForDiscovery("legal", "small");
    expect(titles).toContain("Founder");
    expect(titles).toContain("Named Partner");
  });
});

describe("title priority ranking + pre-selection", () => {
  it("ranks the highest-priority small-firm title first", () => {
    const mp = titlePriorityRank("Managing Partner", "legal", "small");
    const admin = titlePriorityRank("Firm Administrator", "legal", "small");
    expect(mp).toBeLessThan(admin);
  });

  it("ranks HR Director top for large firms", () => {
    const hr = titlePriorityRank("HR Director", "legal", "large");
    const exec = titlePriorityRank("Executive Director", "legal", "large");
    expect(hr).toBeLessThan(exec);
  });

  it("titles not on the allowlist rank last", () => {
    const litigation = titlePriorityRank("Litigation Chair", "legal", "small");
    const mp = titlePriorityRank("Managing Partner", "legal", "small");
    expect(litigation).toBeGreaterThan(mp);
    expect(litigation).toBeGreaterThanOrEqual(900);
  });

  it("generic sector ranks owner/CEO first", () => {
    const owner = titlePriorityRank("Owner", "default", "small");
    const office = titlePriorityRank("Office Manager", "default", "small");
    expect(owner).toBeLessThan(office);
  });
});

describe("empty fallback — never an empty picker", () => {
  it("legal falls back to generic decision-makers", () => {
    expect(fallbackTitles("legal")).toEqual([
      "Owner",
      "Principal",
      "President",
      "Founder",
    ]);
  });

  it("default falls back to Owner/Principal/President", () => {
    expect(fallbackTitles("default")).toEqual(["Owner", "Principal", "President"]);
  });
});
