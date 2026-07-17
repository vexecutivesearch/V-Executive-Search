/**
 * Config-driven job title → role-family allowlist for Hot Listings.
 * Titles that match no family are intentionally excluded (no "Other" bucket).
 */

export const ROLE_FAMILIES = [
  "Legal",
  "HR",
  "Finance & Accounting",
  "Marketing",
  "Construction",
] as const;

export type RoleFamily = (typeof ROLE_FAMILIES)[number];

type FamilyRule = {
  /** Substring / phrase matches (case-insensitive). */
  includes?: string[];
  /** Whole-word matches for short ambiguous tokens. */
  words?: string[];
  /** Extra predicate when a broad keyword needs context. */
  requiresAny?: string[];
};

/** Rules per family. Order within a family is longest-first preference. */
const FAMILY_RULES: Record<RoleFamily, FamilyRule[]> = {
  Legal: [
    { includes: ["paralegal", "legal assistant", "compliance counsel"] },
    { includes: ["litigation", "attorney", "lawyer", "counsel"] },
    { includes: ["contracts"], requiresAny: ["legal", "counsel", "attorney", "paralegal"] },
    { words: ["legal"] },
  ],
  HR: [
    {
      includes: [
        "human resources",
        "human resource",
        "people ops",
        "people operations",
        "talent acquisition",
        "hrbp",
        "hr manager",
        "hr director",
        "hr generalist",
        "hr business",
      ],
    },
    { words: ["recruiter", "recruiting", "talent", "benefits", "compensation"] },
    { words: ["hr"] },
  ],
  "Finance & Accounting": [
    {
      includes: [
        "financial analyst",
        "finance manager",
        "accounts payable",
        "accounts receivable",
        "ap/ar",
        "a/p",
        "a/r",
        "tax accountant",
        "tax manager",
        "bookkeeper",
      ],
    },
    {
      words: [
        "accountant",
        "controller",
        "cfo",
        "auditor",
        "finance",
        "accounting",
        "tax",
      ],
    },
  ],
  Marketing: [
    {
      includes: [
        "demand gen",
        "demand generation",
        "social media",
        "digital marketing",
        "content marketing",
        "brand manager",
        "growth marketing",
        "public relations",
      ],
    },
    {
      words: [
        "marketing",
        "communications",
        "seo",
        "content",
        "brand",
        "pr",
      ],
    },
  ],
  Construction: [
    {
      includes: [
        "construction manager",
        "site manager",
        "civil engineer",
        "superintendent",
        "estimator",
        "foreman",
      ],
    },
    {
      includes: ["project manager"],
      requiresAny: ["construction", "civil", "site", "superintendent"],
    },
    { words: ["civil", "construction"] },
  ],
};

function hasWord(titleLower: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(
    titleLower,
  );
}

function ruleMatches(titleLower: string, rule: FamilyRule): boolean {
  let hit = false;
  for (const phrase of rule.includes ?? []) {
    if (titleLower.includes(phrase.toLowerCase())) {
      hit = true;
      break;
    }
  }
  if (!hit) {
    for (const word of rule.words ?? []) {
      if (hasWord(titleLower, word.toLowerCase())) {
        hit = true;
        break;
      }
    }
  }
  if (!hit) return false;
  if (rule.requiresAny?.length) {
    return rule.requiresAny.some(
      (req) =>
        titleLower.includes(req.toLowerCase()) ||
        hasWord(titleLower, req.toLowerCase()),
    );
  }
  return true;
}

/**
 * Classify a job title into one Hot Listings role family, or null if none match.
 * First matching family in ROLE_FAMILIES order wins.
 */
export function classifyRoleFamily(
  title: string | null | undefined,
): RoleFamily | null {
  if (!title?.trim()) return null;
  const lower = title.trim().toLowerCase();

  for (const family of ROLE_FAMILIES) {
    for (const rule of FAMILY_RULES[family]) {
      if (ruleMatches(lower, rule)) return family;
    }
  }
  return null;
}
