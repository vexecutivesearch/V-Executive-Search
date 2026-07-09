import { NextRequest, NextResponse } from "next/server";

export function verifyWorkerAuth(request: NextRequest): boolean {
  const apiKey = process.env.WORKER_API_KEY;
  if (!apiKey) return false;

  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === apiKey;
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
