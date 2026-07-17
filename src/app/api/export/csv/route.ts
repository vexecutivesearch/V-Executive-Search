import { NextRequest, NextResponse } from "next/server";
import {
  buildBacklogCsv,
  buildCallListCsv,
  buildCallSheetCsv,
  buildCrmLeadsCsv,
  crmExportFilename,
  exportFilename,
} from "@/lib/csv-export";
import { resolveListDateRange } from "@/lib/list-date-range";
import type { CrmLeadFilters } from "@/lib/crm-queries";
import type { CompanyStatus } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportType = "backlog" | "call-sheet" | "call-list" | "crm-leads";

const COMPANY_STATUSES = new Set(["new", "contacted", "meeting", "client", "skipped"]);

function parseExportType(raw: string | null): ExportType | null {
  if (raw === "backlog" || raw === "scrape") return "backlog";
  if (raw === "call-sheet" || raw === "contacts") return "call-sheet";
  if (raw === "call-list") return "call-list";
  if (raw === "crm-leads") return "crm-leads";
  return null;
}

function csvResponse(csv: string, filename: string): NextResponse {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Download backlog, call sheet, CRM leads, or the call list as CSV. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const type = parseExportType(params.get("type"));
  if (!type) {
    return NextResponse.json(
      { error: "Query param type must be backlog, call-sheet, call-list, or crm-leads" },
      { status: 400 },
    );
  }

  try {
    if (type === "call-list") {
      return csvResponse(await buildCallListCsv(), crmExportFilename("call-list"));
    }

    if (type === "crm-leads") {
      const status = params.get("status");
      const filters: CrmLeadFilters = {
        market: params.get("market") ?? undefined,
        state: params.get("state") ?? undefined,
        city: params.get("city") ?? undefined,
        sector: params.get("sector") ?? undefined,
        status:
          status && COMPANY_STATUSES.has(status)
            ? (status as CompanyStatus)
            : undefined,
        search: params.get("q") ?? undefined,
        callableOnly: params.get("callable") === "1",
        enrichedOnly: params.get("enriched") === "1",
        hotOnly: params.get("hot") === "1",
      };
      return csvResponse(
        await buildCrmLeadsCsv(filters),
        crmExportFilename("crm-leads"),
      );
    }

    const range = resolveListDateRange({
      date: params.get("date") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
    const csv =
      type === "backlog"
        ? await buildBacklogCsv(range)
        : await buildCallSheetCsv(range);
    return csvResponse(csv, exportFilename(type, range));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
