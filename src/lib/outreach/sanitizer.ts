/**
 * Anti-spam copy hygiene — every drafted message passes this lint before it
 * can be stored. Hard failures (links, placeholders, banned phrases) reject
 * the draft and force a redraft; drafting is transactional so a failed step
 * means no enrollment.
 *
 * Cold sends are plain text, link-free, image-free, with human capitalization
 * and no AI-tell phrasing. Template exemplar text is DATA, never executable.
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
const PLACEHOLDER_PATTERNS = [
  /\[[^\]]{0,60}\]/, // [Name], [Company], [insert …]
  /\{\{[^}]*\}\}/, // {{first_name}}
  /\{[a-z_ ]{2,30}\}/i, // {company}
  /<[A-Z][A-Za-z ]{1,30}>/, // <Name>
  /\bXXX+\b/,
];

/** AI-tell + spam-trigger phrases (case-insensitive). */
const BANNED_PHRASES = [
  // AI tells
  "as an ai",
  "i hope this email finds you well",
  "i hope this message finds you well",
  "i trust this email finds you",
  "delve into",
  "in today's fast-paced",
  "navigating the ever-evolving",
  "unlock the potential",
  "elevate your",
  "game-changer",
  "cutting-edge solutions",
  "seamlessly integrate",
  "furthermore,",
  "moreover,",
  "in conclusion",
  "leverage synergies",
  "synergy",
  "paradigm",
  // spam triggers
  "100% free",
  "act now",
  "limited time offer",
  "risk-free",
  "no obligation",
  "money-back guarantee",
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
  "unsubscribe", // cold intro copy should not fake list language
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
    .replace(/\u2014/g, "—")
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
    violations.push("contains a link — cold sends must be link-free");
  }
  if (HTML_TAG_PATTERN.test(cleaned)) {
    violations.push("contains HTML — plain text only");
  }
  if (IMAGE_PATTERN.test(cleaned)) {
    violations.push("contains an image reference");
  }
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
 * Strips anything that looks like an instruction to the model and hard-caps
 * length so a pasted wall of text can't take over the prompt.
 */
export function sanitizeExemplarForPrompt(text: string, maxChars = 2400): string {
  const cleaned = normalize(text ?? "")
    .replace(/```/g, "'''")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^\s*(system|assistant|user)\s*:/gim, "$1 -")
    .replace(/\b(ignore|disregard|forget)\b[\w\s,]{0,40}\b(instructions?|prompts?|rules?)\b[^.\n]*/gi, "[removed]");
  return cleaned.slice(0, maxChars);
}
