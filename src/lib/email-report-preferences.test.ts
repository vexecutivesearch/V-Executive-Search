import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_REPORT_PREFERENCES,
  normalizeEmailReportPreferences,
} from "@/lib/email-report-preferences";

describe("email report preferences", () => {
  it("defaults backlog email section to off", () => {
    expect(DEFAULT_EMAIL_REPORT_PREFERENCES.includeBacklogSection).toBe(false);
    expect(normalizeEmailReportPreferences(null).includeBacklogSection).toBe(
      false,
    );
    expect(normalizeEmailReportPreferences({}).includeBacklogSection).toBe(
      false,
    );
  });

  it("only enables when explicitly true", () => {
    expect(
      normalizeEmailReportPreferences({
        includeBacklogSection: true,
      }).includeBacklogSection,
    ).toBe(true);
  });
});
