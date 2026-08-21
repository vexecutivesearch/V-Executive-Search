import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CallListView } from "@/components/crm/CallListView";
import type { CallListItem } from "@/lib/crm-queries";
import type { CallListEntry } from "@/lib/db/schema";

const COMPANY_A = "53b96f06-482d-4b27-9b28-3bbcfac2c287";
const COMPANY_B = "63b96f06-482d-4b27-9b28-3bbcfac2c288";

function entry(id: string, companyId: string): CallListEntry {
  return {
    id,
    companyId,
    primaryContactId: null,
    jobListingId: null,
    callStatus: "ready_to_call",
    callStatusUpdatedAt: new Date("2026-08-20T16:00:00.000Z"),
    outreachAngle: null,
    attempts: 0,
    lastContactAt: null,
    nextFollowUpDate: null,
    notes: null,
    assignedTo: null,
    finalResult: null,
    addedAt: new Date("2026-08-18T12:00:00.000Z"),
    updatedAt: new Date("2026-08-20T16:00:00.000Z"),
  };
}

function item(id: string, companyId: string, name: string): CallListItem {
  return {
    entry: entry(id, companyId),
    company: {
      id: companyId,
      name,
      domain: null,
      domainConfidence: "high",
      status: "new",
      firstSeen: "2026-08-18",
      leadScore: 70,
      contacts: [],
      jobListings: [],
    },
    marketLabel: "Miami, FL",
    outreach: null,
    booking: null,
  };
}

describe("CallListView — select and export selected", () => {
  it("ships a disabled Export selected next to row checkboxes", () => {
    const html = renderToStaticMarkup(
      createElement(CallListView, {
        items: [
          item("entry-a", COMPANY_A, "Acme"),
          item("entry-b", COMPANY_B, "Beta"),
        ],
      }),
    );
    expect(html).toContain("Export selected");
    expect(html).not.toContain("Export selected (");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="Select all visible rows"');
    expect(html).toContain('aria-label="Select Acme"');
    expect(html).toContain('aria-label="Select Beta"');
    expect(html).toContain("Select all visible");
  });
});
