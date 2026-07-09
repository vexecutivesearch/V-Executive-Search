import { NextRequest, NextResponse } from "next/server";
import { generateAndStoreOpener } from "@/lib/generate-opener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Generate Haiku call opener (CRM UI or worker). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let force = false;
  try {
    const body = await request.json();
    force = Boolean(body?.force);
  } catch {
    // empty body ok
  }

  const result = await generateAndStoreOpener(id, { force });
  if (!result.opener && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    company_id: id,
    call_opener: result.opener,
    generated: result.generated,
  });
}
