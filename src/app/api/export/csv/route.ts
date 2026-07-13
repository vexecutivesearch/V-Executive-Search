import { NextRequest, NextResponse } from "next/server";
import {
  buildContactsCsv,
  buildScrapeCsv,
  exportFilename,
} from "@/lib/csv-export";
import { resolveListDateRange } from "@/lib/list-date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download scrape list or enriched contacts for a date range as CSV. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const type = params.get("type");
  if (type !== "scrape" && type !== "contacts") {
    return NextResponse.json(
      { error: "Query param type must be scrape or contacts" },
      { status: 400 },
    );
  }

  const range = resolveListDateRange({
    date: params.get("date") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });

  try {
    const csv =
      type === "scrape"
        ? await buildScrapeCsv(range)
        : await buildContactsCsv(range);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(type, range)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
