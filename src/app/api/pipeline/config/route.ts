import { NextResponse } from "next/server";
import { verifyWorkerAuth, unauthorized } from "@/lib/auth";
import { buildPipelineConfig } from "@/lib/pipeline-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!verifyWorkerAuth(request as import("next/server").NextRequest)) {
    return unauthorized();
  }

  const config = await buildPipelineConfig();
  return NextResponse.json(config);
}
