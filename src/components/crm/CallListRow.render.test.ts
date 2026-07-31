import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CallListRow } from "@/components/crm/CallListRow";
import type { CallListBooking } from "@/lib/call-list-booking";
import type { CallListItem } from "@/lib/crm-queries";
import type { CallListEntry, CallStatus } from "@/lib/db/schema";

const COMPANY_ID = "53b96f06-482d-4b27-9b28-3bbcfac2c287";

/** Proven Theory LLC v8: replied positive 12:18 AM, booked 12:23 AM ET. */
const ENTRY: CallListEntry = {
  id: "entry-1",
  companyId: COMPANY_ID,
  primaryContactId: null,
  jobListingId: null,
  callStatus: "meeting_scheduled",
  callStatusUpdatedAt: new Date("2026-07-31T04:23:43.272Z"),
  outreachAngle: null,
  attempts: 2,
  lastContactAt: new Date("2026-07-31T04:18:37.028Z"),
  nextFollowUpDate: null,
  notes: null,
  assignedTo: "Miguel",
  finalResult: null,
  addedAt: new Date("2026-07-30T20:00:00.000Z"),
  updatedAt: new Date("2026-07-31T04:23:50.271Z"),
};

const COMPANY: CallListItem["company"] = {
  id: COMPANY_ID,
  name: "Proven Theory LLC v8",
  domain: "proventheory.example",
  domainConfidence: "high",
  status: "meeting",
  firstSeen: "2026-07-30",
  leadScore: 82,
  contacts: [],
  jobListings: [],
};

function render(overrides: {
  entry?: Partial<CallListEntry>;
  booking?: CallListBooking | null;
  callStatus?: CallStatus;
}): string {
  const item: CallListItem = {
    entry: {
      ...ENTRY,
      ...overrides.entry,
      ...(overrides.callStatus ? { callStatus: overrides.callStatus } : {}),
    },
    company: COMPANY,
    marketLabel: "Miami, FL",
    outreach: null,
    booking: overrides.booking ?? null,
  };
  return renderToStaticMarkup(
    createElement(CallListRow, {
      item,
      today: "2026-07-31",
      onEntryChange: () => {},
      onRemove: () => {},
    }),
  );
}

describe("CallListRow — Last Activity column", () => {
  it("stamps the same value the queue sorts on", () => {
    const html = render({});
    expect(html).toContain("Jul 31");
    expect(html).toContain("12:23 AM");
    expect(html).toContain("Last activity — Jul 31, 2026, 12:23 AM ET");
  });

  it("degrades to a dash when no stamp is usable", () => {
    const html = render({
      entry: {
        lastContactAt: null,
        callStatusUpdatedAt: null,
        updatedAt: new Date(""),
      },
    });
    expect(html).toContain("No activity recorded yet");
    expect(html).not.toContain("Last activity —");
  });
});

describe("CallListRow — booked meeting time", () => {
  it("renders the window from the structured booking", () => {
    const html = render({
      booking: {
        startAt: new Date("2026-08-03T13:00:00.000Z"),
        endAt: new Date("2026-08-03T13:15:00.000Z"),
      },
    });
    expect(html).toContain("Mon Aug 3, 9:00–9:15 AM ET");
    expect(html).toContain(
      "Meeting scheduled — Mon Aug 3, 2026, 9:00–9:15 AM ET",
    );
  });

  it("falls back to the Call Booked note line", () => {
    const html = render({
      entry: {
        notes: "[Jul 31, 12:25 AM] Call Booked: Mon Aug 3, 2026 9:00–9:15 AM ET",
      },
    });
    expect(html).toContain("Mon Aug 3, 2026 9:00–9:15 AM ET");
  });

  it("shows nothing when a booked row has no time anywhere", () => {
    expect(render({})).not.toContain("Meeting scheduled");
  });

  it("shows nothing for rows that are not booked", () => {
    const html = render({
      callStatus: "ready_to_call",
      booking: {
        startAt: new Date("2026-08-03T13:00:00.000Z"),
        endAt: null,
      },
    });
    expect(html).not.toContain("Aug 3");
  });
});
