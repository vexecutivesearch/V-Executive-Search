/**
 * Anti-spam copy hygiene. Every drafted message passes this lint before it
 * can be stored. Hard failures reject the draft and force a redraft.
 *
 * Cold sends are plain text, link-free, image-free, with human capitalization,
 * no AI-tell phrasing, and NEVER dashes or hyphens (house style).
 * Template exemplar text is STYLE DNA for Claude, never mail-merge / never sent as-is.
 */

export type SanitizeResult = {
  ok: boolean;
  violations: string[];
  /** Body after safe normalizations (whitespace, smart quotes). */
  cleaned: string;
};

const LINK_PATTERN = /(https?:\/\/|www\.)\S+/i;
const HTML_TAG_PATTERN = /<[a-z][\s\S]*?>/i;
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)|<img\b/i;
/** ASCII hyphen-minus, non-breaking hyphen, figure dash, en/em/horizontal dashes, minus. */
const DASH_OR_HYPHEN = /[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/;
const PLACEHOLDER_PATTERNS = [
  /\[[^\]]{0,60}\]/, // [Name], [Company], [insert …]
  /\{\{[^}]*\}\}/, // {{first_name}}
  /\{[a-z_ ]{2,30}\}/i, // {company}
  /<[A-Z][A-Za-z ]{1,30}>/, // <Name>
  /\bXXX+\b/,
];

/** AI-tell + spam-trigger phrases (case-insensitive). */
const BANNED_PHRASES = [
  "as an ai",
  "i hope this email finds you well",
  "i hope this message finds you well",
  "i trust this email finds you",
  "delve into",
  "in today's fast-paced",
  "navigating the ever-evolving",
  "unlock the potential",
  "elevate your",
  "game changer",
  "cutting edge solutions",
  "seamlessly integrate",
  "furthermore,",
  "moreover,",
  "in conclusion",
  "leverage synergies",
  "synergy",
  "paradigm",
  "100% free",
  "act now",
  "limited time offer",
  "risk free",
  "no obligation",
  "money back guarantee",
  "click here",
  "click below",
  "buy now",
  "order now",
  "special promotion",
  "winner",
  "congratulations",
  "earn extra cash",
  "double your",
  "exclusive deal",
  "this is not spam",
  "unsubscribe",
];

export const EMAIL_BODY_MAX_CHARS = 1600;
export const EMAIL_BODY_MIN_CHARS = 200;
export const EMAIL_SUBJECT_MAX_CHARS = 80;
export const TEXT_BODY_MAX_CHARS = 420;
export const TEXT_BODY_MIN_CHARS = 40;

function normalize(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shoutingRatio(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) return 0;
  const shouting = words.filter(
    (w) => w === w.toUpperCase() && /[A-Z]{3,}/.test(w),
  );
  return shouting.length / words.length;
}

/** HTTPS/HTTP URLs may contain path hyphens (e.g. Calendly); strip before dash lint. */
const HTTPS_URL_PATTERN = /https?:\/\/\S+/gi;

function withoutHttpUrls(text: string): string {
  return text.replace(HTTPS_URL_PATTERN, " ");
}

/** ASCII hyphen plus every unicode dash, for the repair passes below. */
const ANY_DASH = "\\u002D\\u2010-\\u2015\\u2212";

/**
 * Rewrite dashes the way a human editor would, so the house style is reached by
 * repair rather than by rejection.
 *
 * The no dash rule is absolute, and some vocabularies are simply written with
 * hyphens: an ABA Therapy Assistant listing pulls "one-on-one", "full-time",
 * "RBT-certified" and "BCBA-supervised" out of the model no matter how the
 * prompt is worded. Rejecting those drafts does not cost one sentence, it costs
 * the whole enrollment, because drafting is transactional: the first step that
 * cannot come back clean after its retries takes the entire sequence with it,
 * and the recruiter is left with a lead on the Call List that never sends.
 *
 * The lint still owns the guarantee. This only removes the reason a draft would
 * trip it, and it leaves http(s) URLs alone because a Calendly path keeps its
 * hyphens.
 */
export function repairDashes(text: string): string {
  const urls: string[] = [];
  const parked = (text ?? "").replace(HTTPS_URL_PATTERN, (url) => {
    urls.push(url);
    return `__URL_${urls.length - 1}__`;
  });
  const repaired = parked
    // A range is read out as words: "9 to 5", "$80,000 to $100,000".
    .replace(
      new RegExp(`(\\d)\\s*[${ANY_DASH}]\\s*([$£€]?\\d)`, "g"),
      "$1 to $2",
    )
    // A leading dash is a bullet, and plain text outreach has no bullets.
    .replace(new RegExp(`^[ \\t]*[${ANY_DASH}]+[ \\t]+`, "gm"), "")
    // A dash with air around it separates clauses, which is a comma here.
    .replace(new RegExp(`[ \\t]*[${ANY_DASH}]+[ \\t]+`, "g"), ", ")
    .replace(new RegExp(`[ \\t]+[${ANY_DASH}]+[ \\t]*`, "g"), ", ")
    // A dash inside a word is a compound, which loses the hyphen entirely.
    .replace(new RegExp(`(\\w)[${ANY_DASH}](\\w)`, "g"), "$1 $2")
    .replace(new RegExp(`[${ANY_DASH}]`, "g"), " ")
    .replace(/ ,/g, ",")
    .replace(/,(\s*,)+/g, ",")
    .replace(/[ \t]{2,}/g, " ");
  return repaired.replace(/__URL_(\d+)__/g, (_, i) => urls[Number(i)] ?? "");
}

function pushDashViolation(violations: string[], text: string) {
  if (DASH_OR_HYPHEN.test(text)) {
    violations.push(
      "contains a dash or hyphen (rewrite with commas or spaces; never use -, –, or —)",
    );
  }
}

export function sanitizeOutreachBody(
  body: string,
  options: {
    channel: "email" | "imessage";
    /** Links allowed only for established-thread replies (never cold). */
    allowLinks?: boolean;
  },
): SanitizeResult {
  const violations: string[] = [];
  const cleaned = normalize(body ?? "");

  if (!cleaned) {
    return { ok: false, violations: ["empty body"], cleaned };
  }

  if (!options.allowLinks && LINK_PATTERN.test(cleaned)) {
    violations.push("contains a link; cold sends must be link-free");
  }
  if (HTML_TAG_PATTERN.test(cleaned)) {
    violations.push("contains HTML; plain text only");
  }
  if (IMAGE_PATTERN.test(cleaned)) {
    violations.push("contains an image reference");
  }
  // When links are allowed, ignore hyphens inside https:// URLs (Calendly paths, etc.).
  pushDashViolation(
    violations,
    options.allowLinks ? withoutHttpUrls(cleaned) : cleaned,
  );
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(cleaned)) {
      violations.push(`unresolved placeholder (${pattern.source})`);
      break;
    }
  }

  const lower = cleaned.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      violations.push(`banned phrase: "${phrase}"`);
    }
  }

  if (shoutingRatio(cleaned) > 0.1) {
    violations.push("too much ALL-CAPS shouting");
  }
  if ((cleaned.match(/!/g)?.length ?? 0) > 2) {
    violations.push("too many exclamation marks");
  }

  const max = options.channel === "email" ? EMAIL_BODY_MAX_CHARS : TEXT_BODY_MAX_CHARS;
  const min = options.channel === "email" ? EMAIL_BODY_MIN_CHARS : TEXT_BODY_MIN_CHARS;
  if (cleaned.length > max) {
    violations.push(`too long (${cleaned.length} > ${max} chars)`);
  }
  if (cleaned.length < min) {
    violations.push(`too short (${cleaned.length} < ${min} chars)`);
  }

  return { ok: violations.length === 0, violations, cleaned };
}

export function sanitizeSubject(subject: string): SanitizeResult {
  const violations: string[] = [];
  const cleaned = normalize(subject ?? "").replace(/\n+/g, " ");

  if (!cleaned) return { ok: false, violations: ["empty subject"], cleaned };
  if (cleaned.length > EMAIL_SUBJECT_MAX_CHARS) {
    violations.push(`subject too long (${cleaned.length} > ${EMAIL_SUBJECT_MAX_CHARS})`);
  }
  if (LINK_PATTERN.test(cleaned)) violations.push("subject contains a link");
  pushDashViolation(violations, cleaned);
  if (/re:|fwd:/i.test(cleaned)) {
    violations.push("fake RE:/FWD: subject prefix");
  }
  const lower = cleaned.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) violations.push(`banned phrase: "${phrase}"`);
  }
  if (cleaned === cleaned.toUpperCase() && /[A-Z]{3,}/.test(cleaned)) {
    violations.push("all-caps subject");
  }
  if ((cleaned.match(/!/g)?.length ?? 0) > 0) {
    violations.push("exclamation mark in subject");
  }
  return { ok: violations.length === 0, violations, cleaned };
}

/**
 * Prompt-injection hygiene: exemplar/template text is wrapped as inert data.
 * Also strips dashes so few-shots never teach the model hyphenated copy,
 * while preserving https:// URLs (scheduling links in reply exemplars).
 */
export function sanitizeExemplarForPrompt(text: string, maxChars = 2400): string {
  const cleaned = normalize(text ?? "")
    .replace(/```/g, "'''")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^\s*(system|assistant|user)\s*:/gim, "[$1]")
    .replace(
      /\b(ignore|disregard|forget)\b[\w\s,]{0,40}\b(instructions?|prompts?|rules?)\b[^.\n]*/gi,
      "[removed]",
    );
  // Same repair the drafts get, so no few-shot ever teaches hyphenated copy.
  return repairDashes(cleaned).slice(0, maxChars);
}
