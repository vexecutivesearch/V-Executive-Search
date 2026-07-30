import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import {
  outreachFlows,
  outreachFlowVersions,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { ensureDefaultFlow } from "@/lib/outreach/default-flow";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { migrateEnrollmentVersion } from "@/lib/outreach/flow-engine";
import { simulateFlow } from "@/lib/outreach/flow-simulate";
import { validateFlowGraph, type FlowGraph } from "@/lib/outreach/flow-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureDefaultFlow();

  const flowId = request.nextUrl.searchParams.get("flowId");
  if (flowId) {
    const versions = await db
      .select()
      .from(outreachFlowVersions)
      .where(eq(outreachFlowVersions.flowId, flowId))
      .orderBy(desc(outreachFlowVersions.version));
    // "42 enrollments on v3, 15 on v4"
    const counts = await db
      .select({
        versionId: sequenceEnrollments.flowVersionId,
        count: sql<number>`count(*)`,
      })
      .from(sequenceEnrollments)
      .where(
        and(
          isNotNull(sequenceEnrollments.flowVersionId),
          inArray(
            sequenceEnrollments.flowVersionId,
            versions.map((v) => v.id),
          ),
        ),
      )
      .groupBy(sequenceEnrollments.flowVersionId);
    const countMap = Object.fromEntries(counts.map((c) => [c.versionId, Number(c.count)]));
    return NextResponse.json({
      versions: versions.map((v) => ({ ...v, enrollments: countMap[v.id] ?? 0 })),
    });
  }

  const flows = await db.select().from(outreachFlows).orderBy(outreachFlows.createdAt);
  return NextResponse.json({ flows });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    action?: "create" | "save_version" | "activate" | "archive" | "simulate" | "migrate";
    flowId?: string;
    name?: string;
    graph?: FlowGraph;
    versionId?: string;
    // simulate
    contactId?: string;
    draft?: boolean;
    assumeIntent?: string;
    // migrate
    enrollmentId?: string;
    targetVersionId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "create") {
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const [flow] = await db
      .insert(outreachFlows)
      .values({ name: body.name.trim(), status: "draft" })
      .returning();
    return NextResponse.json({ flow });
  }

  if (body.action === "save_version") {
    if (!body.flowId || !body.graph) {
      return NextResponse.json({ error: "flowId + graph required" }, { status: 400 });
    }
    const [flow] = await db
      .select()
      .from(outreachFlows)
      .where(eq(outreachFlows.id, body.flowId))
      .limit(1);
    if (!flow) return NextResponse.json({ error: "flow not found" }, { status: 404 });
    if (flow.isLocked) {
      return NextResponse.json(
        { error: "this flow is locked (pre-built phase-1 cadence) — duplicate it instead" },
        { status: 422 },
      );
    }
    // Strict schema validation — graphs are data, never code.
    const problems = validateFlowGraph(body.graph);
    if (problems.length) {
      return NextResponse.json({ error: "invalid graph", problems }, { status: 422 });
    }
    // Versions are immutable: saving always creates version N+1.
    const [latest] = await db
      .select({ version: outreachFlowVersions.version })
      .from(outreachFlowVersions)
      .where(eq(outreachFlowVersions.flowId, flow.id))
      .orderBy(desc(outreachFlowVersions.version))
      .limit(1);
    const [version] = await db
      .insert(outreachFlowVersions)
      .values({
        flowId: flow.id,
        version: (latest?.version ?? 0) + 1,
        graph: body.graph,
      })
      .returning();
    return NextResponse.json({ version });
  }

  if (body.action === "activate" || body.action === "archive") {
    if (!body.flowId) return NextResponse.json({ error: "flowId required" }, { status: 400 });
    const [updated] = await db
      .update(outreachFlows)
      .set({
        status: body.action === "activate" ? "active" : "archived",
        updatedAt: new Date(),
      })
      .where(eq(outreachFlows.id, body.flowId))
      .returning();
    await logEnrollmentEvent({
      eventType: "manual_intervention",
      actor: "user",
      payload: { action: `flow_${body.action}`, flow_id: body.flowId },
    });
    return NextResponse.json({ flow: updated });
  }

  if (body.action === "simulate") {
    let graph = body.graph;
    if (!graph && body.versionId) {
      const [version] = await db
        .select()
        .from(outreachFlowVersions)
        .where(eq(outreachFlowVersions.id, body.versionId))
        .limit(1);
      graph = version?.graph;
    }
    if (!graph) return NextResponse.json({ error: "graph or versionId required" }, { status: 400 });
    const problems = validateFlowGraph(graph);
    if (problems.length) {
      return NextResponse.json({ error: "invalid graph", problems }, { status: 422 });
    }
    const result = await simulateFlow({
      graph,
      contactId: body.contactId ?? null,
      draft: body.draft === true,
      assumeIntent: body.assumeIntent ?? null,
    });
    return NextResponse.json(result);
  }

  if (body.action === "migrate") {
    if (!body.enrollmentId || !body.targetVersionId) {
      return NextResponse.json({ error: "enrollmentId + targetVersionId required" }, { status: 400 });
    }
    const result = await migrateEnrollmentVersion(body.enrollmentId, body.targetVersionId, "user");
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
