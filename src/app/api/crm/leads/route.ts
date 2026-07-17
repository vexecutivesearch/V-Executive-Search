import { NextRequest, NextResponse } from "next/server";
import { getCrmLeads, type CrmLeadFilters, type CrmSort } from "@/lib/crm-queries";
import type { CompanyStatus } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMPANY_STATUSES = new Set(["new", "contacted", "meeting", "client", "skipped"]);
const SORTS = new Set(["icp", "score", "recent", "name"]);
const HIDE_CATEGORIES = new Set([
  "fortune",
  "gov",
  "schools",
  "hospitals",
  "staffing",
  "third_party",
]);

/** Consolidated companies — all markets, all dates. Server-side filters. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  const sort = params.get("sort");
  const filters: CrmLeadFilters = {
    market: params.get("market") ?? undefined,
    state: params.get("state") ?? undefined,
    city: params.get("city") ?? undefined,
    sector: params.get("sector") ?? undefined,
    status:
      status && COMPANY_STATUSES.has(status)
        ? (status as CompanyStatus)
        : undefined,
    search: params.get("search") ?? params.get("q") ?? undefined,
    callableOnly: params.get("callable") === "1",
    enrichedOnly: params.get("enriched") === "1",
    hotOnly: params.get("hot") === "1",
    roleType: params.get("role") ?? undefined,
    sizeBand: params.get("size") ?? undefined,
    compMin: Number.parseInt(params.get("comp") ?? "", 10) || undefined,
    includeEstimatedComp: params.get("est") !== "0",
    icpMin: Number.parseInt(params.get("icpmin") ?? "", 10) || undefined,
    hideCategories: (params.get("hide") ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => HIDE_CATEGORIES.has(c)),
    sort: sort && SORTS.has(sort) ? (sort as CrmSort) : "icp",
    page: Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1),
  };

  try {
    const result = await getCrmLeads(filters);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
