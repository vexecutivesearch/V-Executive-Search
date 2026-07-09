const APOLLO_BASE = "https://api.apollo.io/api/v1";

export type DomainConfidence = "high" | "low";

function apolloHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key": apiKey,
  };
}

function guessDomain(companyName: string): string | null {
  const cleaned = companyName
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(
      /\b(inc|incorporated|llc|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b/gi,
      "",
    )
    .trim()
    .replace(/\s+/g, "");
  if (cleaned.length < 2) return null;
  return `${cleaned}.com`;
}

function normalizeDomain(raw: string): string {
  let domain = raw.replace(/^https?:\/\//, "").split("/")[0];
  if (domain.startsWith("www.")) domain = domain.slice(4);
  return domain.toLowerCase();
}

export async function resolveCompanyDomain(
  companyName: string,
  apiKey: string,
): Promise<{ domain: string | null; confidence: DomainConfidence }> {
  if (!apiKey) {
    const guess = guessDomain(companyName);
    return { domain: guess, confidence: "low" };
  }

  try {
    const resp = await fetch(`${APOLLO_BASE}/mixed_companies/search`, {
      method: "POST",
      headers: apolloHeaders(apiKey),
      body: JSON.stringify({
        q_organization_name: companyName,
        page: 1,
        per_page: 1,
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const data = (await resp.json()) as {
      organizations?: Array<{ primary_domain?: string; website_url?: string }>;
      accounts?: Array<{ primary_domain?: string; website_url?: string }>;
    };
    const orgs = data.organizations ?? data.accounts ?? [];
    const raw = orgs[0]?.primary_domain ?? orgs[0]?.website_url;
    if (raw) {
      return { domain: normalizeDomain(raw), confidence: "high" };
    }
  } catch {
    // fall through to guess
  }

  const guess = guessDomain(companyName);
  return { domain: guess, confidence: "low" };
}
