import { NextRequest, NextResponse } from "next/server";
import {
  buildBacklogCsv,
  buildCallSheetCsv,
  exportFilename,
} from "@/lib/csv-export";
import { resolveListDateRange } from "@/lib/list-date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportType = "backlog" | "call-sheet";

function parseExportType(raw: string | null): ExportType | null {
  if (raw === "backlog" || raw === "scrape") return "backlog";
  if (raw === "call-sheet" || raw === "contacts") return "call-sheet";
  return null;
}

/** Download backlog or call sheet for a date range as CSV. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const type = parseExportType(params.get("type"));
  if (!type) {
    return NextResponse.json(
      { error: "Query param type must be backlog or call-sheet" },
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
      type === "backlog"
        ? await buildBacklogCsv(range)
        : await buildCallSheetCsv(range);

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
