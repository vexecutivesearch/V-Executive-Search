import { execSync } from "child_process";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Scope guard for the selective-enrichment features. These features touch the
 * paid enrich path deliberately, but must NOT change the scraper, worker,
 * ingestion, or Today's List. Commits whose message starts with "Enrich:" are
 * checked here (same mechanism as the ICP scope guard).
 */

const FORBIDDEN_DIFF_PATHS = [
  /^worker\//,
  /^Playwright\//,
  /^src\/app\/api\/ingest\//,
  /^src\/app\/today\//,
  /^src\/components\/TodayList/,
];

describe("enrich feature scope guard", () => {
  it("'Enrich:'-prefixed commits touch no scraper/ingest/Today's List files", () => {
    let hashes: string[] = [];
    try {
      hashes = execSync('git log --format=%H --grep="^Enrich:" -50', {
        cwd: path.resolve(__dirname, "../../.."),
        encoding: "utf8",
      })
        .split("\n")
        .map((h) => h.trim())
        .filter(Boolean);
    } catch {
      return; // git unavailable in this context
    }

    for (const hash of hashes) {
      const changed = execSync(`git show --name-only --format="" ${hash}`, {
        cwd: path.resolve(__dirname, "../../.."),
        encoding: "utf8",
      })
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      for (const file of changed) {
        const violation = FORBIDDEN_DIFF_PATHS.find((re) => re.test(file));
        expect(
          violation,
          `Enrich commit ${hash.slice(0, 8)} touches forbidden file ${file}`,
        ).toBeUndefined();
      }
    }
  });
});
