import { describe, expect, it } from "vitest";
import {
  buildCallListCsvRow,
  CALL_LIST_HEADERS,
  type CallListCsvInput,
} from "@/lib/call-list-csv-row";

const COMPANY_ID = "53b96f06-482d-4b27-9b28-3bbcfac2c287";

const ENTRY: CallListCsvInput["entry"] = {
  primaryContactId: null,
  callStatus: "ready_to_call",
  outreachAngle: null,
  attempts: 0,
  lastContactAt: null,
  nextFollowUpDate: null,
  notes: null,
  assignedTo: null,
  finalResult: null,
  addedAt: new Date("2026-08-01T15:00:00.000Z"),
};

const COMPANY: CallListCsvInput["company"] = {
  id: COMPANY_ID,
  name: "Kessler & Vance LLP",
  domain: "kesslervance.example",
  domainConfidence: "high",
  status: "new",
  firstSeen: "2026-07-30",
  industry: "Law Practice",
  estimatedEmployees: 48,
  leadScore: 74,
  contacts: [],
  jobListings: [],
};

function row(over: Partial<CallListCsvInput> = {}) {
  return buildCallListCsvRow({
    entry: { ...ENTRY, ...(over.entry ?? {}) },
    company: { ...COMPANY, ...(over.company ?? {}) },
    marketLabel: over.marketLabel ?? "South Florida",
  });
}

function contact(over: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    companyId: COMPANY_ID,
    name: "Dana Kessler",
    title: "Managing Partner",
    workEmail: "dana@kesslervance.example",
    emailDeliverable: true,
    linkedinUrl: "https://linkedin.com/in/danakessler",
    ...over,
  } as unknown as CallListCsvInput["company"]["contacts"][number];
}

describe("call list CSV columns", () => {
  it("emits every column the operator asked for", () => {
    const built = row();
    for (const header of CALL_LIST_HEADERS) {
      expect(built).toHaveProperty(header);
    }
    // The operator's requested list, mapped onto real header names.
    for (const header of [
      "company_name",
      "industry",
      "city",
      "state",
      "company_size",
      "open_positions",
      "hiring_signals",
      "contact_name",
      "contact_title",
      "verified_email",
      "direct_phone",
      "main_company_phone",
      "company_linkedin",
      "linkedin_profile",
      "opportunity_score",
      "call_status",
      "next_follow_up_date",
      "notes",
    ] as const) {
      expect(CALL_LIST_HEADERS).toContain(header);
    }
  });

  it("uses human call status labels, not enum values", () => {
    expect(row().call_status).toBe("Ready to Call");
    expect(row({ entry: { ...ENTRY, callStatus: "meeting_scheduled" } })
      .call_status).toBe("Call Booked");
  });
});

describe("open_positions: blank versus zero", () => {
  it("is blank when we have no job data at all", () => {
    // "We never scraped this company" must not read as "they hire nobody".
    expect(row({ company: { ...COMPANY, jobListings: [] } }).open_positions).toBe(
      "",
    );
  });

  it("is 0 when we have job data and every listing is closed", () => {
    const built = row({
      company: {
        ...COMPANY,
        jobListings: [
          {
            id: "job-1",
            title: "Paralegal",
            location: "Boca Raton, FL",
            archivedAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        ] as unknown as CallListCsvInput["company"]["jobListings"],
      },
    });
    expect(built.open_positions).toBe(0);
  });

  it("counts only open listings when some are closed", () => {
    const built = row({
      company: {
        ...COMPANY,
        jobListings: [
          {
            id: "job-1",
            title: "Paralegal",
            location: "Boca Raton, FL",
            archivedAt: new Date("2026-06-01T00:00:00.000Z"),
          },
          { id: "job-2", title: "Legal Assistant", location: "Boca Raton, FL" },
        ] as unknown as CallListCsvInput["company"]["jobListings"],
      },
    });
    expect(built.open_positions).toBe(1);
    expect(built.hiring_signals).toContain("1 active job");
  });

  it("leaves hiring_signals blank rather than inventing a zero label", () => {
    expect(row().hiring_signals).toBe("");
  });
});

describe("company-only rows", () => {
  it("exports a company with no contact and no job posting", () => {
    // Neither a contact nor a job listing is a prerequisite for a call target.
    const built = row();
    expect(built.company_name).toBe("Kessler & Vance LLP");
    expect(built.contact_name).toBe("");
    expect(built.verified_email).toBe("");
    expect(built.open_positions).toBe("");
    expect(built.opportunity_score).toBe(74);
  });

  it("says 'size unknown' rather than 0 employees", () => {
    expect(
      row({ company: { ...COMPANY, estimatedEmployees: null } }).company_size,
    ).toBe("size unknown");
    expect(row().company_size).toBe("48");
  });
});

describe("contact columns", () => {
  it("fills contact, email and LinkedIn from the primary contact", () => {
    const built = row({
      entry: { ...ENTRY, primaryContactId: "contact-1" },
      company: { ...COMPANY, contacts: [contact()] },
    });
    expect(built.contact_name).toBe("Dana Kessler");
    expect(built.contact_title).toBe("Managing Partner");
    expect(built.verified_email).toBe("dana@kesslervance.example");
    expect(built.email_verified).toBe("yes");
    expect(built.linkedin_profile).toBe("https://linkedin.com/in/danakessler");
  });

  it("distinguishes never-verified from failed-verification", () => {
    const never = row({
      company: { ...COMPANY, contacts: [contact({ emailDeliverable: null })] },
    });
    expect(never.email_verified).toBe("");

    const failed = row({
      company: { ...COMPANY, contacts: [contact({ emailDeliverable: false })] },
    });
    expect(failed.email_verified).toBe("no");
  });

  it("falls back to the company main line when the contact has no direct phone", () => {
    const built = row({
      company: {
        ...COMPANY,
        phone: "(561) 555-0100",
        contacts: [contact()],
      } as unknown as CallListCsvInput["company"],
    });
    expect(built.direct_phone).toBe("");
    expect(built.main_company_phone).toBe("(561) 555-0100");
  });
});

describe("workflow columns", () => {
  it("carries follow-up date, notes and assignment straight through", () => {
    const built = row({
      entry: {
        ...ENTRY,
        nextFollowUpDate: "2026-09-02",
        notes: "Left voicemail on the main line",
        assignedTo: "Miguel",
        attempts: 3,
        lastContactAt: new Date("2026-08-20T18:30:00.000Z"),
      },
    });
    expect(built.next_follow_up_date).toBe("2026-09-02");
    expect(built.notes).toBe("Left voicemail on the main line");
    expect(built.assigned_team_member).toBe("Miguel");
    expect(built.attempts).toBe(3);
    expect(built.last_contact_date).toBe("2026-08-20");
  });

  it("leaves date columns blank when unset", () => {
    const built = row();
    expect(built.next_follow_up_date).toBe("");
    expect(built.last_contact_date).toBe("");
    expect(built.added_at).toBe("2026-08-01");
  });
});
