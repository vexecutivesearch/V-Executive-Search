import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log("=== every drafting failure ever recorded ===");
  console.table(
    await sql`
      select ev.created_at::text, ev.actor,
             ev.payload->>'draft_failure' as draft_failure,
             coalesce(co.name, '(no company)') as company
      from enrollment_events ev
      left join companies co on co.id = (ev.payload->>'company_id')::uuid
      where ev.payload->>'draft_failure' is not null
      order by ev.created_at desc
    `,
  );

  console.log("=== enroll failure notes on the call list ===");
  console.table(
    await sql`
      select ca.created_at::text, co.name as company, ca.summary
      from company_activities ca
      join companies co on co.id = ca.company_id
      where ca.summary like 'Outreach enroll failed%'
      order by ca.created_at desc
    `,
  );

  console.log("=== intro emails that DID pass, for style comparison ===");
  const bodies = await sql`
    select co.name as company, om.step_kind, om.subject, om.body
    from outreach_messages om
    join sequence_enrollments se on se.id = om.enrollment_id
    join companies co on co.id = se.company_id
    where om.step_kind = 'intro'
    order by om.created_at desc
    limit 3
  `;
  for (const row of bodies) {
    console.log(`\n--- ${row.company} / ${row.subject} ---\n${row.body}`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
