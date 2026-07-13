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

  it("only enables backlog when explicitly true", () => {
    expect(
      normalizeEmailReportPreferences({
        includeBacklogSection: true,
      }).includeBacklogSection,
    ).toBe(true);
  });

  it("defaults Hot Listings email section to on", () => {
    expect(DEFAULT_EMAIL_REPORT_PREFERENCES.includeHotListingsSection).toBe(
      true,
    );
    expect(
      normalizeEmailReportPreferences(null).includeHotListingsSection,
    ).toBe(true);
    expect(normalizeEmailReportPreferences({}).includeHotListingsSection).toBe(
      true,
    );
  });

  it("disables Hot Listings only when explicitly false", () => {
    expect(
      normalizeEmailReportPreferences({
        includeHotListingsSection: false,
      }).includeHotListingsSection,
    ).toBe(false);
  });
});
