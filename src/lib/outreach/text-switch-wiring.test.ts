import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What each text path does with the switch off is covered by its own test:
 * channel-plan.test, text-switch-flow.test, the imessage-queue route test,
 * rules.test and booking-confirmation.test. What is left over is the wiring
 * those tests have to assume, because it is a column default and two call
 * sites rather than behaviour.
 */
const read = (path: string) => readFileSync(path, "utf8");

describe("the text channel switch", () => {
  it("ships off, in the schema and in the migration that adds it", () => {
    expect(read("src/lib/db/schema.ts")).toContain(
      'textEnabled: boolean("text_enabled").default(false).notNull()',
    );
    expect(read("drizzle/0002_outreach_text_enabled.sql")).toContain(
      '"text_enabled" boolean DEFAULT false NOT NULL',
    );
  });

  it("is flippable from the admin safety switches", () => {
    expect(read("src/app/api/admin/outreach/settings/route.ts")).toContain(
      '"textEnabled"',
    );
    expect(read("src/components/admin/outreach/OverviewTab.tsx")).toContain(
      'key: "textEnabled"',
    );
  });

  it("reaches the channel plan from the live settings row", () => {
    // channel-plan.test proves a plan with the switch off carries no text
    // step; this is the line that hands it the real switch at enroll time.
    expect(read("src/lib/outreach/enroll.ts")).toContain(
      "textEnabled: settings.textEnabled",
    );
  });
});
