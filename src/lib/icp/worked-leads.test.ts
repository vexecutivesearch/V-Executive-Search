import { describe, expect, it } from "vitest";
import workedLeadsFixture from "./fixtures/worked-leads.json";
import { icpScorer, isHiddenByToggles, type IcpLeadInput } from "./icp-scorer";
import { getIcpConfig, withFlag, ICP_FLAG_NAMES, type IcpConfig } from "./icp-config";

type WorkedLeadsFixture = {
  generated_at: string;
  min_score_floor: number;
  allowed_flags?: Record<string, string[]>;
  leads: Array<{
    id: string;
    name: string;
    domain: string | null;
    status: string;
    lead_score: number;
  }>;
};

const fixture = workedLeadsFixture as WorkedLeadsFixture;

/**
 * §7.1 Worked-leads must-keep gate — the primary regression test.
 *
 * The fixture is exported from REAL history (call list, call/meeting activity,
 * non-new status) by scripts/export-worked-leads.ts. Any rule change that
 * would hide or collapse a historically-worked lead fails this gate.
 */
describe("worked-leads must-keep gate", () => {
  const ALL_HIDE_TOGGLES = {
    exclude_fortune_lists: true,
    exclude_gov_domains: true,
    exclude_known_staffing_agencies: true,
    exclude_known_large_private: true,
  } as const;

  // Soft, informational flags a worked lead may legitimately carry.
  const EXPECTED_SAFE_FLAGS = new Set([
    "role_ambiguous",
    "salary_below_min",
    "internal_ta_presence",
    "large_company_hint",
  ]);

  function allScoringOn(): IcpConfig {
    let c = getIcpConfig();
    for (const flag of ICP_FLAG_NAMES) c = withFlag(c, flag, true);
    return c;
  }

  const inputs: IcpLeadInput[] = fixture.leads.map((lead) => ({
    companyId: lead.id,
    companyName: lead.name,
    domain: lead.domain,
    baseLeadScore: lead.lead_score,
    listings: [],
  }));

  it("excludes ZERO historically-worked leads (strictest toggles on)", () => {
    if (!inputs.length) return; // empty fixture — nothing to gate yet
    const annotations = icpScorer(inputs, allScoringOn());
    for (const annotation of annotations) {
      expect(
        isHiddenByToggles(annotation, ALL_HIDE_TOGGLES),
        `${annotation.companyName} (worked lead) must never be hidden`,
      ).toBe(false);
    }
  });

  it("gives no worked lead a hard flag (>= 0.9) beyond expected-safe ones", () => {
    if (!inputs.length) return;
    const annotations = icpScorer(inputs, allScoringOn());
    for (const annotation of annotations) {
      const allowed = new Set([
        ...EXPECTED_SAFE_FLAGS,
        ...(fixture.allowed_flags?.[annotation.companyId] ?? []),
      ]);
      const hardFlags = annotation.exclusionFlags.filter(
        (flag) =>
          (annotation.exclusionConfidence[flag] ?? 0) >= 0.9 && !allowed.has(flag),
      );
      expect(
        hardFlags,
        `${annotation.companyName} (worked lead) got hard flags: ${hardFlags.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("never collapses a worked lead below the configured floor", () => {
    if (!inputs.length) return;
    const annotations = icpScorer(inputs, allScoringOn());
    for (const annotation of annotations) {
      // Leads with an explicit allowed-flag exception accept that flag's
      // scoring penalty; the floor drops accordingly (but never to zero).
      const hasException =
        (fixture.allowed_flags?.[annotation.companyId] ?? []).length > 0;
      const floor = Math.max(
        1,
        Math.min(
          fixture.min_score_floor,
          Math.round(annotation.baseLeadScore * 0.85),
        ) - (hasException ? 15 : 0),
      );
      expect(
        annotation.icpAdjustedScore,
        `${annotation.companyName}: ${annotation.baseLeadScore} → ${annotation.icpAdjustedScore} fell below floor ${floor}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });
});
