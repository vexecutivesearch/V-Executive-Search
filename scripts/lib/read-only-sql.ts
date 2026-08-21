/**
 * A `neon` query function that cannot write, for the verification scripts.
 *
 * These scripts run against production, so "read only" has to be a property of
 * the connection rather than a promise in a header comment. Two independent
 * guards:
 *
 *  1. Postgres enforces it. Every statement is submitted as a one-statement
 *     transaction with `Neon-Batch-Read-Only`, which is `SET TRANSACTION READ
 *     ONLY` on the server. An INSERT that slipped past review fails with
 *     "cannot execute INSERT in a read-only transaction" instead of running.
 *  2. The client refuses to send it. The static parts of the template are
 *     checked for a writing keyword before the query leaves the process, so a
 *     mistake shows up as a thrown error naming the statement rather than a
 *     server round trip.
 *
 * Interpolated values are parameterized by the driver and can never become
 * SQL, which is why only the static fragments need checking.
 *
 * Usage mirrors plain `neon`:
 *
 *   const sql = readOnlySql();
 *   const rows = await sql<{ n: number }>`select count(*)::int as n from companies`;
 */
import { neon } from "@neondatabase/serverless";

/**
 * Statement kinds that change data or structure. Word-anchored, so
 * `updated_at`, `created_at` and `outreach_settings` do not trip it.
 */
const WRITE_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "merge",
  "upsert",
  "vacuum",
  "reindex",
  "lock",
  "nextval",
  "setval",
  "pg_terminate_backend",
  "pg_cancel_backend",
];

const WRITE_PATTERN = new RegExp(`\\b(${WRITE_KEYWORDS.join("|")})\\b`, "i");

/** Strip comments so a keyword inside one is not mistaken for a statement. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function assertSelectOnly(fragments: readonly string[]): void {
  // Values are parameterized by the driver, so the static fragments are the
  // whole of the SQL that will be executed.
  const sql = stripComments(fragments.join(" $ ")).trim();
  const first = sql.replace(/^\(+\s*/, "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first !== "select" && first !== "with" && first !== "table") {
    throw new Error(
      `read-only guard: statement must start with SELECT or WITH, got "${first}" — ${sql.slice(0, 120)}`,
    );
  }
  const offender = WRITE_PATTERN.exec(sql);
  if (offender) {
    throw new Error(
      `read-only guard: refusing to run a statement containing "${offender[1]}" — ${sql.slice(0, 160)}`,
    );
  }
}

export type ReadOnlySql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export function readOnlySql(databaseUrl = process.env.DATABASE_URL): ReadOnlySql {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set — add it to .env.local before running this script.",
    );
  }
  const sql = neon(databaseUrl);
  return async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
    assertSelectOnly(strings.raw);
    const [rows] = await sql.transaction([sql(strings, ...values)], {
      readOnly: true,
    });
    return (rows ?? []) as T[];
  };
}

/** `123` → `"123"`, `null` → `"—"`; keeps console.table columns readable. */
export function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Exit code for a verification script. Scripts set this rather than calling
 * `process.exit`, so buffered stdout is flushed before the process ends.
 */
export function fail(reason: string): void {
  console.error(`\nFAIL: ${reason}`);
  process.exitCode = 1;
}
