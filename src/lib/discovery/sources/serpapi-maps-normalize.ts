/**
 * Google Maps (SerpApi `engine=google_maps`) → `DiscoveredOrganization`.
 *
 * PURE. No network, no DB, no env. Every branch here is a decision made before
 * a single Apollo or ContactOut credit exists, which is the point: the free
 * qualification layer is where the operator's exclusion list gets enforced, on
 * SERP-level data only.
 *
 * Two things Maps gives us that Apollo often does not, for the small local
 * firms this pipeline targets:
 *   - a published main line (`phone`), which is a business_line by definition
 *     and therefore dialable under the existing phone-classification gates;
 *   - the owner's own Google Business category (`type` / `types`), which is a
 *     better staffing-agency detector than a name regex, because Google makes
 *     recruiters label themselves "Employment agency".
 *
 * One thing it never gives us: headcount. Every company from this source lands
 * with `estimatedEmployees: null`, which is exactly the `unknown_size` pool the
 * discovery pipeline already reserves a share of the batch for.
 */

import { companyNameKeyStrength, normalizeCompanyKey } from "@/lib/company-name";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";
import { getIcpConfig, type IcpConfig } from "@/lib/icp/icp-config";
import { parseJobLocation } from "@/lib/location-match";
import { isDialablePhone } from "@/lib/phone-utils";

/** The subset of a SerpApi `local_results[]` entry this module reads. */
export type MapsLocalResult = {
  title?: string;
  address?: string;
  phone?: string;
  website?: string;
  type?: string;
  types?: string[];
  rating?: number;
  reviews?: number;
  place_id?: string;
  data_cid?: string;
};

export type MapsRejectionReason =
  | "no_name"
  | "staffing_agency"
  | "public_sector"
  | "school"
  | "hospital_system"
  | "known_large"
  | "not_an_employer"
  | "out_of_market"
  | "duplicate_in_batch";

export type MapsNormalizeOptions = {
  /**
   * Two-letter state the run asked for. A Maps result outside it is dropped:
   * SerpApi's own docs warn results are "not guaranteed to be within the
   * requested geographic location", and a Dallas run must not quietly bill for
   * Oklahoma companies.
   */
  marketState: string | null;
  config?: IcpConfig;
};

export type MapsNormalizeResult =
  | { ok: true; organization: DiscoveredOrganization }
  | { ok: false; reason: MapsRejectionReason };

/* ------------------------------------------------------------------ */
/* Website / domain                                                     */
/* ------------------------------------------------------------------ */

/**
 * Hosts that are never a company's own domain.
 *
 * This is the highest-severity trap in the whole source. Maps `website` is
 * whatever the owner typed into their Business Profile, and for small firms
 * that is routinely a Facebook page, an Instagram profile (SerpApi's own
 * documented example returns `instagram.com/currentcoffeeshop`), a Linktree or
 * a directory listing. `companies.domain` is UNIQUE, so accepting `facebook.com`
 * as a domain would let the first Facebook-hosted company claim it and silently
 * merge every subsequent one into that single row.
 *
 * Matched on the registrable tail, so `m.facebook.com` and `business.site`
 * subdomains are caught too.
 */
const NON_COMPANY_HOSTS: readonly string[] = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "nextdoor.com",
  "yelp.com",
  "yellowpages.com",
  "bbb.org",
  "angi.com",
  "angieslist.com",
  "homeadvisor.com",
  "thumbtack.com",
  "houzz.com",
  "porch.com",
  "avvo.com",
  "justia.com",
  "findlaw.com",
  "lawyers.com",
  "martindale.com",
  "google.com",
  "business.site",
  "sites.google.com",
  "linktr.ee",
  "wixsite.com",
  "squarespace.com",
  "weebly.com",
  "godaddysites.com",
  "wordpress.com",
  "blogspot.com",
  "yola.site",
  "webnode.page",
];

/** Bare host, lowercased, `www.` and any port/path/query/fragment removed. */
export function normalizeWebsiteHost(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  // Cheap and dependency-free: strip scheme, then everything from the first
  // path/query/fragment separator. `new URL()` throws on the bare hosts Maps
  // sometimes returns ("example.com/contact"), so it is not used here.
  let host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  host = host.split(/[/?#]/)[0];
  host = host.split("@").pop() ?? host;
  host = host.split(":")[0];
  host = host.trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host || !host.includes(".") || /\s/.test(host)) return null;
  return host;
}

export function isNonCompanyHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return NON_COMPANY_HOSTS.some(
    (bad) => host === bad || host.endsWith(`.${bad}`),
  );
}

/**
 * Domain to dedupe and store on, or null when the profile links somewhere that
 * is not the company's own site. Null is a normal, expected outcome — such a
 * company is still kept, it just dedupes on name alone.
 */
export function mapsDomain(raw: string | null | undefined): string | null {
  const host = normalizeWebsiteHost(raw);
  if (!host || isNonCompanyHost(host)) return null;
  return host;
}

/* ------------------------------------------------------------------ */
/* Address → city / state                                              */
/* ------------------------------------------------------------------ */

/**
 * Maps `address` is one string, in practice one of:
 *   "18 W 29th St, New York, NY 10001, United States"
 *   "13200 Pond Springs Rd # D30, Austin, TX 78729, United States"
 *   "555 Aleen St, Houston, TX 77029"
 *   "51 Rainey St #130"                         (street only — no city/state)
 *
 * The state segment is the anchor: find the trailing "ST 12345" / "ST" part and
 * take the segment before it as the city. Reusing `parseJobLocation` on the
 * "City, ST" tail keeps state normalisation identical to every other location
 * path in the app.
 */
export function parseMapsAddress(
  address: string | null | undefined,
): { city: string | null; state: string | null } {
  const raw = (address ?? "").trim();
  if (!raw) return { city: null, state: null };

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return { city: null, state: null };

  if (/^(united states|usa|us)$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 2) return { city: null, state: null };

  const tail = parts[parts.length - 1];
  // "NY 10001", "TX", "NY 10001-2345"
  const match = tail.match(/^([A-Za-z][A-Za-z .]*?)\s*(\d{5}(?:-\d{4})?)?$/);
  if (!match) return { city: null, state: null };

  const parsed = parseJobLocation(`${parts[parts.length - 2]}, ${match[1].trim()}`);
  if (!parsed?.stateAbbr) return { city: null, state: null };
  return { city: parsed.city ?? null, state: parsed.stateAbbr };
}

/** Two-letter state a market string targets, e.g. "Dallas, Texas" → "TX". */
export function marketStateAbbr(market: string | null | undefined): string | null {
  const raw = (market ?? "").trim();
  if (!raw) return null;
  const direct = parseJobLocation(raw);
  if (direct?.stateAbbr) return direct.stateAbbr;
  // "Palm Beach County, Florida" — parseJobLocation reads the state from the
  // second segment, which is the same position here, so a null means the
  // market names no state we recognise.
  return null;
}

/* ------------------------------------------------------------------ */
/* Category / industry                                                  */
/* ------------------------------------------------------------------ */

/**
 * Google Business categories that are not an employer worth reviewing. Matched
 * against the whole category list, not the name, because the category is the
 * owner's own declaration.
 */
const NON_EMPLOYER_CATEGORIES: readonly string[] = [
  "atm",
  "post office",
  "park",
  "parking",
  "public toilet",
  "bus stop",
  "train station",
  "cemetery",
  "place of worship",
  "church",
  "tourist attraction",
  "historical landmark",
  "storage facility",
  "self-storage facility",
  "vending machine",
  "gas station",
  "notary public",
  "virtual office",
  "coworking space",
  "office space rental agency",
];

/**
 * Categories that mean "this business sells recruiting", i.e. a competitor or a
 * third-party poster rather than a client. Google's own taxonomy is a far
 * stronger signal than a name regex — plenty of agencies are named after their
 * founder and would sail past `staffing_patterns`.
 */
const RECRUITING_CATEGORIES: readonly string[] = [
  "employment agency",
  "employment consultant",
  "temp agency",
  "temporary employment agency",
  "recruiter",
  "executive search firm",
  "staffing agency",
  "job center",
  "employment center",
  "career guidance service",
  "outplacement",
];

const GOVERNMENT_CATEGORIES: readonly string[] = [
  "local government office",
  "city government office",
  "county government office",
  "state government office",
  "federal government office",
  "government office",
  "city hall",
  "courthouse",
  "police department",
  "fire station",
  "sheriff",
  "public works",
  "department of motor vehicles",
];

const EDUCATION_CATEGORIES: readonly string[] = [
  "public school",
  "elementary school",
  "middle school",
  "high school",
  "school district office",
  "university",
  "college",
  "community college",
  "school board",
];

const HOSPITAL_CATEGORIES: readonly string[] = [
  "hospital",
  "general hospital",
  "medical center",
  "children's hospital",
  "university hospital",
];

export function mapsCategories(result: MapsLocalResult): string[] {
  const list = [result.type ?? "", ...(result.types ?? [])];
  return list
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function categoryMatches(
  categories: string[],
  needles: readonly string[],
): boolean {
  return categories.some((category) =>
    needles.some((needle) => category === needle || category.includes(needle)),
  );
}

/** Human-readable industry: Maps' primary category. */
export function mapsIndustry(result: MapsLocalResult): string | null {
  const primary = result.type?.trim() || result.types?.[0]?.trim();
  return primary || null;
}

/* ------------------------------------------------------------------ */
/* Exclusions                                                           */
/* ------------------------------------------------------------------ */

function anyPattern(value: string, patterns: string[]): boolean {
  const v = value.toLowerCase();
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(v);
    } catch {
      return false;
    }
  });
}

function matchesKnownList(name: string, list: string[]): boolean {
  const normalized = normalizeCompanyKey(name);
  if (!normalized) return false;
  return list.some((entry) => normalizeCompanyKey(entry) === normalized);
}

/**
 * The operator's exclusion list, enforced on SERP data alone, before insert.
 *
 * Name patterns are shared with `icp-scorer` via `config/icp-config.json` so
 * there is exactly one place to edit and the two paths cannot drift. The Maps
 * category check is additional signal that path does not have.
 *
 * These are hard rejections rather than the ICP module's flag-and-keep, because
 * they are not "low quality" — they are the wrong kind of entity. A city hall
 * or a rival search firm is never going to become a client, and carrying it
 * into the review queue only costs the operator attention.
 */
export function classifyMapsExclusion(
  result: MapsLocalResult,
  options: { config?: IcpConfig } = {},
): MapsRejectionReason | null {
  const config = options.config ?? getIcpConfig();
  const name = (result.title ?? "").trim();
  if (!name) return "no_name";

  const categories = mapsCategories(result);
  const host = normalizeWebsiteHost(result.website);

  if (
    categoryMatches(categories, RECRUITING_CATEGORIES) ||
    matchesKnownList(name, config.known_lists.known_staffing_agencies) ||
    anyPattern(name, config.patterns.staffing_patterns)
  ) {
    return "staffing_agency";
  }

  if (
    categoryMatches(categories, GOVERNMENT_CATEGORIES) ||
    anyPattern(name, config.patterns.gov_patterns) ||
    (host != null && /\.(gov|mil)$/i.test(host))
  ) {
    return "public_sector";
  }

  if (
    categoryMatches(categories, EDUCATION_CATEGORIES) ||
    anyPattern(name, config.patterns.school_patterns)
  ) {
    return "school";
  }

  if (
    categoryMatches(categories, HOSPITAL_CATEGORIES) ||
    anyPattern(name, config.patterns.hospital_system_patterns) ||
    matchesKnownList(name, config.known_lists.known_large_hospitals)
  ) {
    return "hospital_system";
  }

  if (
    matchesKnownList(name, config.known_lists.fortune_500) ||
    matchesKnownList(name, config.known_lists.fortune_1000) ||
    matchesKnownList(name, config.known_lists.known_large_private) ||
    matchesKnownList(name, config.known_lists.national_retailers)
  ) {
    return "known_large";
  }

  if (categoryMatches(categories, NON_EMPLOYER_CATEGORIES)) {
    return "not_an_employer";
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                        */
/* ------------------------------------------------------------------ */

export function normalizeMapsResult(
  result: MapsLocalResult,
  options: MapsNormalizeOptions,
): MapsNormalizeResult {
  const rejection = classifyMapsExclusion(result, { config: options.config });
  if (rejection) return { ok: false, reason: rejection };

  const name = (result.title ?? "").trim();
  const { city, state } = parseMapsAddress(result.address);

  // An unparseable address is kept: the run already scoped the search to the
  // market, so a missing state is missing data rather than evidence of drift.
  // A state that disagrees IS evidence, and is dropped.
  if (options.marketState && state && state !== options.marketState) {
    return { ok: false, reason: "out_of_market" };
  }

  const domain = mapsDomain(result.website);
  const rawPhone = (result.phone ?? "").trim();

  return {
    ok: true,
    organization: {
      name,
      domain,
      websiteUrl: result.website?.trim() || null,
      industry: mapsIndustry(result),
      // Maps has no headcount, ever. This lands the company in the pipeline's
      // existing unknown-size pool rather than pretending to a number.
      estimatedEmployees: null,
      phone: isDialablePhone(rawPhone) ? rawPhone : null,
      // No LinkedIn engine exists at SerpApi and we do not scrape LinkedIn.
      linkedinUrl: null,
      foundedYear: null,
      city,
      state,
      // The domain came out of the owner's own Business Profile, not a name
      // guess, so it is as high-confidence as Apollo's primary_domain.
      domainConfidence: domain ? "high" : "low",
      // Maps has no revenue or ticker. Null, not omitted: quantify fills these
      // in from Apollo, and the exclusion gate must be able to tell "not
      // looked up" from a missing key.
      annualRevenue: null,
      publiclyTradedSymbol: null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* In-batch dedupe                                                      */
/* ------------------------------------------------------------------ */

/**
 * Google itself returns duplicates — an old unclaimed profile beside the
 * claimed one, and the same firm once per office. Collapsing on domain and on
 * normalised name matches how `run.ts` dedupes against the database, so a
 * batch cannot contain two rows that would then fight over the same UNIQUE
 * domain on insert.
 *
 * The name leg honours `companyNameKeyStrength` for the same reason `run.ts`
 * does: the suffix stripper reduces "Smith Group" and "Smith Holdings" both to
 * "smith", and merging on that would silently discard a real company. Being
 * stricter here than the database dedupe would also be an outright bug — this
 * pass can only drop rows, and a row it drops never gets the chance to be
 * matched properly downstream.
 *
 * `seenKeys` lets a caller carry keys across pages of one sweep.
 */
export function dedupeMapsOrganizations(
  organizations: DiscoveredOrganization[],
  seenKeys: Set<string> = new Set(),
): { organizations: DiscoveredOrganization[]; duplicates: number } {
  const out: DiscoveredOrganization[] = [];
  let duplicates = 0;

  for (const org of organizations) {
    const keys: string[] = [];
    if (org.domain) keys.push(`domain:${org.domain}`);
    if (companyNameKeyStrength(org.name) === "strong") {
      const nameKey = normalizeCompanyKey(org.name);
      // Same name in two different states is two businesses (franchises), so
      // the name key is scoped by state when we have one.
      if (nameKey) keys.push(`name:${nameKey}|${org.state ?? ""}`);
    }

    // No usable key: keep it. It cannot be deduped here, but dropping a real
    // company to avoid a duplicate the operator can see and reject is the worse
    // trade.
    if (!keys.length) {
      out.push(org);
      continue;
    }

    if (keys.some((key) => seenKeys.has(key))) {
      duplicates += 1;
      continue;
    }
    for (const key of keys) seenKeys.add(key);
    out.push(org);
  }

  return { organizations: out, duplicates };
}

/**
 * One page of `local_results` → keepers, plus a per-reason rejection tally for
 * the run summary.
 */
export function normalizeMapsPage(
  results: MapsLocalResult[],
  options: MapsNormalizeOptions & { seenKeys?: Set<string> },
): {
  organizations: DiscoveredOrganization[];
  rejected: Record<string, number>;
} {
  const rejected: Record<string, number> = {};
  const bump = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  const kept: DiscoveredOrganization[] = [];
  for (const result of results) {
    const normalized = normalizeMapsResult(result, options);
    if (!normalized.ok) {
      bump(normalized.reason);
      continue;
    }
    kept.push(normalized.organization);
  }

  const deduped = dedupeMapsOrganizations(kept, options.seenKeys);
  if (deduped.duplicates) {
    rejected.duplicate_in_batch =
      (rejected.duplicate_in_batch ?? 0) + deduped.duplicates;
  }

  return { organizations: deduped.organizations, rejected };
}
