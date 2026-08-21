/**
 * Apollo organization search as a `CompanyDiscoverySource`.
 *
 * `run.ts` still calls `searchOrganizations` directly, because the primary pass
 * carries two independently-paged cursors (sized / unknown-headcount) that the
 * source interface deliberately does not model. This adapter exists so the
 * interface is demonstrably not shaped around SerpApi — it is the seam for
 * moving the primary pass behind the interface later, and the thing to point at
 * when arguing that a third source would fit.
 *
 * Cost, from Apollo's own docs: 1 credit per page of up to 100 organizations,
 * and no person is revealed. `perPage` therefore defaults to the maximum —
 * asking for 25 pays a whole credit for a quarter of a page.
 */

import { searchOrganizations } from "@/lib/domain-resolver";
import {
  apolloEmployeeRange,
  getVerticalConfig,
  keywordTagsForVertical,
} from "@/lib/discovery/verticals";
import type {
  CompanyDiscoverySource,
  DiscoverySourceOutcome,
  DiscoverySourceRequest,
} from "./source";

export const APOLLO_ORGANIZATIONS_SOURCE = "apollo_organizations";

/** A page of up to this many organizations still costs exactly one credit. */
export const APOLLO_MAX_PER_PAGE = 100;

export type ApolloSourceOptions = {
  apiKey: string;
  /** 1-based Apollo page. Callers owning a cursor pass the next page. */
  page?: number;
  /** Omit the headcount filter to surface companies Apollo has no size for. */
  employeeRange?: string | null;
};

export function apolloOrganizationSource(
  options: ApolloSourceOptions,
): CompanyDiscoverySource {
  return {
    name: APOLLO_ORGANIZATIONS_SOURCE,
    billingUnit: "credit",
    // Apollo's keyword tags come from config, so every configured vertical is
    // searchable; an unknown vertical id is the only thing it declines.
    supportsVertical: (vertical) => getVerticalConfig(vertical) != null,

    async discover(
      request: DiscoverySourceRequest,
    ): Promise<DiscoverySourceOutcome> {
      const employeeRange =
        options.employeeRange === undefined
          ? apolloEmployeeRange(request.vertical)
          : options.employeeRange;

      const result = await searchOrganizations({
        apiKey: options.apiKey,
        locations: [request.market],
        keywordTags: keywordTagsForVertical(request.vertical),
        employeeRange,
        page: options.page ?? 1,
        perPage: APOLLO_MAX_PER_PAGE,
        context: request.context,
        usageLabel: `discovery:${request.vertical}:${request.market}`,
      });

      const returned = result.organizations.length;
      const drained =
        result.totalEntries != null &&
        (options.page ?? 1) * result.perPage >= result.totalEntries;

      return {
        organizations: result.organizations.slice(0, Math.max(0, request.limit)),
        // One page, one credit — independent of how many rows came back.
        unitsSpent: 1,
        rejected: {},
        poolExhausted: returned < result.perPage || drained,
        notes: [],
      };
    },
  };
}
