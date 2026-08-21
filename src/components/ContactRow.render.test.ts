import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContactRow } from "@/components/ContactRow";
import type { Contact } from "@/lib/db/schema";

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-1",
    companyId: "9f3d0f0a-2a2b-4a1e-9d47-6b0b6a2f1c11",
    name: "Micah Cl***r",
    title: "President",
    email: null,
    workEmail: null,
    personalEmail: null,
    personalEmails: [],
    phone: null,
    personalPhone: null,
    companyPhone: null,
    phones: [],
    phoneClassification: "mobile",
    linkedinUrl: null,
    apolloId: "apollo-1",
    sourceProvider: "apollo_discovery",
    imessageCapable: null,
    emailDeliverable: null,
    emailVerifiedAt: null,
    presenceCheckedAt: null,
    locationMatched: false,
    contactLocation: null,
    jobLocation: null,
    revealStatus: "discovered",
    revealChannels: null,
    isPrimary: false,
    timezoneOverride: null,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    ...overrides,
  };
}

const render = (over: Partial<Contact> = {}, jobLocation: string | null = null) =>
  renderToStaticMarkup(
    createElement(ContactRow, { contact: contact(over), jobLocation }),
  );

/**
 * Company-first discovery finds companies with no job postings at all, so the
 * "for this posting" wording named a posting that did not exist — on every
 * contact of a company whose row said "No job postings on file".
 */
describe("ContactRow location note — no job posting exists", () => {
  it("does not reference a posting the company does not have", () => {
    expect(render()).not.toContain("Location not verified for this posting");
  });

  it("says there is no posting to verify against", () => {
    expect(render()).toContain(
      "Contact location unknown — no job posting on file to verify against",
    );
  });

  it("still reports where the contact is when Apollo knows", () => {
    expect(render({ contactLocation: "Delray Beach, Florida" })).toContain(
      "Contact in Delray Beach, Florida — no job posting on file to verify against",
    );
  });
});

describe("ContactRow location note — a posting does exist", () => {
  it("names the posting location it could not verify against", () => {
    expect(render({}, "Delray Beach, FL")).toContain(
      "Not verified for Delray Beach, FL",
    );
  });

  it("confirms a match when the contact is in the posting's market", () => {
    const html = render(
      { locationMatched: true, contactLocation: "Delray Beach, Florida" },
      "Delray Beach, FL",
    );
    expect(html).toContain("Matched to job location");
  });
});
