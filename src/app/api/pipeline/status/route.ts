import { NextRequest, NextResponse } from "next/server";
import { verifyWorkerAuth, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { and, eq, isNull } from "drizzle-orm";

export const runtime = "nodejs";

function runRequestTtlMs(): number {
  const minutes = Number.parseInt(process.env.RUN_REQUEST_TTL_MINUTES ?? "30", 10);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 30) * 60 * 1000;
}

function workerDriftStatus(settings: Awaited<ReturnType<typeof getOrCreateSettings>>) {
  const payload = settings.workerStatusPayload ?? {};
  const releaseSha =
    typeof payload.worker_release_sha === "string"
      ? payload.worker_release_sha
      : null;
  const releaseRef =
    typeof payload.worker_release_ref === "string"
      ? payload.worker_release_ref
      : "origin/worker-production";
  const expectedSha = process.env.WORKER_EXPECTED_SHA || releaseSha;
  const expectedBranch =
    process.env.WORKER_EXPECTED_BRANCH ||
    (releaseRef.startsWith("origin/") ? releaseRef.slice("origin/".length) : null);
  const reasons: string[] = [];

  if (!settings.workerCommitSha) reasons.push("unknown_sha");
  if (settings.workerDirty) reasons.push("dirty_worktree");
  if (
    expectedBranch &&
    settings.workerBranch &&
    settings.workerBranch !== expectedBranch
  ) {
    reasons.push(`branch:${settings.workerBranch}`);
  }
  if (
    expectedSha &&
    settings.workerCommitSha &&
    settings.workerCommitSha !== expectedSha
  ) {
    reasons.push("sha_mismatch");
  }

  return {
    drift: reasons.length > 0,
    reasons,
    expected_sha: expectedSha ?? null,
    expected_branch: expectedBranch,
    expected_ref: releaseRef,
  };
}

export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  const settings = await getOrCreateSettings();
  const runRequestedAt = settings.runRequestedAt;
  const runRequestExpiresAt = runRequestedAt
    ? new Date(runRequestedAt.getTime() + runRequestTtlMs())
    : null;
  const workerDrift = workerDriftStatus(settings);
  return NextResponse.json({
    run_requested_at: runRequestedAt?.toISOString() ?? null,
    run_claimed_at: settings.runClaimedAt?.toISOString() ?? null,
    run_request_expires_at: runRequestExpiresAt?.toISOString() ?? null,
    contactout_sync_requested_at:
      settings.contactoutSyncRequestedAt?.toISOString() ?? null,
    imessage_check_requested_at:
      settings.imessageCheckRequestedAt?.toISOString() ?? null,
    last_run_at: settings.lastRunAt?.toISOString() ?? null,
    worker_last_seen_at: settings.workerLastSeenAt?.toISOString() ?? null,
    worker_commit_sha: settings.workerCommitSha,
    worker_branch: settings.workerBranch,
    worker_dirty: settings.workerDirty,
    worker_agent_summary: settings.workerAgentSummary,
    worker_status_at: settings.workerStatusAt?.toISOString() ?? null,
    worker_drift: workerDrift,
  });
}

export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  let body: {
    action?: string;
    commit_sha?: string | null;
    branch?: string | null;
    dirty?: boolean | null;
    agent_summary?: string | null;
    status_payload?: Record<string, unknown> | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = await getOrCreateSettings();

  if (body.action === "clear_run_request") {
    await db
      .update(pipelineSettings)
      .set({ runRequestedAt: null, runClaimedAt: null, updatedAt: new Date() })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "claim_run_request") {
    if (!settings.runRequestedAt) {
      return NextResponse.json({ ok: true, claimed: false, reason: "none" });
    }
    const expiresAt = new Date(settings.runRequestedAt.getTime() + runRequestTtlMs());
    if (expiresAt < new Date()) {
      await db
        .update(pipelineSettings)
        .set({ runRequestedAt: null, runClaimedAt: null, updatedAt: new Date() })
        .where(eq(pipelineSettings.id, settings.id));
      return NextResponse.json({ ok: true, claimed: false, reason: "stale" });
    }
    if (settings.runClaimedAt) {
      return NextResponse.json({
        ok: true,
        claimed: false,
        reason: "already_claimed",
      });
    }
    const [claimed] = await db
      .update(pipelineSettings)
      .set({
        runRequestedAt: null,
        runClaimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(pipelineSettings.id, settings.id), isNull(pipelineSettings.runClaimedAt)))
      .returning({ id: pipelineSettings.id });
    return NextResponse.json({
      ok: true,
      claimed: Boolean(claimed),
      reason: claimed ? "claimed" : "already_claimed",
    });
  }

  if (body.action === "clear_contactout_sync_request") {
    await db
      .update(pipelineSettings)
      .set({ contactoutSyncRequestedAt: null, updatedAt: new Date() })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "clear_imessage_check_request") {
    await db
      .update(pipelineSettings)
      .set({ imessageCheckRequestedAt: null, updatedAt: new Date() })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "mark_run_complete") {
    await db
      .update(pipelineSettings)
      .set({
        lastRunAt: new Date(),
        runRequestedAt: null,
        runClaimedAt: null,
        missedRunAlertSlot: null,
        updatedAt: new Date(),
      })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "worker_heartbeat") {
    await db
      .update(pipelineSettings)
      .set({
        workerLastSeenAt: new Date(),
        workerCommitSha: body.commit_sha ?? settings.workerCommitSha,
        workerBranch: body.branch ?? settings.workerBranch,
        workerDirty: body.dirty ?? settings.workerDirty ?? false,
        workerAgentSummary: body.agent_summary ?? settings.workerAgentSummary,
        workerStatusPayload: body.status_payload ?? settings.workerStatusPayload,
        workerStatusAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
