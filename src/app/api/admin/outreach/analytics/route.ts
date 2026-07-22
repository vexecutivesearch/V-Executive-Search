import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  branchStats,
  industryStats,
  outcomeStats,
  overviewCounts,
  profileStats,
  templateStats,
} from "@/lib/outreach/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [overview, templates, profiles, branches, outcomes, industries] =
    await Promise.all([
      overviewCounts(),
      templateStats(),
      profileStats(),
      branchStats(),
      outcomeStats(),
      industryStats(),
    ]);
  return NextResponse.json({
    overview,
    templates,
    profiles,
    branches,
    outcomes,
    industries,
  });
}
