import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerUsageEvents } from "@/lib/db/schema";

export const runtime = "nodejs";

type UsageEventInput = {
  provider?: string;
  endpoint?: string;
  egress_context?: string;
  trigger_source?: string;
  records_returned?: number;
  estimated_cost?: number;
  blocked?: boolean;
  metadata?: Record<string, unknown>;
};

function normalizeEvent(raw: UsageEventInput) {
  const provider = raw.provider?.trim().toLowerCase();
  const endpoint = raw.endpoint?.trim();
  const context = raw.egress_context?.trim() || "scheduled_pipeline";
  if (!provider || !endpoint) return null;
  return {
    provider,
    endpoint,
    egressContext: context,
    triggerSource: raw.trigger_source?.trim() || context.split(":")[0],
    recordsReturned: Math.max(0, Math.trunc(raw.records_returned ?? 0)),
    estimatedCost: Math.max(0, Math.trunc(raw.estimated_cost ?? 0)),
    blocked: raw.blocked === true,
    metadata: raw.metadata,
  };
}

export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  let body: UsageEventInput | { events?: UsageEventInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawEvents = Array.isArray((body as { events?: UsageEventInput[] }).events)
    ? (body as { events: UsageEventInput[] }).events
    : [body as UsageEventInput];
  const events = rawEvents.map(normalizeEvent).filter((e): e is NonNullable<typeof e> => Boolean(e));

  if (!events.length) {
    return NextResponse.json({ error: "No valid usage events" }, { status: 400 });
  }

  await db.insert(providerUsageEvents).values(events);
  return NextResponse.json({ ok: true, inserted: events.length });
}
