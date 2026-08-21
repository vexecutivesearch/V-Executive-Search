import { describe, expect, it } from "vitest";

import { assertSelectOnly } from "./read-only-sql";

/**
 * The verification scripts run against production, so the claim that they
 * cannot write has to be tested rather than asserted in a comment.
 *
 * Postgres is the real enforcement — every statement goes out in a
 * `readOnly: true` transaction — but that only fails after a round trip, and a
 * script that gets as far as asking the server to DELETE has already lost the
 * argument. This is the client-side half: the static fragments of the template
 * are checked before the query leaves the process.
 */
describe("the read-only guard", () => {
  it("allows the shapes the scripts actually use", () => {
    const safe = [
      ["select 1"],
      ["select a from t where b = ", " and c = ", ""],
      ["with x as (select 1) select * from x"],
      ["select to_regclass(", ") is not null as present"],
    ];
    for (const fragments of safe) {
      expect(() => assertSelectOnly(fragments)).not.toThrow();
    }
  });

  it("does not trip on column and table names that contain a keyword", () => {
    // `updated_at`, `created_at` and `outreach_settings` all embed a write
    // keyword. The pattern is word-anchored so they read as identifiers.
    expect(() =>
      assertSelectOnly([
        "select updated_at, created_at from outreach_settings",
      ]),
    ).not.toThrow();
  });

  it("refuses every statement that changes data or structure", () => {
    const writes = [
      ["insert into companies (name) values (", ")"],
      ["update companies set name = ", ""],
      ["delete from companies"],
      ["truncate companies"],
      ["drop table companies"],
      ["alter table companies add column x text"],
      ["create index foo on companies (id)"],
      ["grant all on companies to public"],
    ];
    for (const fragments of writes) {
      expect(() => assertSelectOnly(fragments)).toThrow(/read-only guard/);
    }
  });

  it("refuses a write smuggled in after a leading select", () => {
    expect(() => assertSelectOnly(["select 1; drop table companies"])).toThrow(
      /drop/i,
    );
  });

  it("refuses a write hidden behind a comment", () => {
    // Comments are stripped first, so the DELETE is what gets classified
    // rather than the SELECT that was commented out in front of it.
    expect(() =>
      assertSelectOnly(["-- select 1\ndelete from companies"]),
    ).toThrow(/read-only guard/);
  });

  it("refuses statements with a side effect that is not a write keyword", () => {
    expect(() => assertSelectOnly(["select nextval('seq')"])).toThrow(
      /nextval/i,
    );
    expect(() => assertSelectOnly(["select pg_terminate_backend(1)"])).toThrow(
      /pg_terminate_backend/i,
    );
  });
});
