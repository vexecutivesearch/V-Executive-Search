import { execSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * §7.6 Mechanical CI guard — the ICP feature must be annotation + view only.
 *
 * Two checks:
 * 1. Static: ICP modules must not import the scraper/worker, enrichment,
 *    egress, ingest, or Today's List code paths.
 * 2. Diff: every commit whose message starts with "ICP" must not touch
 *    forbidden files (worker/, ingest, enrich/egress modules, Today's List).
 */

const ICP_DIR = path.resolve(__dirname);

const FORBIDDEN_IMPORTS = [
  "apollo-enrich",
  "contactout",
  "paid-egress",
  "refresh-company-contacts",
  "domain-resolver",
  "/api/ingest",
  "TodayList",
  "/app/today",
];

const FORBIDDEN_DIFF_PATHS = [
  /^worker\//,
  /^Playwright\//,
  /^src\/app\/api\/ingest\//,
  /^src\/app\/api\/companies\/\[id\]\/enrich\//,
  /^src\/app\/api\/companies\/\[id\]\/refresh-contacts\//,
  /^src\/lib\/apollo-enrich/,
  /^src\/lib\/contactout/,
  /^src\/lib\/paid-egress/,
  /^src\/lib\/refresh-company-contacts/,
  /^src\/app\/today\//,
  /^src\/components\/TodayList/,
  // enrichCompanies lives here — the ICP layer must not modify it.
  /^src\/lib\/queries\.ts$/,
];

describe("ICP scope guard", () => {
  it("ICP modules import no scraper/enrich/egress/Today's List code", () => {
    const files = readdirSync(ICP_DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(path.join(ICP_DIR, file), "utf8");
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          source.includes(forbidden),
          `${file} must not reference ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it("ICP-prefixed commits touch no forbidden files", () => {
    let hashes: string[] = [];
    try {
      hashes = execSync('git log --format=%H --grep="^ICP" -50', {
        cwd: path.resolve(__dirname, "../../.."),
        encoding: "utf8",
      })
        .split("\n")
        .map((h) => h.trim())
        .filter(Boolean);
    } catch {
      return; // git unavailable (e.g. deployed bundle) — static check above still applies
    }

    for (const hash of hashes) {
      const changed = execSync(
        `git show --name-only --format="" ${hash}`,
        { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" },
      )
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      for (const file of changed) {
        const violation = FORBIDDEN_DIFF_PATHS.find((re) => re.test(file));
        expect(
          violation,
          `ICP commit ${hash.slice(0, 8)} touches forbidden file ${file}`,
        ).toBeUndefined();
      }
    }
  });
});
