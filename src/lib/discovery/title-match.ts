/**
 * Decision-maker title matching for the vertical target lists.
 *
 * This decides which single person a reveal credit is spent on, so it is a
 * cost decision as much as a ranking one.
 *
 * The previous implementation was `normalized.includes("hr director")`. That
 * has one real virtue — it almost never produces a surprising positive — and
 * one fatal flaw: the same role written in a different order misses entirely.
 * "Director of HR" and "Director, Human Resources" are at least as common as
 * "HR Director", and both fell through to the generic sector ranking.
 *
 * The replacement normalizes both the candidate title and the configured
 * target to a canonical token set, then matches on set containment so word
 * order does not matter. Two mechanisms keep it from becoming loose:
 *
 * 1. Abbreviations and synonyms are folded into shared canonical tokens, and
 *    seniority words that mean "runs this function" (director, head, VP,
 *    chief) collapse to a single `leader` token. That is what lets "VP of HR"
 *    and "Director of HR" both match the configured "HR Director", and it is
 *    also what stops "Vice President of Sales" from matching a bare
 *    "President" target — after folding, a VP title has no `president` token
 *    left in it at all.
 *
 * 2. Qualifier tokens that mean "this person is not the one" — assistant,
 *    deputy, associate, junior, interim — demote a title that would otherwise
 *    match, unless the configured target carries the same qualifier. So
 *    "Assistant to the HR Director" is not an HR Director.
 *
 * Pure: config in, number out. No DB, no network, no clock.
 */

/** Grammar with no bearing on which role a title names. */
const FILLER_TOKENS = new Set([
  "of",
  "the",
  "and",
  "for",
  "to",
  "at",
  "in",
  "a",
  "an",
  "with",
  "on",
]);

/**
 * Tokens meaning the holder assists, deputises for, or is training toward the
 * role rather than holding it. Present in the title but not in the target,
 * they demote the match instead of granting it.
 *
 * Deliberately absent: "senior", which promotes rather than demotes, and
 * "vice", which is consumed by the vice-president fold below.
 */
const QUALIFIER_TOKENS = new Set([
  "assistant",
  "asst",
  "deputy",
  "associate",
  "junior",
  "jr",
  "intern",
  "trainee",
  "apprentice",
  "aspiring",
  "former",
  "retired",
  "interim",
  "acting",
  "student",
  "candidate",
  // An owner's representative is a hired adviser, not the owner.
  "representative",
]);

/**
 * Phrase rewrites, applied longest-first so a multi-word phrase always wins
 * over its parts ("talent acquisition" before "talent", "people operations"
 * before "people").
 *
 * Both the candidate title and the configured target go through this, so the
 * map is an equivalence relation rather than a one-way expansion: it does not
 * matter which side spells a role out.
 */
const PHRASE_REWRITES: Array<[string[], string[]]> = [
  // C-suite. "leader" is the shared seniority token; the remaining words are
  // what distinguish one chief from another.
  [["chief", "executive", "officer"], ["leader", "executive", "officer"]],
  [["ceo"], ["leader", "executive", "officer"]],
  [["chief", "financial", "officer"], ["leader", "financial", "officer"]],
  [["cfo"], ["leader", "financial", "officer"]],
  [["chief", "operating", "officer"], ["leader", "operating", "officer"]],
  [["coo"], ["leader", "operating", "officer"]],
  [
    ["chief", "people", "officer"],
    ["leader", "human", "resources", "officer"],
  ],
  [["chro"], ["leader", "human", "resources", "officer"]],

  // Vice-president forms. Folding these to `leader` is what keeps a VP out of
  // a "President" target.
  [["executive", "vice", "president"], ["executive", "leader"]],
  [["senior", "vice", "president"], ["senior", "leader"]],
  [["vice", "president"], ["leader"]],
  [["evp"], ["executive", "leader"]],
  [["svp"], ["senior", "leader"]],
  [["vp"], ["leader"]],

  // Human resources and its modern names.
  [["human", "resources"], ["human", "resources"]],
  [["human", "capital"], ["human", "resources"]],
  [["people", "operations"], ["human", "resources"]],
  [["people", "culture"], ["human", "resources"]],
  [["hr"], ["human", "resources"]],
  [["people"], ["human", "resources"]],
  [["personnel"], ["human", "resources"]],

  // Recruiting.
  [["talent", "acquisition"], ["recruiting"]],
  [["recruitment"], ["recruiting"]],
  [["recruiter"], ["recruiting"]],

  // The office-manager / office-administrator pair is one role.
  [["office", "manager"], ["office", "administrator"]],

  [["general", "manager"], ["general", "manager"]],
  [["gm"], ["general", "manager"]],

  // Remaining single-token abbreviations and seniority words.
  [["director"], ["leader"]],
  [["head"], ["leader"]],
  [["dir"], ["leader"]],
  [["ops"], ["operations"]],
  [["admin"], ["administrator"]],
  [["mgr"], ["manager"]],
  [["exec"], ["executive"]],
  [["sr"], ["senior"]],
];

/**
 * Two-word phrases are also registered reversed. Matching is order-independent
 * everywhere else, so an order-dependent rewrite pass would be the one place a
 * comma changed the answer — "Manager, Office" is the same job as "Office
 * Manager".
 */
const REWRITES_BY_LENGTH = (() => {
  const all = [...PHRASE_REWRITES];
  const seen = new Set(all.map(([phrase]) => phrase.join(" ")));
  for (const [phrase, replacement] of PHRASE_REWRITES) {
    if (phrase.length !== 2) continue;
    const reversed = [phrase[1], phrase[0]];
    const key = reversed.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    all.push([reversed, replacement]);
  }
  return all.sort((a, b) => b[0].length - a[0].length);
})();

/** Lowercase, drop possessives and punctuation, collapse whitespace. */
function tokenize(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // "C.F.O." and "C F O" arrive as separate letters once punctuation is
  // stripped. A run of two or more single letters is an abbreviation.
  const joined: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].length !== 1) {
      joined.push(tokens[i]);
      continue;
    }
    let end = i;
    while (end + 1 < tokens.length && tokens[end + 1].length === 1) end += 1;
    if (end > i) {
      joined.push(tokens.slice(i, end + 1).join(""));
      i = end;
    } else {
      joined.push(tokens[i]);
    }
  }

  return joined.filter((token) => !FILLER_TOKENS.has(token));
}

/**
 * Rewrite left to right, longest phrase first. Output tokens are not
 * re-examined, so a rewrite cannot chain into another one and the pass always
 * terminates.
 */
function applyRewrites(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const [phrase, replacement] of REWRITES_BY_LENGTH) {
      if (phrase.length > tokens.length - i) continue;
      let hit = true;
      for (let j = 0; j < phrase.length; j += 1) {
        if (tokens[i + j] !== phrase[j]) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;
      out.push(...replacement);
      i += phrase.length;
      matched = true;
      break;
    }
    if (!matched) {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}

/** The canonical token set for a title or a configured target. */
export function canonicalTitleTokens(
  value: string | null | undefined,
): Set<string> {
  if (!value) return new Set();
  return new Set(applyRewrites(tokenize(value)));
}

export type TitleMatch = "match" | "demoted" | "miss";

/**
 * Does `title` name the role `target` names?
 *
 * "match"   — every token the target requires is present, unqualified.
 * "demoted" — every token is present, but a qualifier says the holder is not
 *             the one (assistant, deputy, junior…).
 * "miss"    — the target asks for something the title does not say.
 */
export function matchTitleToTarget(
  title: string | null | undefined,
  target: string,
): TitleMatch {
  const targetTokens = canonicalTitleTokens(target);
  if (!targetTokens.size) return "miss";
  const titleTokens = canonicalTitleTokens(title);
  if (!titleTokens.size) return "miss";

  for (const token of targetTokens) {
    if (!titleTokens.has(token)) return "miss";
  }

  for (const token of titleTokens) {
    if (QUALIFIER_TOKENS.has(token) && !targetTokens.has(token)) {
      return "demoted";
    }
  }
  return "match";
}

/** No configured target describes this title at all. */
export const TITLE_RANK_UNMATCHED = 900;

/**
 * A title that names the role but is held by an assistant or deputy. Ranked
 * below the generic sector fallback on purpose: an unrecognised title with a
 * good sector rank is a better use of a reveal credit than the assistant to
 * the person we actually want.
 */
export const TITLE_RANK_DEMOTED_BASE = 300;

/**
 * Rank a title against a vertical's ordered target list. Lower is better.
 *
 * Total and deterministic: every title gets exactly one number, and when a
 * title matches more than one target — "President & CEO" matches both — the
 * earlier entry in the operator's list wins, so the same candidate set always
 * spends the credit on the same person.
 */
export function rankTitleAgainstTargets(
  title: string | null | undefined,
  targets: readonly string[],
): number {
  let demoted: number | null = null;
  for (let i = 0; i < targets.length; i += 1) {
    const verdict = matchTitleToTarget(title, targets[i]);
    if (verdict === "match") return i;
    if (verdict === "demoted" && demoted === null) {
      demoted = TITLE_RANK_DEMOTED_BASE + i;
    }
  }
  return demoted ?? TITLE_RANK_UNMATCHED;
}
