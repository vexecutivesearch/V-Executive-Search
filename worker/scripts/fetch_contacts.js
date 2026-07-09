const { neon } = require("@neondatabase/serverless");
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "../../.env.local"),
  quiet: true,
});

const names = process.argv.slice(2);
if (!names.length) {
  console.error("Usage: node fetch_contacts.js <name>...");
  process.exit(1);
}

const placeholders = names.map((_, i) => `$${i + 1}`).join(", ");
const sql = neon(process.env.DATABASE_URL);

(async () => {
  const rows = await sql.query(
    `SELECT c.id, c.name, co.name as company, c.title, c.email, c.work_email, c.personal_email,
            c.phone, c.personal_phone, c.company_phone, c.phones, c.linkedin_url,
            c.imessage_capable, c.source_provider,
            (SELECT jl.title FROM job_listings jl WHERE jl.company_id = c.company_id ORDER BY jl.created_at DESC LIMIT 1) as job_title
     FROM contacts c
     JOIN companies co ON co.id = c.company_id
     WHERE c.name IN (${placeholders})
     ORDER BY c.name`,
    names,
  );
  process.stdout.write(JSON.stringify(rows));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
