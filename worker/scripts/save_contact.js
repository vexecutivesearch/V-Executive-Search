const { neon } = require("@neondatabase/serverless");
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "../../.env.local"),
  quiet: true,
});

const contactId = process.argv[2];
const payload = JSON.parse(process.argv[3] || "{}");
const sql = neon(process.env.DATABASE_URL);

(async () => {
  await sql.query(
    `UPDATE contacts SET
      personal_email = $2,
      work_email = $3,
      email = $4,
      phones = $5::jsonb,
      phone = $6,
      personal_phone = $7,
      company_phone = $8,
      source_provider = $9
     WHERE id = $1`,
    [
      contactId,
      payload.personal_email,
      payload.work_email,
      payload.email,
      JSON.stringify(payload.phones || []),
      payload.phone,
      payload.personal_phone,
      payload.company_phone,
      payload.source_provider,
    ],
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
