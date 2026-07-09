import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { summarizeCallTranscript } from "@/lib/summarize-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let body: {
    transcript?: string;
    company_id?: string;
    contact_name?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const transcript = body.transcript?.trim();
  const companyId = body.company_id;
  if (!transcript || !companyId) {
    return NextResponse.json(
      { error: "transcript and company_id are required" },
      { status: 400 },
    );
  }

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const result = await summarizeCallTranscript({
    companyName: company.name,
    contactName: body.contact_name,
    transcript,
  });

  if (!result) {
    return NextResponse.json(
      { error: "Could not summarize — check ANTHROPIC_API_KEY" },
      { status: 503 },
    );
  }

  return NextResponse.json(result);
}
