/**
 * Curated enterprise / staffing domains — a SUPPLEMENT to the structural
 * signals in `exclusion-gate.ts`, never the load-bearing rule.
 *
 * Why domains and not names: the case employee count cannot catch is a large
 * corporation's regional office or subsidiary, which reports a small local
 * headcount and often carries a local name ("Aerotek — Boca Raton",
 * "Deloitte Tax LLP"). What it almost always keeps is the parent's web domain,
 * so a domain match survives naming that a name-list match misses.
 *
 * MAINTENANCE
 * - Add the registrable domain only (`aerotek.com`, not `www.aerotek.com/fl`).
 *   Subdomains are matched automatically, so `careers.aerotek.com` is covered.
 * - Add an entry only when the domain is unambiguously an enterprise or a
 *   staffing/recruiting firm. A domain here is a hard reject with no size
 *   check, so a wrong entry silently removes a legitimate target forever.
 * - Do NOT grow this into a full Fortune 500 transcription. Companies at that
 *   scale are already caught by the publicly-traded ticker and revenue rules;
 *   this list exists for the ones those rules miss (private giants, staffing
 *   firms, and subsidiaries whose own record carries no revenue).
 * - `config/icp-config.json` holds the parallel NAME lists used by the ICP
 *   annotator. The two are intentionally separate: that one deprioritises for
 *   scoring, this one hard-rejects at discovery.
 */

/** Publicly traded or private giants whose local offices look small. */
const ENTERPRISE_DOMAINS = [
  // Professional services / accounting — the Big Four run local offices.
  "deloitte.com",
  "pwc.com",
  "ey.com",
  "kpmg.com",
  "kpmg.us",
  "accenture.com",
  "mckinsey.com",
  "bain.com",
  "bcg.com",
  "rsmus.com",
  "bdo.com",
  "grantthornton.com",
  "crowe.com",
  "cbiz.com",
  "cohnreznick.com",
  "marcumllp.com",
  "eisneramper.com",
  "aprio.com",
  "citrincooperman.com",
  "wipfli.com",
  "plantemoran.com",
  // Global law firms — local offices, national recruiting departments.
  "dlapiper.com",
  "bakermckenzie.com",
  "nortonrosefulbright.com",
  "hoganlovells.com",
  "lw.com",
  "kirkland.com",
  "sidley.com",
  "skadden.com",
  "gtlaw.com",
  "hklaw.com",
  "akerman.com",
  "shutts.com",
  "carltonfields.com",
  "jonesday.com",
  "morganlewis.com",
  "reedsmith.com",
  "squirepattonboggs.com",
  "littler.com",
  "ogletree.com",
  "jacksonlewis.com",
  "seyfarth.com",
  // Engineering / construction majors.
  "aecom.com",
  "jacobs.com",
  "bechtel.com",
  "fluor.com",
  "kiewit.com",
  "turnerconstruction.com",
  "skanska.com",
  "clarkconstruction.com",
  "mortenson.com",
  "dpr.com",
  "hensel-phelps.com",
  "suffolk.com",
  "whiting-turner.com",
  "gilbaneco.com",
  "mccarthy.com",
  "balfourbeattyus.com",
  "emcorgroup.com",
  "comfortsystemsusa.com",
  "quantaservices.com",
  "myrgroup.com",
  "abm.com",
  "servicemaster.com",
  "servpro.com",
  "belfor.com",
  // Diversified private giants.
  "kochind.com",
  "cargill.com",
  "mars.com",
  "publix.com",
  "hy-vee.com",
  "pilotthomaslogistics.com",
  "enterpriseholdings.com",
  "berkshirehathaway.com",
];

/** Staffing, recruiting, RPO, and PEO — the operator's own competitive set. */
const STAFFING_DOMAINS = [
  "roberthalf.com",
  "aerotek.com",
  "actalentservices.com",
  "teksystems.com",
  "allegisgroup.com",
  "kforce.com",
  "insightglobal.com",
  "vaco.com",
  "randstad.com",
  "randstadusa.com",
  "adecco.com",
  "adeccogroup.com",
  "manpower.com",
  "manpowergroup.com",
  "experis.com",
  "kellyservices.com",
  "hays.com",
  "michaelpage.com",
  "pagegroup.com",
  "hudsonrpo.com",
  "kornferry.com",
  "heidrick.com",
  "spencerstuart.com",
  "russellreynolds.com",
  "egonzehnder.com",
  "lhh.com",
  "cybercoders.com",
  "aptask.com",
  "collabera.com",
  "apexsystems.com",
  "modis.com",
  "volt.com",
  "spherion.com",
  "expresspros.com",
  "trueblue.com",
  "peopleready.com",
  "laborfinders.com",
  "adia.works",
  "gpac.com",
  "lucasgroup.com",
  "addisongroup.com",
  "creativefinancialstaffing.com",
  "beaconhillstaffing.com",
  "ajilon.com",
  "adp.com",
  "trinet.com",
  "insperity.com",
  "paychex.com",
  "justworks.com",
];

const ALL = new Set(
  [...ENTERPRISE_DOMAINS, ...STAFFING_DOMAINS].map((d) => d.toLowerCase()),
);

const STAFFING_ONLY = new Set(STAFFING_DOMAINS.map((d) => d.toLowerCase()));

export type EnterpriseDomainMatch = {
  domain: string;
  kind: "enterprise" | "staffing";
};

/** Strip protocol, `www.`, path, and port down to a bare host. */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0]
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return host || null;
}

/**
 * Match a host or any of its parent domains. `careers.aerotek.com` and
 * `aerotek.com` both hit the `aerotek.com` entry; `myaerotek.com` does not,
 * because only whole labels are dropped.
 */
export function matchEnterpriseDomain(
  rawDomain: string | null | undefined,
): EnterpriseDomainMatch | null {
  const host = normalizeHost(rawDomain);
  if (!host) return null;
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join(".");
    if (ALL.has(candidate)) {
      return {
        domain: candidate,
        kind: STAFFING_ONLY.has(candidate) ? "staffing" : "enterprise",
      };
    }
  }
  return null;
}

export function enterpriseDomainCount(): number {
  return ALL.size;
}
