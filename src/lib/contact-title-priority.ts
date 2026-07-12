/** Lower = better outreach target. >= 900 = excluded from enrichment. */
const EXCLUDED_TITLE_PATTERNS = [
  /\bbilling\b/,
  /\bbookkeeper\b/,
  /\baccounts payable\b/,
  /\breceptionist\b/,
  /\bfront desk\b/,
  /\boptician\b/,
  /\boptical\b(?:\s|$)/,
  /\b(?:^|\s)maid\b/,
  /\bcleaner\b/,
  /\bhousekeeper\b/,
  /\bgroomer\b/,
  /\bvet tech\b/,
  /\btechnician\b/,
  /\bnurse\b(?!.*(?:director|manager|hr|human resources))/,
  /\bsales associate\b/,
  /\bcashier\b/,
  /\bintern\b/,
  /\bassistant\b(?!.*(?:executive|office|hr|human resources))/,
];

const TITLE_PRIORITY: Array<[RegExp, number]> = [
  [/\bchro\b/, 0],
  [/\bchief people\b/, 0],
  [/\bchief human resources\b/, 0],
  [/\bvp (?:of )?(?:people|human resources|hr|talent)\b/, 1],
  [/\bhead of (?:people|human resources|hr|talent)\b/, 2],
  [/\bhr director\b/, 3],
  [/\bdirector of human resources\b/, 3],
  [/\bdirector of people\b/, 3],
  [/\bhuman resources director\b/, 3],
  [/\b(?:^|\s)hr manager\b/, 4],
  [/\bhuman resources manager\b/, 4],
  [/\bpeople operations\b/, 5],
  [/\btalent acquisition\b/, 5],
  [/\brecruiting manager\b/, 5],
  [/\b(?:^|\s)hr\b/, 6],
  [/\bhuman resources\b/, 6],
  [/\btalent\b/, 7],
  [/\brecruiting\b/, 7],
  [/\bchief executive\b/, 10],
  [/\b(?:^|\s)ceo\b/, 10],
  [/\bpresident\b/, 11],
  [/\bfounder\b/, 12],
  [/\bco-founder\b/, 12],
  [/\bowner\b/, 13],
  [/\bmanaging director\b/, 14],
  [/\bgeneral manager\b/, 15],
  [/\bpractice manager\b/, 16],
  [/\boffice manager\b/, 17],
  [/\boperations manager\b/, 18],
  [/\bchief operating\b/, 19],
  [/\b(?:^|\s)coo\b/, 19],
  [/\bchief financial\b/, 20],
  [/\b(?:^|\s)cfo\b/, 20],
  [/\bexecutive director\b/, 21],
  [/\bvp\b/, 22],
  [/\bvice president\b/, 22],
  [/\bdirector\b/, 25],
  [/\bmanager\b/, 30],
  [/\bsupervisor\b/, 35],
];

export function isExcludedContactTitle(title: string | null | undefined): boolean {
  const lower = (title ?? "").trim().toLowerCase();
  if (!lower) return false;
  return EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(lower));
}

/** Rank HR and executives above general staff; 999 = excluded. */
export function contactTitlePriority(title: string | null | undefined): number {
  const lower = (title ?? "").trim().toLowerCase();
  if (!lower) return 80;
  if (isExcludedContactTitle(lower)) return 999;
  for (const [pattern, rank] of TITLE_PRIORITY) {
    if (pattern.test(lower)) return rank;
  }
  return 60;
}

export function emailMatchesCompanyDomain(
  email: string | null | undefined,
  domain: string,
): boolean {
  if (!email || !domain) return false;
  const normalizedDomain = domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  return email.toLowerCase().endsWith(`@${normalizedDomain}`);
}

export function compareContactsForOutreach(
  a: { title?: string | null; locationMatched?: boolean | null },
  b: { title?: string | null; locationMatched?: boolean | null },
): number {
  const titleDiff =
    contactTitlePriority(a.title) - contactTitlePriority(b.title);
  if (titleDiff !== 0) return titleDiff;
  if (a.locationMatched !== b.locationMatched) {
    return a.locationMatched ? -1 : 1;
  }
  return 0;
}
