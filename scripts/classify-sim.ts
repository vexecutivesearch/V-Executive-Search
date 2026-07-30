/**
 * One-off / rerunnable inbound classification simulation.
 *
 * Exercises classifyInbound (heuristic → LLM + reply playbook) against a
 * labeled fixture battery for email + iMessage.
 *
 * Usage: npx tsx scripts/classify-sim.ts
 * Requires: ANTHROPIC_API_KEY in .env.local (DATABASE_URL preferred for playbook)
 */
import { config } from "dotenv";

config({ path: ".env.local" });

import type { InboundIntent } from "@/lib/db/schema";
import { classifyInbound } from "@/lib/outreach/classify";
import {
  loadActiveReplyPlaybook,
  REPLY_TEMPLATE_KINDS,
} from "@/lib/outreach/reply-playbook";

type Channel = "email" | "imessage";

type Fixture = {
  id: string;
  channel: Channel;
  subject?: string;
  body: string;
  expected: InboundIntent;
  note?: string;
};

/** Expected may include bounce_hard (heuristic-only; not in LLM intent list). */
type ExpectedIntent = InboundIntent;

const FIXTURES: Fixture[] = [
  // ── positive ──────────────────────────────────────────────────────────
  {
    id: "e-pos-1",
    channel: "email",
    subject: "Re: Boutique legal recruiting",
    body: "Hi — yes, I'd be happy to chat. Does Thursday afternoon work for you?",
    expected: "positive",
  },
  {
    id: "s-pos-1",
    channel: "imessage",
    body: "Sure, let's set up a call next week",
    expected: "positive",
  },
  {
    id: "e-pos-2",
    channel: "email",
    subject: "Re: Intro",
    body: "This is interesting. Happy to jump on a quick call to learn more.",
    expected: "positive",
  },
  {
    id: "s-pos-2",
    channel: "imessage",
    body: "Yeah I'm open — when are you free?",
    expected: "positive",
  },
  {
    id: "e-pos-q",
    channel: "email",
    subject: "Re: Search support",
    body: "Yes, let's talk. Also curious what your fees look like — we can cover that on the call.",
    expected: "positive",
    note: "positive+question → prefer positive",
  },

  // ── positive_link_request ─────────────────────────────────────────────
  {
    id: "e-link-1",
    channel: "email",
    subject: "Re: Intro",
    body: "Sure — send me your calendar link and I'll grab a slot.",
    expected: "positive_link_request",
  },
  {
    id: "s-link-1",
    channel: "imessage",
    body: "Can you text me your Calendly? I'll book something.",
    expected: "positive_link_request",
  },
  {
    id: "e-link-2",
    channel: "email",
    subject: "Re: Chat",
    body: "I'd love to connect. Do you have a scheduling link I can use?",
    expected: "positive_link_request",
  },

  // ── info_request ──────────────────────────────────────────────────────
  {
    id: "e-info-1",
    channel: "email",
    subject: "Re: Recruiting",
    body: "What are your fees? Do you work on contingency or retainer?",
    expected: "info_request",
  },
  {
    id: "s-info-1",
    channel: "imessage",
    body: "How does your process work? Do you have candidates already?",
    expected: "info_request",
  },
  {
    id: "e-info-2",
    channel: "email",
    subject: "Re: Boutique Legal Recruitment",
    body: "Thanks for reaching out. Can you share more about the types of roles you typically place and your geographic focus?",
    expected: "info_request",
  },
  {
    id: "s-info-2",
    channel: "imessage",
    body: "What's your success rate for partner-level searches?",
    expected: "info_request",
  },

  // ── negative / decline ─────────────────────────────────────────────────
  {
    id: "e-neg-1",
    channel: "email",
    subject: "Re: Intro",
    body: "We're all set with recruiting agencies, thanks though.",
    expected: "negative",
  },
  {
    id: "s-neg-1",
    channel: "imessage",
    body: "Not interested right now",
    expected: "negative",
  },
  {
    id: "e-neg-2",
    channel: "email",
    subject: "Re: Search support",
    body: "Appreciate the note, but we handle recruiting in-house and aren't looking for outside help.",
    expected: "negative",
  },
  {
    id: "s-neg-soft",
    channel: "imessage",
    body: "Maybe another time — things are pretty locked in on our end for hiring.",
    expected: "negative",
    note: "soft decline",
  },

  // ── opt_out / STOP ────────────────────────────────────────────────────
  {
    id: "s-stop-1",
    channel: "imessage",
    body: "STOP",
    expected: "opt_out",
  },
  {
    id: "s-stop-2",
    channel: "imessage",
    body: "unsubscribe",
    expected: "opt_out",
  },
  {
    id: "e-opt-1",
    channel: "email",
    subject: "Please stop",
    body: "Please remove me from your list. Do not contact me again.",
    expected: "opt_out",
  },
  {
    id: "s-stop-long",
    channel: "imessage",
    body: "Please don't stop reaching out, this is interesting — let's chat.",
    expected: "positive",
    note: "STOP in longer SMS must NOT heuristic opt-out",
  },

  // ── wrong_person ──────────────────────────────────────────────────────
  {
    id: "e-wrong-1",
    channel: "email",
    subject: "Re: Intro",
    body: "I don't handle hiring — you want our HR director, Sarah Chen (schen@firm.com).",
    expected: "wrong_person",
  },
  {
    id: "s-wrong-1",
    channel: "imessage",
    body: "Wrong person, I'm not involved in recruiting decisions",
    expected: "wrong_person",
  },
  {
    id: "e-wrong-2",
    channel: "email",
    subject: "Re: Boutique legal recruiting",
    body: "You've reached the wrong inbox. Please contact our talent team instead.",
    expected: "wrong_person",
  },

  // ── ooo / auto-reply ──────────────────────────────────────────────────
  {
    id: "e-ooo-1",
    channel: "email",
    subject: "Out of Office",
    body: "I am out of the office until Monday with limited access to email. I will respond upon my return.",
    expected: "ooo",
  },
  {
    id: "e-ooo-2",
    channel: "email",
    subject: "Automatic reply: Boutique Legal Recruitment",
    body: "Thank you for your email. I am currently away and will respond when I return.",
    expected: "ooo",
  },
  {
    id: "s-ooo-1",
    channel: "imessage",
    body: "I'm on vacation until next Friday — limited access to messages.",
    expected: "ooo",
  },

  // ── courtesy ──────────────────────────────────────────────────────────
  {
    id: "e-cour-1",
    channel: "email",
    subject: "Re: Intro",
    body: "Thanks for reaching out!",
    expected: "courtesy",
  },
  {
    id: "s-cour-1",
    channel: "imessage",
    body: "Ok thanks",
    expected: "courtesy",
  },
  {
    id: "e-cour-2",
    channel: "email",
    subject: "Re: Note",
    body: "Appreciate it.",
    expected: "courtesy",
  },

  // ── data_deletion ─────────────────────────────────────────────────────
  {
    id: "e-del-1",
    channel: "email",
    subject: "Data request",
    body: "Please delete my data from your systems.",
    expected: "data_deletion",
  },
  {
    id: "s-del-1",
    channel: "imessage",
    body: "Remove all of my information from your database",
    expected: "data_deletion",
  },

  // ── bounce-like (email) ───────────────────────────────────────────────
  {
    id: "e-bounce-1",
    channel: "email",
    subject: "Undeliverable: Boutique legal recruiting",
    body: "Delivery has failed to these recipients or groups:\nuser@example.com\nThe email address you entered couldn't be found.",
    expected: "bounce_hard",
  },
  {
    id: "e-bounce-2",
    channel: "email",
    subject: "Delivery Status Notification (Failure)",
    body: "Address not found. Your message wasn't delivered.",
    expected: "bounce_hard",
  },

  // ── ambiguous / unknown-ish ───────────────────────────────────────────
  {
    id: "e-unk-1",
    channel: "email",
    subject: "Re: Intro",
    body: "asdf",
    expected: "unknown",
  },
  {
    id: "s-unk-1",
    channel: "imessage",
    body: "???",
    expected: "unknown",
  },
  {
    id: "e-amb-1",
    channel: "email",
    subject: "Re: Note",
    body: "Interesting timing.",
    expected: "unknown",
    note: "ambiguous — should pause as unknown",
  },

  // ── more edge cases ───────────────────────────────────────────────────
  {
    id: "e-neg-blunt",
    channel: "email",
    subject: "No",
    body: "No thanks. Please don't email me about this again — we're not a fit.",
    expected: "opt_out",
    note: "decline + do-not-email → opt_out via heuristic",
  },
  {
    id: "s-pos-link-ish",
    channel: "imessage",
    body: "Happy to meet — drop your calendar if you have one",
    expected: "positive_link_request",
  },
];

type Row = {
  id: string;
  channel: Channel;
  expected: ExpectedIntent;
  actual: string;
  confidence: number;
  via: string;
  pass: boolean;
  note?: string;
  subject?: string;
  body: string;
};

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function pct(n: number, d: number) {
  if (d === 0) return "n/a";
  return `${((100 * n) / d).toFixed(0)}%`;
}

async function main() {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error(
      "FAIL: ANTHROPIC_API_KEY is missing or empty in .env.local — aborting (would score everything as unknown/fallback).\n" +
        "Set a real Anthropic key in .env.local, then re-run: npx tsx scripts/classify-sim.ts",
    );
    process.exit(1);
  }

  let playbookNote = "playbook: unavailable / not loaded";
  try {
    const playbook = await loadActiveReplyPlaybook();
    const kinds = REPLY_TEMPLATE_KINDS.map((k) => {
      const n = playbook.filter((t) => t.kind === k).length;
      return `${k}=${n}`;
    }).join(", ");
    playbookNote =
      playbook.length > 0
        ? `playbook loaded: ${playbook.length} active template(s) (${kinds})`
        : `playbook loaded but empty (${kinds})`;
  } catch (err) {
    playbookNote = `playbook load failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(playbookNote);
  console.log(`Running ${FIXTURES.length} fixtures through classifyInbound...\n`);

  const rows: Row[] = [];
  // Sequential to avoid hammering Anthropic rate limits.
  for (const f of FIXTURES) {
    const result = await classifyInbound({
      body: f.body,
      subject: f.subject ?? null,
      channel: f.channel,
    });
    const pass = result.intent === f.expected;
    rows.push({
      id: f.id,
      channel: f.channel,
      expected: f.expected,
      actual: result.intent,
      confidence: result.confidence,
      via: result.via,
      pass,
      note: f.note,
      subject: f.subject,
      body: f.body,
    });
    const mark = pass ? "PASS" : "FAIL";
    console.log(
      `${mark}  ${pad(f.id, 14)} ${pad(f.channel, 9)} exp=${pad(f.expected, 22)} got=${pad(result.intent, 22)} conf=${result.confidence.toFixed(2)} via=${result.via}`,
    );
  }

  const passed = rows.filter((r) => r.pass).length;
  const total = rows.length;

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("SUMMARY TABLE");
  console.log("════════════════════════════════════════════════════════════");
  console.log(
    `${pad("id", 14)} ${pad("ch", 9)} ${pad("expected", 22)} ${pad("actual", 22)} ${pad("conf", 5)} ${pad("via", 10)} ok`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.id, 14)} ${pad(r.channel, 9)} ${pad(r.expected, 22)} ${pad(r.actual, 22)} ${pad(r.confidence.toFixed(2), 5)} ${pad(r.via, 10)} ${r.pass ? "✓" : "✗"}`,
    );
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`OVERALL: ${passed}/${total} = ${pct(passed, total)}`);

  for (const ch of ["email", "imessage"] as const) {
    const subset = rows.filter((r) => r.channel === ch);
    const p = subset.filter((r) => r.pass).length;
    console.log(
      `${ch.toUpperCase()}: ${p}/${subset.length} = ${pct(p, subset.length)}`,
    );
  }

  const intents = [...new Set(rows.map((r) => r.expected))].sort();
  console.log("\nPer-intent accuracy (by expected label):");
  for (const intent of intents) {
    const subset = rows.filter((r) => r.expected === intent);
    const p = subset.filter((r) => r.pass).length;
    console.log(`  ${pad(intent, 22)} ${p}/${subset.length} = ${pct(p, subset.length)}`);
  }

  const viaCounts = rows.reduce(
    (acc, r) => {
      acc[r.via] = (acc[r.via] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log("\nVia breakdown:", viaCounts);

  const failures = rows.filter((r) => !r.pass);
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`FAILURES (${failures.length}):`);
  if (failures.length === 0) {
    console.log("  (none)");
  } else {
    for (const f of failures) {
      console.log(
        `  ✗ ${f.id} [${f.channel}] expected=${f.expected} actual=${f.actual} conf=${f.confidence.toFixed(2)} via=${f.via}${f.note ? ` — ${f.note}` : ""}`,
      );
      console.log(`      body: ${JSON.stringify(f.body.slice(0, 120))}`);
    }
  }

  console.log("\n" + playbookNote);
  console.log(`SCORECARD: ${passed}/${total} = ${pct(passed, total)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
