import { sendAlertEmail } from "@/lib/alert-email";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import {
  formatEtTimestamp,
  getActiveRunSlot,
  minutesAgo,
} from "@/lib/run-slot";
import { eq } from "drizzle-orm";

const WORKER_STALE_MINUTES = 15;

export async function checkMissedPipelineRun(): Promise<{
  ok: boolean;
  skipped?: boolean;
  alerted?: boolean;
  reason?: string;
}> {
  const now = new Date();
  const slot = getActiveRunSlot(now);
  if (!slot) {
    return { ok: true, skipped: true, reason: "outside alert window" };
  }

  const settings = await getOrCreateSettings();

  if (settings.missedRunAlertSlot === slot.id) {
    return { ok: true, skipped: true, reason: "already alerted for slot" };
  }

  const pipelineRan = Boolean(
    settings.lastRunAt && settings.lastRunAt >= slot.slotStart,
  );

  const workerStale =
    !settings.workerLastSeenAt ||
    minutesAgo(settings.workerLastSeenAt, now)! > WORKER_STALE_MINUTES;

  if (pipelineRan && !workerStale) {
    return { ok: true, skipped: true, reason: "pipeline ran on schedule" };
  }

  const issues: string[] = [];

  if (!pipelineRan) {
    issues.push(
      `The ${slot.label} pipeline run has not completed yet (last successful run: ${formatEtTimestamp(settings.lastRunAt)}).`,
    );
  }

  if (workerStale) {
    const lastSeen = settings.workerLastSeenAt
      ? `${formatEtTimestamp(settings.workerLastSeenAt)} (${minutesAgo(settings.workerLastSeenAt, now)} min ago)`
      : "never — launchd may not be installed";
    issues.push(
      `Worker Mac heartbeat is stale (last seen: ${lastSeen}). The Mac may be asleep, offline, or launchd agents are not loaded.`,
    );
  }

  const workerPayload = settings.workerStatusPayload ?? {};
  const originMainSha =
    typeof workerPayload.origin_main_sha === "string"
      ? workerPayload.origin_main_sha
      : null;
  const expectedSha = process.env.WORKER_EXPECTED_SHA || originMainSha;
  const expectedBranch = process.env.WORKER_EXPECTED_BRANCH || "main";
  const workerDrift =
    Boolean(settings.workerDirty) ||
    Boolean(settings.workerBranch && settings.workerBranch !== expectedBranch) ||
    Boolean(
      expectedSha &&
        settings.workerCommitSha &&
        settings.workerCommitSha !== expectedSha,
    ) ||
    !settings.workerCommitSha;

  if (workerDrift) {
    issues.push(
      `Worker code drift detected (sha: ${settings.workerCommitSha ?? "unknown"}, branch: ${settings.workerBranch ?? "unknown"}, dirty: ${settings.workerDirty ? "yes" : "no"}, expected: ${expectedSha ?? expectedBranch}).`,
    );
  }

  const toEmail = settings.notificationEmail;
  const sent = await sendAlertEmail({
    toEmail,
    subject: `[V Exec Search] Pipeline missed — ${slot.label} run`,
    html: `
      <html><body style="font-family:sans-serif;color:#111;max-width:640px">
        <h2>Scheduled pipeline did not run</h2>
        <p>The ${slot.label} daily pipeline was expected on your worker Mac but has not completed successfully.</p>
        <ul>
          ${issues.map((i) => `<li>${i}</li>`).join("")}
        </ul>
        <h3>Fix on your worker Mac</h3>
        <ol>
          <li>Wake the Mac and keep it plugged in (disable sleep during run windows).</li>
          <li>Run: <code>cd worker && git pull && ./scripts/install_launchd.sh</code></li>
          <li>Verify: <code>launchctl list | grep vexecsearch</code></li>
          <li>Or trigger manually: Admin → Run now in the CRM.</li>
        </ol>
        <p style="color:#666;font-size:12px;margin-top:24px">
          <a href="https://v-executive-search.vercel.app/today">Open CRM</a>
        </p>
      </body></html>
    `,
  });

  if (!sent) {
    return { ok: false, reason: "alert email failed" };
  }

  await db
    .update(pipelineSettings)
    .set({ missedRunAlertSlot: slot.id, updatedAt: new Date() })
    .where(eq(pipelineSettings.id, settings.id));

  return { ok: true, alerted: true };
}
