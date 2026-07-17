import { NextRequest, NextResponse } from "next/server";
import {
  getConsolidatedListings,
  type CrmListingFilters,
  type CrmListingSort,
} from "@/lib/crm-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORTS = new Set(["newest", "reposts"]);

/** Consolidated job listings — one row per posting, all markets/dates. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const sort = params.get("sort");
  const filters: CrmListingFilters = {
    market: params.get("market") ?? undefined,
    board: params.get("board") ?? undefined,
    state: params.get("state") ?? undefined,
    search: params.get("search") ?? params.get("q") ?? undefined,
    sort: sort && SORTS.has(sort) ? (sort as CrmListingSort) : "newest",
    page: Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1),
  };

  try {
    const result = await getConsolidatedListings(filters);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
