import { describe, expect, it } from "vitest";
import {
  demoteCompanyMainLine,
  pickPrimaryFromPhones,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { dialGate } from "@/lib/phone-classification";
import { pickPhone } from "@/lib/outreach/contact-handles";

/**
 * Carousel Development & Restoration Inc: ContactOut returned the published
 * main line, +1 561 272 3700, as the owner's "mobile". `applySharedLineFilter`
 * cannot catch that — it needs the same number on two contacts, and
 * company-first discovery reveals exactly one.
 */
const MAIN_LINE = "+15612723700";

const CONTACTOUT_SWITCHBOARD: SourcedPhone = {
  number: MAIN_LINE,
  source: "contactout",
  kind: "mobile",
  classification: "mobile",
};

const REAL_MOBILE: SourcedPhone = {
  number: "+15615550143",
  source: "contactout",
  kind: "mobile",
  classification: "mobile",
};

describe("demoteCompanyMainLine", () => {
  it("reclassifies a provider 'mobile' that is the company main line", () => {
    const [phone] = demoteCompanyMainLine([CONTACTOUT_SWITCHBOARD], MAIN_LINE);
    expect(phone.kind).toBe("company");
    expect(phone.classification).toBe("business_line");
  });

  it("leaves a genuine personal mobile alone", () => {
    const [phone] = demoteCompanyMainLine([REAL_MOBILE], MAIN_LINE);
    expect(phone.kind).toBe("mobile");
    expect(phone.classification).toBe("mobile");
  });

  it("matches on digits, not formatting", () => {
    const [phone] = demoteCompanyMainLine(
      [{ ...CONTACTOUT_SWITCHBOARD, number: "+1 (561) 272-3700" }],
      "561-272-3700",
    );
    expect(phone.kind).toBe("company");
  });

  it("is a no-op when the company has no main line on file", () => {
    expect(demoteCompanyMainLine([CONTACTOUT_SWITCHBOARD], null)).toEqual([
      CONTACTOUT_SWITCHBOARD,
    ]);
  });

  it("handles an empty or absent phone list", () => {
    expect(demoteCompanyMainLine(null, MAIN_LINE)).toEqual([]);
    expect(demoteCompanyMainLine([], MAIN_LINE)).toEqual([]);
  });
});

describe("the switchboard stops being textable and dialable", () => {
  it("is excluded from the number a sequence would text", () => {
    const before = pickPhone({ phones: [CONTACTOUT_SWITCHBOARD] });
    expect(before).toBe(MAIN_LINE);

    const after = pickPhone({
      phones: demoteCompanyMainLine([CONTACTOUT_SWITCHBOARD], MAIN_LINE),
    });
    expect(after).toBeNull();
  });

  it("stops being stored as the contact's personal phone", () => {
    const before = pickPrimaryFromPhones([CONTACTOUT_SWITCHBOARD]);
    expect(before.personalPhone).toBe(MAIN_LINE);

    const after = pickPrimaryFromPhones(
      demoteCompanyMainLine([CONTACTOUT_SWITCHBOARD], MAIN_LINE),
    );
    expect(after.personalPhone).toBeNull();
    expect(after.companyPhone).toBe(MAIN_LINE);
  });

  it("keeps a real mobile as the personal phone and the text handle", () => {
    const phones = demoteCompanyMainLine(
      [CONTACTOUT_SWITCHBOARD, REAL_MOBILE],
      MAIN_LINE,
    );
    expect(pickPrimaryFromPhones(phones).personalPhone).toBe(REAL_MOBILE.number);
    expect(pickPhone({ phones })).toBe(REAL_MOBILE.number);
  });

  it("becomes dialable, because a business line is what it actually is", () => {
    expect(dialGate(CONTACTOUT_SWITCHBOARD).allowed).toBe(false);
    const [demoted] = demoteCompanyMainLine([CONTACTOUT_SWITCHBOARD], MAIN_LINE);
    expect(dialGate(demoted).allowed).toBe(true);
  });
});

describe("pickPrimaryFromPhones — a company line is never a personal phone", () => {
  it("ignores a ContactOut number already marked as the company line", () => {
    const result = pickPrimaryFromPhones([
      { number: MAIN_LINE, source: "contactout", kind: "company" },
    ]);
    expect(result.personalPhone).toBeNull();
    expect(result.companyPhone).toBe(MAIN_LINE);
    expect(result.phone).toBe(MAIN_LINE);
  });
});
