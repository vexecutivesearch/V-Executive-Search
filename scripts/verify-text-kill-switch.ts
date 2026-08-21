/**
 * Can a text still get out?
 *
 * `outreach_settings.text_enabled` gates five independent paths, and each one
 * is a separate piece of code that could be missed by a change. This walks all
 * five against live data and says, per path, whether anything is currently able
 * to leave. It also answers the question the code alone cannot: enrollments pin
 * an immutable `flow_version_id`, so an enrollment created before the switch
 * existed is still walking a graph whose text nodes are right there in the
 * JSON — this counts them and names the enrollments sitting on one.
 *
 * The five paths:
 *   1. channel plan at enroll   — no plan may carry a text step while off
 *   2. Mac worker queue         — /api/outreach/imessage-queue returns empty
 *   3. reply auto-responders    — a texted reply is answered by email instead
 *   4. booking confirmations    — the texted "you're booked" stays quiet
 *   5. the flow engine send node — old pinned graphs walk past their text nodes
 *
 * A queued text is NOT a failure. The switch holds the queue rather than
 * cancelling it, deliberately, so turning texting back on is somebody's
 * decision and not an automatic flood. What would be a failure is a text
 * recorded as SENT after the switch went off, and that is the headline number.
 *
 * Usage:
 *   npx tsx scripts/verify-text-kill-switch.ts
 *   npx tsx scripts/verify-text-kill-switch.ts --problems   # only what needs a human
 *   npx tsx scripts/verify-text-kill-switch.ts --since 2026-08-19
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fail, readOnlySql, show } from "./lib/read-only-sql";

const ARGV = process.argv.slice(2);
const PROBLEMS_ONLY = ARGV.includes("--problems");
const sinceArg = ARGV.indexOf("--since");
const SINCE = sinceArg > -1 ? ARGV[sinceArg + 1] : null;

const sql = readOnlySql();

type Settings = {
  enabled: boolean;
  text_enabled: boolean;
  dry_run: boolean;
  require_approval: boolean;
  daily_send_cap: number;
  updated_at: string;
};

async function main() {
  const [settings] = await sql<Settings>`
    select enabled, text_enabled, dry_run, require_approval, daily_send_cap, updated_at
    from outreach_settings
    limit 1
  `;
  if (!settings) {
    console.log("No outreach_settings row — nothing is configured, nothing sends.");
    return;
  }

  console.log("\n=== Text channel kill switch ===\n");
  console.table([
    {
      text_enabled: settings.text_enabled ? "ON — texts CAN send" : "OFF",
      master_enabled: settings.enabled,
      dry_run: settings.dry_run,
      require_approval: settings.require_approval,
      daily_send_cap: settings.daily_send_cap,
      settings_last_changed: show(settings.updated_at),
    },
  ]);

  if (settings.text_enabled) {
    console.log(
      "text_enabled is ON, so every check below is expected to find live text " +
        "paths. This script proves containment while the switch is OFF; with it " +
        "on there is nothing to contain.",
    );
  }

  // The switch has no "turned off at" column, so the settings row's
  // updated_at is the best available boundary. --since overrides it.
  const boundary = SINCE ?? settings.updated_at;

  /* --- the headline: did a text actually go out? --------------------- */
  const escaped = await sql<{
    id: string;
    step_kind: string;
    sent_at: string;
    contact: string;
    company: string;
    phone: string | null;
  }>`
    select m.id, m.step_kind, m.sent_at,
           ct.name as contact, co.name as company, e.phone_number as phone
    from outreach_messages m
    join sequence_enrollments e on e.id = m.enrollment_id
    join contacts ct on ct.id = e.contact_id
    join companies co on co.id = e.company_id
    where m.channel = 'imessage'
      and m.status = 'sent'
      and m.sent_at >= ${boundary}::timestamp
    order by m.sent_at desc
    limit 50
  `;

  console.log(`\nTexts recorded SENT since ${show(boundary)}`);
  if (escaped.length) {
    console.table(escaped.map((r) => ({ ...r, sent_at: show(r.sent_at) })));
  } else {
    console.log("None. No text has left since the switch was last changed.");
  }

  /* --- path 1: channel plan at enroll -------------------------------- */
  const plannedText = await sql<{
    enrollment_id: string;
    contact: string;
    company: string;
    enrolled_at: string;
    text_steps: number;
  }>`
    select e.id as enrollment_id, ct.name as contact, co.name as company,
           e.enrolled_at,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status in ('drafted', 'queued')) as text_steps
    from sequence_enrollments e
    join contacts ct on ct.id = e.contact_id
    join companies co on co.id = e.company_id
    where e.enrolled_at >= ${boundary}::timestamp
      and exists (
        select 1 from outreach_messages m
        where m.enrollment_id = e.id and m.channel = 'imessage'
      )
    order by e.enrolled_at desc
    limit 50
  `;

  console.log("\nPath 1 — channel plan: enrollments created since the switch that drafted a text step");
  if (plannedText.length) {
    console.table(
      plannedText.map((r) => ({ ...r, enrolled_at: show(r.enrolled_at) })),
    );
  } else {
    console.log(
      "None. Every enrollment since the switch planned email only, which is " +
        "resolveChannelPlan refusing to add a text step.",
    );
  }

  /* --- path 2: the Mac worker queue ---------------------------------- */
  const [queued] = await sql<{
    queued: number;
    due_now: number;
    approved: number;
    oldest: string | null;
  }>`
    select
      count(*)::int as queued,
      count(*) filter (
        where m.scheduled_for is null or m.scheduled_for <= now()
      )::int as due_now,
      count(*) filter (where m.approved_at is not null)::int as approved,
      min(m.scheduled_for) as oldest
    from outreach_messages m
    join sequence_enrollments e on e.id = m.enrollment_id
    where m.channel = 'imessage'
      and m.status = 'queued'
      and e.status in ('active', 'paused', 'waiting_on_reply', 'waiting_on_manual')
      and e.phone_number is not null
  `;

  console.log("\nPath 2 — Mac worker queue: what the worker WOULD be handed if the switch flipped on");
  console.table([
    {
      queued_texts: queued?.queued ?? 0,
      due_now: queued?.due_now ?? 0,
      approved: queued?.approved ?? 0,
      oldest_slot: show(queued?.oldest ?? null),
      note: settings.text_enabled
        ? "switch is ON — the worker is being served these"
        : "held, not cancelled — the route returns { messages: [], reason: 'text_disabled' }",
    },
  ]);

  /* --- paths 3 and 4: replies and booking confirmations -------------- */
  const inboundTexts = await sql<{
    received_at: string;
    from_address: string | null;
    intent: string | null;
    action_taken: string | null;
    reply_channel: string | null;
    reply_status: string | null;
  }>`
    select i.received_at, i.from_address, i.classified_intent as intent,
           i.action_taken,
           (select m.channel from outreach_messages m
             where m.enrollment_id = i.enrollment_id
               and m.created_at >= i.received_at
             order by m.created_at limit 1) as reply_channel,
           (select m.status from outreach_messages m
             where m.enrollment_id = i.enrollment_id
               and m.created_at >= i.received_at
             order by m.created_at limit 1) as reply_status
    from inbound_messages i
    where i.channel = 'imessage'
      and i.received_at >= ${boundary}::timestamp
    order by i.received_at desc
    limit 50
  `;

  const answeredByText = inboundTexts.filter((r) => r.reply_channel === "imessage");
  console.log(
    "\nPaths 3 and 4 — replies and booking confirmations: inbound texts since the switch, and what answered them",
  );
  if (!inboundTexts.length) {
    console.log("No inbound texts since the switch — nothing exercised these paths.");
  } else {
    console.table(
      inboundTexts.map((r) => ({
        received: show(r.received_at),
        from: show(r.from_address),
        intent: show(r.intent),
        answered_on: show(r.reply_channel),
        reply_status: show(r.reply_status),
      })),
    );
    if (answeredByText.length) {
      console.log(
        `!! ${answeredByText.length} inbound text(s) were answered on the text ` +
          "channel. With the switch off, sendThreadedAutoReply must fall back to email.",
      );
    } else {
      console.log(
        "Every inbound text was answered by email or not at all, which is the " +
          "documented behaviour while the switch is off.",
      );
    }
  }

  const bookingTexts = await sql<{ status: string; n: number }>`
    select m.status, count(*)::int as n
    from outreach_messages m
    where m.step_kind = 'booking_confirmation'
      and m.channel = 'imessage'
      and m.created_at >= ${boundary}::timestamp
    group by m.status
  `;
  console.log("\nBooking-confirmation texts created since the switch");
  if (bookingTexts.length) console.table(bookingTexts);
  else console.log("None drafted — sendBookingConfirmation is returning its skip reason.");

  /* --- path 5: pinned flow versions that still contain text nodes ----- */
  const pinnedGraphs = await sql<{
    flow_version_id: string;
    flow_name: string;
    version: number;
    text_nodes: number;
    live_enrollments: number;
    sitting_on_text_node: number;
  }>`
    with text_nodes as (
      select v.id as flow_version_id,
             f.name as flow_name,
             v.version,
             count(*) filter (
               where node ->> 'type' = 'send'
                 and node -> 'config' ->> 'channel' = 'imessage'
             )::int as text_nodes,
             array_agg(node ->> 'id') filter (
               where node ->> 'type' = 'send'
                 and node -> 'config' ->> 'channel' = 'imessage'
             ) as text_node_ids
      from outreach_flow_versions v
      join outreach_flows f on f.id = v.flow_id
      cross join lateral jsonb_array_elements(v.graph -> 'nodes') as node
      group by v.id, f.name, v.version
    )
    select t.flow_version_id, t.flow_name, t.version, t.text_nodes,
           (select count(*)::int from sequence_enrollments e
             where e.flow_version_id = t.flow_version_id
               and e.status in ('active', 'paused', 'waiting_on_reply', 'waiting_on_manual')
           ) as live_enrollments,
           (select count(*)::int from sequence_enrollments e
             where e.flow_version_id = t.flow_version_id
               and e.status in ('active', 'paused', 'waiting_on_reply', 'waiting_on_manual')
               and e.current_node_id = any(t.text_node_ids)
           ) as sitting_on_text_node
    from text_nodes t
    where t.text_nodes > 0
    order by live_enrollments desc
  `;

  console.log(
    "\nPath 5 — pinned flow versions whose immutable graph still contains text send nodes",
  );
  if (pinnedGraphs.length) {
    console.table(pinnedGraphs);
    const exposed = pinnedGraphs.reduce((sum, r) => sum + r.live_enrollments, 0);
    console.log(
      `${exposed} live enrollment(s) are pinned to a graph containing a text node. ` +
        "This is expected and is exactly why handleSendNode checks the switch: " +
        "the graph cannot be edited, so the engine must walk past the node. " +
        "Any of these that reaches a text node must log " +
        'rule_action / skip_text_step rather than drafting.',
    );
  } else {
    console.log("No flow version in the database contains an iMessage send node.");
  }

  const skipEvents = await sql<{ n: number; last_at: string | null }>`
    select count(*)::int as n, max(created_at) as last_at
    from enrollment_events
    where event_type = 'rule_action'
      and payload ->> 'action' = 'skip_text_step'
      and created_at >= ${boundary}::timestamp
  `;
  console.log(
    `skip_text_step events logged since the switch: ${skipEvents[0]?.n ?? 0}` +
      (skipEvents[0]?.last_at ? ` (most recent ${show(skipEvents[0].last_at)})` : ""),
  );

  /* --- verdict -------------------------------------------------------- */
  const problems: string[] = [];
  if (!settings.text_enabled) {
    if (escaped.length) {
      problems.push(
        `${escaped.length} text(s) recorded as sent while text_enabled is off`,
      );
    }
    if (plannedText.length) {
      problems.push(
        `${plannedText.length} enrollment(s) created since the switch still drafted text steps`,
      );
    }
    if (answeredByText.length) {
      problems.push(
        `${answeredByText.length} inbound text(s) were answered on the text channel`,
      );
    }
    const draftedBooking = bookingTexts.reduce((sum, r) => sum + r.n, 0);
    if (draftedBooking) {
      problems.push(
        `${draftedBooking} booking-confirmation text(s) were drafted since the switch`,
      );
    }
  }

  console.log("\n=== Verdict ===");
  if (!settings.text_enabled && !problems.length) {
    console.log(
      "PASS: with text_enabled off, nothing has sent, nothing new has been " +
        "drafted, replies came back by email, and queued texts are held rather " +
        "than cancelled.",
    );
  } else if (problems.length) {
    console.table(problems.map((p) => ({ problem: p })));
    fail("the text channel is switched off but text is still escaping.");
  } else {
    console.log(
      "text_enabled is ON — this script cannot prove containment. Turn the " +
        "switch off in Admin, Safety switches and run it again.",
    );
  }

  if (!PROBLEMS_ONLY) {
    console.log(
      "\nQueued texts are counted, not flagged. Holding the queue is the designed " +
        "behaviour; draining it must be a deliberate act.",
    );
    console.log(
      "The five paths are checked independently on purpose: each is its own " +
        "piece of code, and a change that misses one leaves the other four " +
        "looking fine.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
