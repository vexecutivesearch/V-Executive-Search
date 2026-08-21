/**
 * Does the deployed database actually have what the Drizzle schema says it has?
 *
 * Two outages this week had one cause: a migration was generated, the PR merged
 * and deployed, and the running code referenced a column the database did not
 * have. Drizzle emits an explicit column list on every select, so the first
 * read of that table threw and the page returned HTTP 500. Nothing in the build
 * catches it — the TypeScript compiles perfectly, because the type came from
 * the same file that was wrong.
 *
 * This compares src/lib/db/schema.ts against information_schema and pg_catalog
 * and exits non-zero when the code expects something the database lacks, so it
 * can gate a deploy. It reads the Drizzle table objects themselves rather than
 * a hand-kept list, so a table added tomorrow is covered with no edit here.
 *
 * What blocks a deploy (the code would throw at runtime):
 *   - a table in the schema that the database does not have
 *   - a column in the schema that the table does not have
 *   - an enum value the code can write that the database enum does not accept
 *   - a unique index the code needs, because ON CONFLICT against a missing one
 *     is a runtime error, not a silently ignored hint
 *
 * What is reported but does not block (add --strict to make these block):
 *   - a column whose SQL type differs between code and database
 *   - a column the database requires that the code treats as optional with no
 *     default, which fails on INSERT rather than on read
 *   - a column the code marks NOT NULL that the database lets be null, which
 *     hands TypeScript a null it has typed as non-null
 *
 * Extras — tables, columns and enum values the database has and the code does
 * not — are listed for information. They never block: a column dropped from
 * the schema before its migration lands is safe, and an unrelated table in the
 * same database is none of this check's business.
 *
 * Usage:
 *   npx tsx scripts/check-schema-drift.ts             # gate: blocking drift only
 *   npx tsx scripts/check-schema-drift.ts --all       # also list every extra
 *   npx tsx scripts/check-schema-drift.ts --strict    # type/nullability drift blocks too
 *   npx tsx scripts/check-schema-drift.ts --json      # machine readable, for CI
 *   npx tsx scripts/check-schema-drift.ts --table companies --table contacts
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { is } from "drizzle-orm";
import { PgTable, getTableConfig, isPgEnum } from "drizzle-orm/pg-core";
import type { PgEnum } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";
import { readOnlySql } from "./lib/read-only-sql";

const ARGV = process.argv.slice(2);
const SHOW_ALL = ARGV.includes("--all");
const STRICT = ARGV.includes("--strict");
const AS_JSON = ARGV.includes("--json");
const ONLY_TABLES = new Set(
  ARGV.flatMap((arg, i) =>
    arg === "--table" ? [ARGV[i + 1]] : arg.startsWith("--table=") ? [arg.slice(8)] : [],
  ).filter(Boolean),
);

const sql = readOnlySql();

/* ------------------------------------------------------------------ */
/* What the code expects                                               */
/* ------------------------------------------------------------------ */

type ExpectedColumn = {
  name: string;
  /** Drizzle's SQL type, e.g. "uuid", "integer", "company_status". */
  sqlType: string;
  notNull: boolean;
  hasDefault: boolean;
  isEnum: boolean;
};

type ExpectedIndex = {
  name: string | null;
  columns: string[];
  unique: boolean;
};

type ExpectedTable = {
  name: string;
  schema: string;
  columns: ExpectedColumn[];
  indexes: ExpectedIndex[];
};

function expectedTables(): ExpectedTable[] {
  const out: ExpectedTable[] = [];
  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const cfg = getTableConfig(exported as PgTable);

    const columns: ExpectedColumn[] = cfg.columns.map((column) => ({
      name: column.name,
      sqlType: column.getSQLType(),
      notNull: column.notNull,
      hasDefault: column.hasDefault,
      // An enum column's SQL type IS the Postgres enum type name.
      isEnum: column.enumValues != null && column.enumValues.length > 0,
    }));

    // Unique indexes and unique constraints both back ON CONFLICT, and a
    // column-level .unique() is a third spelling of the same thing.
    const indexes: ExpectedIndex[] = [];
    for (const index of cfg.indexes) {
      const built = index.config;
      if (!built.unique) continue;
      indexes.push({
        name: built.name ?? null,
        columns: built.columns
          .map((c) => ("name" in c ? String(c.name) : ""))
          .filter(Boolean),
        unique: true,
      });
    }
    for (const constraint of cfg.uniqueConstraints) {
      indexes.push({
        name: constraint.name ?? null,
        columns: constraint.columns.map((c) => c.name),
        unique: true,
      });
    }
    for (const column of cfg.columns) {
      if (column.isUnique) {
        indexes.push({
          name: column.uniqueName ?? null,
          columns: [column.name],
          unique: true,
        });
      }
    }

    out.push({
      name: cfg.name,
      schema: cfg.schema ?? "public",
      columns,
      indexes,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function expectedEnums(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const exported of Object.values(schema)) {
    if (!isPgEnum(exported)) continue;
    const pgEnumValue = exported as PgEnum<[string, ...string[]]>;
    out.set(pgEnumValue.enumName, [...pgEnumValue.enumValues]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* What the database has                                               */
/* ------------------------------------------------------------------ */

type LiveColumn = {
  table_name: string;
  column_name: string;
  udt_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

type LiveIndex = {
  table_name: string;
  index_name: string;
  columns: string;
};

async function liveTables(): Promise<Set<string>> {
  const rows = await sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `;
  return new Set(rows.map((r) => r.table_name));
}

async function liveColumns(): Promise<Map<string, Map<string, LiveColumn>>> {
  const rows = await sql<LiveColumn>`
    select table_name, column_name, udt_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position
  `;
  const byTable = new Map<string, Map<string, LiveColumn>>();
  for (const row of rows) {
    const table = byTable.get(row.table_name) ?? new Map<string, LiveColumn>();
    table.set(row.column_name, row);
    byTable.set(row.table_name, table);
  }
  return byTable;
}

async function liveEnums(): Promise<Map<string, string[]>> {
  const rows = await sql<{ enum_name: string; label: string }>`
    select t.typname as enum_name, e.enumlabel as label
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
    order by t.typname, e.enumsortorder
  `;
  const byName = new Map<string, string[]>();
  for (const row of rows) {
    byName.set(row.enum_name, [...(byName.get(row.enum_name) ?? []), row.label]);
  }
  return byName;
}

/**
 * Unique indexes, by the columns they cover rather than by name. Drizzle,
 * drizzle-kit and a hand-written migration can each name the same index
 * differently; what ON CONFLICT resolves against is the column set.
 */
async function liveUniqueIndexes(): Promise<LiveIndex[]> {
  return sql<LiveIndex>`
    select
      t.relname as table_name,
      i.relname as index_name,
      (
        select string_agg(att.attname, ',' order by att.attname)
        from unnest(ix.indkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = t.oid and att.attnum = k.attnum
      ) as columns
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    join pg_class t on t.oid = ix.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and ix.indisunique and ix.indislive
  `;
}

/* ------------------------------------------------------------------ */
/* Type comparison                                                     */
/* ------------------------------------------------------------------ */

/** Drizzle's SQL type spelling → the `udt_name` Postgres reports. */
const TYPE_ALIASES: Record<string, string> = {
  "integer": "int4",
  "int": "int4",
  "serial": "int4",
  "bigint": "int8",
  "bigserial": "int8",
  "smallint": "int2",
  "smallserial": "int2",
  "boolean": "bool",
  "real": "float4",
  "double precision": "float8",
  "character varying": "varchar",
  "character": "bpchar",
  "timestamp": "timestamp",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
  "decimal": "numeric",
};

/** "varchar(64)[]" → "varchar[]"; "timestamp (3) with time zone" → "timestamptz". */
function normalizeType(raw: string): string {
  let value = raw.trim().toLowerCase();
  let arrayDepth = 0;
  while (value.endsWith("[]")) {
    arrayDepth += 1;
    value = value.slice(0, -2).trim();
  }
  // Strip precision/length: "numeric(10, 2)" and "timestamp (3) with time zone".
  value = value.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const mapped = TYPE_ALIASES[value] ?? value;
  return mapped + "[]".repeat(arrayDepth);
}

/** Postgres reports array types as "_text"; say "text[]" like the code does. */
function normalizeUdt(udtName: string): string {
  const value = udtName.trim().toLowerCase();
  return value.startsWith("_") ? `${value.slice(1)}[]` : value;
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

type Finding = {
  severity: "blocking" | "warning" | "info";
  kind: string;
  object: string;
  detail: string;
};

const findings: Finding[] = [];
const add = (f: Finding) => findings.push(f);

async function main() {
  const tables = expectedTables().filter(
    (t) => !ONLY_TABLES.size || ONLY_TABLES.has(t.name),
  );
  const enums = expectedEnums();

  const [dbTables, dbColumns, dbEnums, dbIndexes] = await Promise.all([
    liveTables(),
    liveColumns(),
    liveEnums(),
    liveUniqueIndexes(),
  ]);

  const indexesByTable = new Map<string, Set<string>>();
  const indexNamesByTable = new Map<string, Set<string>>();
  for (const index of dbIndexes) {
    const key = (index.columns ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .sort()
      .join(",");
    const set = indexesByTable.get(index.table_name) ?? new Set<string>();
    set.add(key);
    indexesByTable.set(index.table_name, set);
    const names = indexNamesByTable.get(index.table_name) ?? new Set<string>();
    names.add(index.index_name);
    indexNamesByTable.set(index.table_name, names);
  }

  /* --- tables and columns ------------------------------------------ */
  const expectedColumnKeys = new Set<string>();

  for (const table of tables) {
    if (table.schema !== "public") continue;

    if (!dbTables.has(table.name)) {
      add({
        severity: "blocking",
        kind: "missing table",
        object: table.name,
        detail:
          `the schema defines ${table.columns.length} column(s); the database has no such table. ` +
          "Every query against it throws.",
      });
      continue;
    }

    const live = dbColumns.get(table.name) ?? new Map<string, LiveColumn>();

    for (const column of table.columns) {
      expectedColumnKeys.add(`${table.name}.${column.name}`);
      const liveColumn = live.get(column.name);

      if (!liveColumn) {
        add({
          severity: "blocking",
          kind: "missing column",
          object: `${table.name}.${column.name}`,
          detail:
            `code expects ${column.sqlType}${column.notNull ? " not null" : ""}; ` +
            "the column does not exist. Drizzle names every column in its select " +
            "list, so every read of this table throws.",
        });
        continue;
      }

      const want = normalizeType(column.sqlType);
      const got = normalizeUdt(liveColumn.udt_name);
      if (want !== got) {
        add({
          severity: STRICT ? "blocking" : "warning",
          kind: "type mismatch",
          object: `${table.name}.${column.name}`,
          detail: `code says ${column.sqlType} (${want}), database has ${liveColumn.data_type} (${got})`,
        });
      }

      const dbNullable = liveColumn.is_nullable === "YES";
      if (!dbNullable && !column.notNull && !column.hasDefault) {
        add({
          severity: STRICT ? "blocking" : "warning",
          kind: "insert will fail",
          object: `${table.name}.${column.name}`,
          detail:
            "the database requires a value and has no default, but the code " +
            "treats the column as optional — inserts that omit it fail.",
        });
      }
      if (dbNullable && column.notNull) {
        add({
          severity: STRICT ? "blocking" : "warning",
          kind: "null leaks into a non-null type",
          object: `${table.name}.${column.name}`,
          detail:
            "the code types this as always present, but the database allows " +
            "null — existing null rows arrive as null in code typed non-null.",
        });
      }
    }

    /* --- unique indexes the code relies on -------------------------- */
    const liveKeys = indexesByTable.get(table.name) ?? new Set<string>();
    const liveNames = indexNamesByTable.get(table.name) ?? new Set<string>();
    for (const index of table.indexes) {
      const key = [...index.columns].sort().join(",");
      if (!key) continue;
      if (liveKeys.has(key)) continue;
      if (index.name && liveNames.has(index.name)) continue;
      add({
        severity: "blocking",
        kind: "missing unique index",
        object: `${table.name} (${index.columns.join(", ")})`,
        detail:
          `${index.name ?? "unnamed"} is declared unique in the schema but no unique index ` +
          "covers those columns. ON CONFLICT against it raises " +
          '"there is no unique or exclusion constraint matching the ON CONFLICT specification".',
      });
    }
  }

  /* --- enums -------------------------------------------------------- */
  for (const [name, values] of enums) {
    const live = dbEnums.get(name);
    if (!live) {
      // Only blocking when a column in the schema actually uses it; an unused
      // enum export is harmless.
      const used = tables.some((t) => t.columns.some((c) => c.sqlType === name));
      add({
        severity: used ? "blocking" : "info",
        kind: "missing enum type",
        object: name,
        detail: `code defines values [${values.join(", ")}]; the type does not exist in the database.`,
      });
      continue;
    }
    const missing = values.filter((v) => !live.includes(v));
    if (missing.length) {
      add({
        severity: "blocking",
        kind: "missing enum value",
        object: name,
        detail:
          `code can write [${missing.join(", ")}], which the database enum does not accept. ` +
          "Writing one raises an invalid input value error.",
      });
    }
    const extra = live.filter((v) => !values.includes(v));
    if (extra.length) {
      add({
        severity: "info",
        kind: "extra enum value",
        object: name,
        detail: `database also accepts [${extra.join(", ")}], which the code never produces.`,
      });
    }
  }

  /* --- extras the database has and the code does not ---------------- */
  const expectedTableNames = new Set(tables.map((t) => t.name));
  if (!ONLY_TABLES.size) {
    for (const name of dbTables) {
      // Drizzle's own migration bookkeeping is not part of the app schema.
      if (name.startsWith("__drizzle") || name.startsWith("drizzle_")) continue;
      if (expectedTableNames.has(name)) continue;
      add({
        severity: "info",
        kind: "extra table",
        object: name,
        detail: "present in the database, absent from schema.ts — dropped from the code, or never modelled.",
      });
    }
  }
  for (const table of tables) {
    const live = dbColumns.get(table.name);
    if (!live) continue;
    for (const columnName of live.keys()) {
      if (expectedColumnKeys.has(`${table.name}.${columnName}`)) continue;
      add({
        severity: "info",
        kind: "extra column",
        object: `${table.name}.${columnName}`,
        detail: "present in the database, absent from schema.ts — safe to read past, but nothing in code uses it.",
      });
    }
  }

  /* --- report -------------------------------------------------------- */
  const blocking = findings.filter((f) => f.severity === "blocking");
  const warnings = findings.filter((f) => f.severity === "warning");
  const info = findings.filter((f) => f.severity === "info");

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          ok: blocking.length === 0,
          checkedTables: tables.length,
          checkedEnums: enums.size,
          blocking,
          warnings,
          info: SHOW_ALL ? info : info.slice(0, 25),
          infoTotal: info.length,
        },
        null,
        2,
      ),
    );
    if (blocking.length) process.exitCode = 1;
    return;
  }

  console.log(
    `\n=== Schema drift: ${tables.length} table(s) and ${enums.size} enum(s) in ` +
      `src/lib/db/schema.ts vs the live database ===\n`,
  );

  if (blocking.length) {
    console.log(
      `${blocking.length} blocking difference(s) — the deployed code would throw:`,
    );
    console.table(
      blocking.map((f) => ({ what: f.kind, object: f.object, detail: f.detail })),
    );
  } else {
    console.log(
      "No blocking drift: every table, column, enum value and unique index the " +
        "code expects exists in the database.",
    );
  }

  if (warnings.length) {
    console.log(
      `\n${warnings.length} difference(s) that do not stop a read but will bite ` +
        `(re-run with --strict to make these block):`,
    );
    console.table(
      warnings.map((f) => ({ what: f.kind, object: f.object, detail: f.detail })),
    );
  }

  if (info.length) {
    const shown = SHOW_ALL ? info : info.slice(0, 10);
    console.log(
      `\n${info.length} thing(s) the database has and the code does not ` +
        `(never blocking${SHOW_ALL ? "" : `; showing ${shown.length}, pass --all for the rest`}):`,
    );
    console.table(
      shown.map((f) => ({ what: f.kind, object: f.object, detail: f.detail })),
    );
  }

  if (blocking.length) {
    console.error(
      `\nFAIL: ${blocking.length} blocking schema difference(s). ` +
        "Run the pending migration against this database before deploying.",
    );
    process.exitCode = 1;
  } else {
    console.log("\nPASS: the database matches what the code expects.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
