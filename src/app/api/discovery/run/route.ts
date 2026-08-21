import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  getDiscoveryPoolStatuses,
  resetDiscoveryCursors,
  runCompanyDiscovery,
} from "@/lib/discovery/run";
import {
  discoveryMarkets,
  discoveryRunDefaults,
  isVerticalId,
  listVerticals,
} from "@/lib/discovery/verticals";
import { PaidEgressBlockedError } from "@/lib/paid-egress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Verticals, selectable markets, and pool status for the run launcher. */
export async function GET() {
  let pools: Awaited<ReturnType<typeof getDiscoveryPoolStatuses>> = [];
  try {
    pools = await getDiscoveryPoolStatuses();
  } catch (err) {
    // The launcher still works before the discovery table exists.
    console.error("Discovery pool status unavailable:", err);
  }
  return NextResponse.json({
    verticals: listVerticals().map(({ id, config }) => ({
      id,
      label: config.label,
      employeeMin: config.employee_min,
      employeeMax: config.employee_max,
      keywords: config.apollo_keyword_tags,
    })),
    markets: discoveryMarkets(),
    defaults: discoveryRunDefaults(),
    pools,
  });
}

/**
 * Company-first discovery run: market + vertical + count → reviewable
 * companies. Costs one Apollo credit per organization-search page (plus one
 * for the unknown-headcount pass) and reveals NOBODY — paid people data starts
 * at Approve for Enrichment.
 */
export async function POST(request: NextRequest) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "APOLLO_API_KEY is not configured." },
      { status: 503 },
    );
  }

  let body: {
    vertical?: string;
    market?: string;
    limit?: number;
    include_unknown_size?: boolean;
    allow_large_companies?: boolean;
    reset?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const vertical = body.vertical?.trim();
  const market = body.market?.trim();
  if (!isVerticalId(vertical)) {
    return NextResponse.json(
      {
        error: `vertical must be one of: ${listVerticals()
          .map((v) => v.id)
          .join(", ")}`,
      },
      { status: 400 },
    );
  }
  if (!market) {
    return NextResponse.json(
      { error: "market is required (e.g. \"Palm Beach County, Florida\")" },
      { status: 400 },
    );
  }

  if (body.reset === true) {
    const result = await resetDiscoveryCursors(vertical, market);
    revalidatePath("/crm");
    return NextResponse.json({
      ok: true,
      reset: result.reset,
      vertical,
      market,
      message:
        `Cleared ${result.reset} pool cursor(s) for ${vertical} in ${market}. ` +
        "The next Find will start at page 1, including size-unknown companies.",
    });
  }

  const limit = Number.isFinite(body.limit)
    ? Number(body.limit)
    : discoveryRunDefaults().companiesPerRun;

  try {
    const summary = await runCompanyDiscovery({
      vertical,
      market,
      limit,
      includeUnknownSize: body.include_unknown_size !== false,
      // Strict equality, so a missing or malformed field can never widen the
      // size ceiling by accident.
      allowLargeCompanies: body.allow_large_companies === true,
      apiKey,
    });

    revalidatePath("/crm");

    // Supplementary sources bill in their own unit (SerpApi searches, not
    // Apollo credits), so the note names each one rather than summing them into
    // a single fake number the operator cannot reconcile against a provider.
    const supplementaryCost = summary.sources
      .filter((source) => source.unitsSpent > 0)
      .map(
        (source) =>
          `${source.unitsSpent} ${source.name} ${source.billingUnit}(es)`,
      );

    return NextResponse.json({
      ok: true,
      ...summary,
      cost_note:
        `${summary.creditsSpent} Apollo organization-search credit(s) — ` +
        "one per page of up to 100 organizations" +
        (summary.apolloQuantifyCredits
          ? ` (${summary.apolloQuantifyCredits} of those backfilling company ` +
            "attributes by domain)"
          : "") +
        (supplementaryCost.length ? `, plus ${supplementaryCost.join(", ")}` : "") +
        ". No contact was revealed.",
    });
  } catch (err) {
    if (err instanceof PaidEgressBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : "Discovery run failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
