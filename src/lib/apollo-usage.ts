const APOLLO_USAGE_URL =
  "https://api.apollo.io/api/v1/usage_stats/api_usage_stats";

export type ApolloEndpointUsage = {
  day: { limit: number; consumed: number; left_over: number };
  hour: { limit: number; consumed: number; left_over: number };
  minute: { limit: number; consumed: number; left_over: number };
};

export type ApolloUsageReport = {
  organizationsSearch: ApolloEndpointUsage | null;
  mixedCompaniesSearch: ApolloEndpointUsage | null;
  organizationsEnrich: ApolloEndpointUsage | null;
  /** Apollo docs: organization search may consume credits per page when results return. */
  creditWarning: string;
};

function pickUsage(
  data: Record<string, ApolloEndpointUsage>,
  endpoint: string,
  action: string,
): ApolloEndpointUsage | null {
  const key = `["${endpoint}", "${action}"]`;
  return data[key] ?? null;
}

/** POST usage_stats — does not consume credits. Requires API key. */
export async function fetchApolloApiUsage(
  apiKey: string,
): Promise<ApolloUsageReport> {
  const resp = await fetch(APOLLO_USAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({}),
  });

  if (!resp.ok) {
    throw new Error(`Apollo usage_stats failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as Record<string, ApolloEndpointUsage>;

  return {
    organizationsSearch: pickUsage(data, "api/v1/organizations", "search"),
    mixedCompaniesSearch: pickUsage(data, "api/v1/mixed_companies", "search"),
    organizationsEnrich: pickUsage(data, "api/v1/organizations", "enrich"),
    creditWarning:
      "Per Apollo docs, organizations/search may bill credits per page when results return. " +
      "Rate-limit consumption below is not the same as billing credits — check Settings → Billing in Apollo.",
  };
}
