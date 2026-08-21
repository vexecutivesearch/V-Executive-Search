import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_TEMPLATES } from "@/lib/outreach/seed-templates";

/**
 * Retiring an exemplar has to be expressed in the seed list, because seeding
 * runs on every enrollment: a row turned off by hand would otherwise be turned
 * back on minutes later. So the seeder pushes isActive false for exemplars
 * marked retired, and never pushes isActive true for anything.
 */

type Row = Record<string, unknown>;

const dialect = new PgDialect();
/** Rows the template bank currently holds, keyed by name. */
const bank = new Map<string, Row>();
const updates: Array<{ set: Row; name: string | undefined }> = [];
const inserts: Row[] = [];
const deletes: string[] = [];

function nameFrom(clause: SQL | undefined): string | undefined {
  if (!clause) return undefined;
  const params = dialect.sqlToQuery(clause).params;
  return params.find((p): p is string => typeof p === "string");
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (clause: SQL) => ({
          limit: () => {
            const name = nameFrom(clause);
            const row = name ? bank.get(name) : undefined;
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Row) => {
        void getTableName(table);
        inserts.push(values);
        return Promise.resolve([{ id: "inserted" }]);
      },
    }),
    update: () => ({
      set: (set: Row) => ({
        where: (clause: SQL) => {
          updates.push({ set, name: nameFrom(clause) });
          return Promise.resolve([]);
        },
      }),
    }),
    delete: () => ({
      where: (clause: SQL) => {
        deletes.push(nameFrom(clause) ?? "?");
        return Promise.resolve([]);
      },
    }),
  },
}));

/** The bank exactly as the seed list describes it, all rows active. */
function seedBankFromList(): void {
  for (const t of SEED_TEMPLATES) {
    bank.set(t.name, {
      id: `tpl-${t.name}`,
      name: t.name,
      kind: t.kind,
      channel: t.channel,
      isProven: t.isProven ?? false,
      isActive: true,
      exampleSubject: t.exampleSubject ?? null,
      exampleBody: t.exampleBody,
    });
  }
}

const retiredNames = SEED_TEMPLATES.filter((t) => t.isActive === false).map(
  (t) => t.name,
);

beforeEach(() => {
  vi.clearAllMocks();
  bank.clear();
  updates.length = 0;
  inserts.length = 0;
  deletes.length = 0;
});

describe("seeding the template bank", () => {
  it("turns a retired exemplar off, and touches nothing else", async () => {
    seedBankFromList();
    const { seedOutreachTemplates } = await import(
      "@/lib/outreach/seed-templates"
    );
    const changed = await seedOutreachTemplates();

    expect(retiredNames.length).toBeGreaterThan(0);
    expect(changed).toBe(retiredNames.length);
    expect(inserts).toEqual([]);
    expect(updates).toHaveLength(retiredNames.length);
    for (const update of updates) {
      expect(update.set.isActive).toBe(false);
    }
  });

  it("is idempotent once the retirement has landed", async () => {
    seedBankFromList();
    for (const name of retiredNames) {
      bank.set(name, { ...bank.get(name)!, isActive: false });
    }
    const { seedOutreachTemplates } = await import(
      "@/lib/outreach/seed-templates"
    );
    expect(await seedOutreachTemplates()).toBe(0);
    expect(updates).toEqual([]);
  });

  /*
   * The asymmetry that matters: an admin who switches an exemplar off in the
   * Template bank must not have the next enrollment switch it back on.
   */
  it("never reactivates an exemplar somebody turned off by hand", async () => {
    seedBankFromList();
    const byHand = SEED_TEMPLATES.find(
      (t) => t.kind === "followup_1" && t.isActive !== false,
    )!;
    bank.set(byHand.name, { ...bank.get(byHand.name)!, isActive: false });

    const { seedOutreachTemplates } = await import(
      "@/lib/outreach/seed-templates"
    );
    await seedOutreachTemplates();

    expect(updates.map((u) => u.name)).not.toContain(byHand.name);
    for (const update of updates) {
      expect(update.set.isActive).not.toBe(true);
    }
  });

  it("inserts a missing exemplar with the activity the seed list asks for", async () => {
    const { seedOutreachTemplates } = await import(
      "@/lib/outreach/seed-templates"
    );
    await seedOutreachTemplates();

    expect(inserts).toHaveLength(SEED_TEMPLATES.length);
    for (const t of SEED_TEMPLATES) {
      const inserted = inserts.find((i) => i.name === t.name);
      expect(inserted?.isActive, t.name).toBe(t.isActive ?? true);
    }
  });
});
