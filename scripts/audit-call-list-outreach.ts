/**
 * Who on the Call List has not been messaged yet, and why.
 *
 * One line per CONTACT, not per company: a call-list add now enrolls every
 * reachable contact at the company, so "the company got an email" is no longer
 * the same question as "everyone we revealed got one".
 *
 * A contact is only counted as a problem when something is actually wrong.
 * Waiting is not wrong: a day-0 step queued for Monday 9 AM because the lead
 * was added over the weekend is reported as SCHEDULED, and a step waiting on
 * warm-up capacity is reported as DEFERRED with the headroom that caused it.
 *
 * Usage:
 *   npx tsx scripts/audit-call-list-outreach.ts            # everything on the list
 *   npx tsx scripts/audit-call-list-outreach.ts --problems # only what needs a human
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const PROBLEMS_ONLY = process.argv.includes("--problems");

/** Ramp maths mirrored from src/lib/outreach/profiles.ts. */
const RAMP_BASE = 5;
const RAMP_INCREMENT = 5;
const RAMP_CEILING = 50;

type Day0 = {
  kind: string;
  ch: string;
  st: string;
  sched: string | null;
  sent: string | null;
  defer: string | null;
  err: string | null;
};

type Verdict =
  | "SENT"
  /** Some day-0 channel sent, another is stuck. Needs a human. */
  | "PARTIAL"
  | "SCHEDULED"
  | "DEFERRED"
  | "DUE NOW"
  | "BLOCKED"
  | "NOT ENROLLED"
  | "NOT REVEALED";

/**
 * NOT REVEALED is not a failure: Apollo discovery lists people at a company
 * long before anyone pays to reveal their address or mobile. Those rows have
 * nothing to message and must not drown the contacts that do.
 */
const OK: ReadonlySet<Verdict> = new Set([
  "SENT",
  "SCHEDULED",
  "DUE NOW",
  "NOT REVEALED",
]);

function et(ts: string | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function classify(
  row: Record<string, unknown>,
  maxPerCompany: number,
  enrollmentsByCompany: Map<string, number>,
): { verdict: Verdict; detail: string } {
  const email = (row.email as string | null)?.trim() || null;
  const phone = (row.phone as string | null)?.trim() || null;
  const day0 = ((row.day0 as Day0[] | null) ?? []).filter(Boolean);

  if (!row.enrollment_id) {
    if (!email && !phone) {
      return {
        verdict: "NOT REVEALED",
        detail: "discovered only, no address or mobile revealed",
      };
    }
    // Reasons are read off THIS contact, never off a sibling's old failure.
    if (row.suppressed_reason) {
      return {
        verdict: "BLOCKED",
        detail: `suppressed (${row.suppressed_reason}) — clear it to enroll`,
      };
    }
    if (row.email_deliverable === false && !phone) {
      return {
        verdict: "BLOCKED",
        detail: "email not deliverable and no phone to fall back to",
      };
    }
    if ((enrollmentsByCompany.get(row.company as string) ?? 0) >= maxPerCompany) {
      return {
        verdict: "NOT ENROLLED",
        detail: `company already at max_contacts_per_company (${maxPerCompany})`,
      };
    }
    return {
      verdict: "NOT ENROLLED",
      detail: "reachable but never enrolled — re-add the company to the Call List",
    };
  }

  if (!day0.length) {
    return {
      verdict: "BLOCKED",
      detail: `enrolled (${row.enrollment_status}) but no day 0 step exists`,
    };
  }

  const now = Date.now();
  const queued = day0.filter((m) => m.st === "queued");
  const deferred = queued.filter((m) => m.defer);

  const sent = day0.filter((m) => m.st === "sent");
  if (sent.length) {
    // A text that went out does not make the email fine. Reporting SENT for a
    // contact whose intro email is still stuck is how an unsent email hides.
    if (deferred.length) {
      return {
        verdict: "PARTIAL",
        detail:
          `${sent.map((m) => `${m.ch} sent ${et(m.sent)}`).join(", ")}; ` +
          `${deferred.map((m) => `${m.ch} deferred: ${m.defer}`).join(", ")}`,
      };
    }
    return {
      verdict: "SENT",
      detail: sent.map((m) => `${m.ch} ${et(m.sent)}`).join(", "),
    };
  }

  if (deferred.length) {
    return {
      verdict: "DEFERRED",
      detail: deferred.map((m) => `${m.ch}: ${m.defer}`).join(", "),
    };
  }
  const future = queued.filter((m) => m.sched && new Date(m.sched).getTime() > now);
  if (future.length) {
    return {
      verdict: "SCHEDULED",
      detail: future.map((m) => `${m.ch} ${et(m.sched)} ET`).join(", "),
    };
  }
  if (queued.length) {
    return {
      verdict: "DUE NOW",
      detail: `${queued.map((m) => m.ch).join(", ")} waiting on the next pass`,
    };
  }

  const bad = day0.filter((m) => ["skipped", "failed", "cancelled"].includes(m.st));
  if (bad.length) {
    return {
      verdict: "BLOCKED",
      detail: bad
        .map((m) => `${m.ch} ${m.st}${m.err ? `: ${m.err}` : ""}`)
        .join(", "),
    };
  }
  return {
    verdict: "BLOCKED",
    detail: day0.map((m) => `${m.ch} ${m.st}`).join(", "),
  };
}

async function emailHeadroom(): Promise<string> {
  const rows = (await sql`
    select sp.label, sp.status, sp.ramp_stage, sp.daily_limit,
           (select count(*)::int from outreach_messages om
             where om.sending_profile_id = sp.id and om.status = 'sent'
               and om.sent_at > current_date) as sent_today
    from sending_profiles sp where sp.kind = 'email_domain' order by sp.label
  `) as Array<Record<string, number | string>>;
  let ceiling = 0;
  let remaining = 0;
  const parts: string[] = [];
  for (const r of rows) {
    const ramp = Math.min(
      RAMP_CEILING,
      RAMP_BASE + RAMP_INCREMENT * Number(r.ramp_stage),
    );
    const cap = Math.min(Number(r.daily_limit), ramp);
    const left = Math.max(0, cap - Number(r.sent_today));
    ceiling += cap;
    remaining += left;
    parts.push(`${r.label} ${r.sent_today}/${cap}${r.status === "throttled" ? " (throttled)" : ""}`);
  }
  return `email ceiling today ${ceiling}, ${remaining} left — ${parts.join(" · ")}`;
}

async function main() {
  const [settings] = (await sql`
    select daily_send_cap, max_contacts_per_company, enabled, dry_run
    from outreach_settings
  `) as Array<Record<string, number | boolean>>;
  const maxPerCompany = Number(settings?.max_contacts_per_company ?? 3);

  const rows = (await sql`
    select co.name as company, cl.call_status,
           coalesce(nullif(trim(ct.name), ''), '(no name)') as contact,
           coalesce(ct.work_email, ct.email, ct.personal_email) as email,
           coalesce(ct.personal_phone, ct.phone) as phone,
           ct.email_deliverable,
           (select s.reason from suppressions s
             where (s.email is not null and lower(s.email) = lower(coalesce(ct.work_email, ct.email, ct.personal_email)))
                or (s.phone is not null and regexp_replace(s.phone, '\\D', '', 'g')
                    = regexp_replace(coalesce(ct.personal_phone, ct.phone, ''), '\\D', '', 'g')
                    and coalesce(ct.personal_phone, ct.phone) is not null)
             limit 1) as suppressed_reason,
           se.id as enrollment_id, se.status as enrollment_status,
           (select json_agg(json_build_object(
                     'kind', om.step_kind, 'ch', om.channel, 'st', om.status,
                     'sched', om.scheduled_for, 'sent', om.sent_at,
                     'defer', om.deferred_reason, 'err', left(coalesce(om.error, ''), 60)))
              from outreach_messages om
             where om.enrollment_id = se.id
               and om.step_kind in ('intro', 'text_1')) as day0
    from call_list_entries cl
    join companies co on co.id = cl.company_id
    join contacts ct on ct.company_id = co.id
    left join sequence_enrollments se on se.contact_id = ct.id
    order by co.name, contact
  `) as Array<Record<string, unknown>>;

  const enrollmentsByCompany = new Map<string, number>();
  for (const r of rows) {
    if (r.enrollment_id) {
      const key = r.company as string;
      enrollmentsByCompany.set(key, (enrollmentsByCompany.get(key) ?? 0) + 1);
    }
  }

  const classified = rows.map((r) => ({
    company: r.company as string,
    contact: r.contact as string,
    channels:
      [(r.email as string | null) ? "email" : null, (r.phone as string | null) ? "text" : null]
        .filter(Boolean)
        .join("+") || "none",
    ...classify(r, maxPerCompany, enrollmentsByCompany),
  }));

  const counts = new Map<Verdict, number>();
  for (const c of classified) counts.set(c.verdict, (counts.get(c.verdict) ?? 0) + 1);

  console.log(
    `\n=== ${classified.length} contact(s) across ${new Set(classified.map((c) => c.company)).size} Call List compan(ies) ===`,
  );
  console.log(
    `settings: send ${settings?.enabled ? "ON" : "OFF"}, dry-run ${settings?.dry_run ? "ON" : "off"}, ` +
      `daily_send_cap ${settings?.daily_send_cap}, max_contacts_per_company ${maxPerCompany}`,
  );
  console.log(await emailHeadroom());

  console.table(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([verdict, n]) => ({
        verdict,
        contacts: n,
        meaning: OK.has(verdict) ? "fine, no action" : "needs a human",
      })),
  );

  const problems = classified.filter((c) => !OK.has(c.verdict));
  if (problems.length) {
    console.log(`\n=== ${problems.length} contact(s) with no outbound and a real reason ===`);
    console.table(problems);
  } else {
    console.log("\nEvery Call List contact has been messaged or is scheduled to be.");
  }

  if (!PROBLEMS_ONLY) {
    const waiting = classified.filter((c) => c.verdict === "SCHEDULED" || c.verdict === "DUE NOW");
    if (waiting.length) {
      console.log(`\n=== ${waiting.length} contact(s) queued and waiting (not a failure) ===`);
      console.table(waiting);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
