import { describe, expect, it } from "vitest";
import {
  isCalendlyNotificationAddress,
  parseCalendlyNotificationEmail,
  parseCalendlySubjectDateTime,
  stripHtmlToText,
} from "@/lib/outreach/calendly-email";
import {
  nameMatchStrength,
  namesMatchInvitee,
  normalizePersonName,
  significantNameTokens,
} from "@/lib/outreach/calendly-booking";

describe("isCalendlyNotificationAddress", () => {
  it("accepts Calendly notification From addresses", () => {
    expect(isCalendlyNotificationAddress("notifications@calendly.com")).toBe(
      true,
    );
    expect(
      isCalendlyNotificationAddress("teamcalendly@send.calendly.com"),
    ).toBe(true);
    expect(isCalendlyNotificationAddress("Miguel@Cultura.company")).toBe(
      false,
    );
  });
});

describe("parseCalendlyNotificationEmail", () => {
  it("parses New Event subject name + ET start time", () => {
    const parsed = parseCalendlyNotificationEmail({
      subject:
        "New Event: Miguel Lozano - 09:00am Fri, Jul 31, 2026 - 30 Minute Meeting",
      body: "<html>ignored for MVP</html>",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("created");
    expect(parsed!.inviteeName).toBe("Miguel Lozano");
    expect(parsed!.eventTitle).toBe("30 Minute Meeting");
    expect(parsed!.startTime?.toISOString()).toBe("2026-07-31T13:00:00.000Z");
    expect(parsed!.endTime?.toISOString()).toBe("2026-07-31T13:30:00.000Z");
  });

  it("parses Canceled Event subjects", () => {
    const parsed = parseCalendlyNotificationEmail({
      subject:
        "Canceled Event: Miguel Lozano - 09:00am Fri, Jul 31, 2026 - 30 Minute Meeting",
    });
    expect(parsed!.kind).toBe("canceled");
    expect(parsed!.inviteeName).toBe("Miguel Lozano");
  });

  it("treats teamcalendly marketing as no-op marketing", () => {
    const parsed = parseCalendlyNotificationEmail({
      subject: "You did it — your first booking is in!",
    });
    expect(parsed!.kind).toBe("marketing");
    expect(parsed!.inviteeName).toBeNull();
  });
});

describe("parseCalendlySubjectDateTime", () => {
  it("converts ET wall clock to UTC", () => {
    const d = parseCalendlySubjectDateTime("09:00am Fri, Jul 31, 2026");
    expect(d?.toISOString()).toBe("2026-07-31T13:00:00.000Z");
  });
});

describe("stripHtmlToText", () => {
  it("strips tags for body fallbacks", () => {
    expect(stripHtmlToText("<p>Invitee: <b>Miguel</b></p>")).toContain(
      "Invitee: Miguel",
    );
  });
});

describe("nameMatchStrength", () => {
  it("matches exact, middle initial, and reorder", () => {
    expect(nameMatchStrength("Miguel Lozano", "Miguel Lozano")).toBe("exact");
    // Middle initial dropped → same significant tokens → exact
    expect(nameMatchStrength("Miguel Lozano", "Miguel A. Lozano")).toBe(
      "exact",
    );
    expect(nameMatchStrength("Lozano Miguel", "Miguel Lozano")).toBe("exact");
    expect(normalizePersonName("Miguel A. Lozano")).toBe("miguel a lozano");
    expect(significantNameTokens("Miguel A. Lozano")).toEqual([
      "miguel",
      "lozano",
    ]);
    // Extra significant middle name → strong (first+last present)
    expect(nameMatchStrength("Miguel Lozano", "Miguel Antonio Lozano")).toBe(
      "strong",
    );
  });

  it("partial first-name only", () => {
    expect(nameMatchStrength("Miguel", "Miguel Lozano")).toBe("partial");
    expect(namesMatchInvitee("Miguel", "Miguel Lozano")).toBe(false);
  });

  it("rejects unrelated names", () => {
    expect(nameMatchStrength("Jane Smith", "Miguel Lozano")).toBe("none");
  });
});
