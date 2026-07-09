import { NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker health gate — confirms v2 pipeline endpoints are live. */
export async function GET(request: Request) {
  if (!verifyWorkerAuth(request as import("next/server").NextRequest)) {
    return unauthorized();
  }

  return NextResponse.json({
    ok: true,
    v2: true,
    features: {
      rescore: true,
      enrichment_queue: true,
      generate_openers: true,
      archive_stale: true,
      verify_emails: true,
    },
  });
}
