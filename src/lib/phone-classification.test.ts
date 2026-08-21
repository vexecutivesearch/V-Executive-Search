import { describe, expect, it } from "vitest";
import type { SourcedPhone } from "@/lib/contact-phones";
import {
  canDial,
  classifyContactPhones,
  classifySourcedPhone,
  companyMainLine,
  dialGate,
} from "@/lib/phone-classification";

/**
 * The rule this file pins down: only a number positively known to be a
 * business line may be dialed, and an unclassified number counts as a mobile.
 * Everything else is the same failure mode — assuming a landline because
 * nothing said otherwise.
 */

const APOLLO_MAIN_LINE: SourcedPhone = {
  number: "+15615550100",
  source: "apollo",
  kind: "company",
};

const CONTACTOUT_MOBILE: SourcedPhone = {
  number: "+15615550111",
  source: "contactout",
  kind: "mobile",
};

describe("classifySourcedPhone", () => {
  it("classifies an Apollo organization line as a business line", () => {
    expect(classifySourcedPhone(APOLLO_MAIN_LINE)).toBe("business_line");
  });

  it("classifies every ContactOut number as a mobile", () => {
    expect(classifySourcedPhone(CONTACTOUT_MOBILE)).toBe("mobile");
    expect(
      classifySourcedPhone({ ...CONTACTOUT_MOBILE, kind: "work" }),
    ).toBe("mobile");
    expect(
      classifySourcedPhone({ ...CONTACTOUT_MOBILE, kind: undefined }),
    ).toBe("mobile");
  });

  /*
   * An Apollo "work" direct dial is as likely to be a cell as a desk phone,
   * so it stays unknown rather than being promoted to a landline.
   */
  it("leaves an unattributable number unknown", () => {
    expect(
      classifySourcedPhone({ number: "+15615550122", source: "apollo", kind: "work" }),
    ).toBe("unknown");
    expect(
      classifySourcedPhone({ number: "+15615550122", source: "apollo", kind: "other" }),
    ).toBe("unknown");
  });

  it("keeps an explicitly stored classification", () => {
    expect(
      classifySourcedPhone({ ...APOLLO_MAIN_LINE, classification: "mobile" }),
    ).toBe("mobile");
  });
});

describe("dial gate", () => {
  it("allows a business line", () => {
    const gate = dialGate(APOLLO_MAIN_LINE);
    expect(gate.allowed).toBe(true);
    expect(gate.classification).toBe("business_line");
    expect(canDial(APOLLO_MAIN_LINE)).toBe(true);
  });

  it("refuses a mobile and says why", () => {
    const gate = dialGate(CONTACTOUT_MOBILE);
    expect(gate.allowed).toBe(false);
    expect(gate.classification).toBe("mobile");
    expect(gate.allowed === false && gate.reason).toContain("Mobile number");
    expect(canDial(CONTACTOUT_MOBILE)).toBe(false);
  });

  /* Unknown is treated as mobile: this is the whole safety property. */
  it("refuses an unclassified number exactly like a mobile", () => {
    const unknown: SourcedPhone = {
      number: "+15615550133",
      source: "apollo",
      kind: "work",
    };
    const gate = dialGate(unknown);
    expect(gate.allowed).toBe(false);
    expect(gate.classification).toBe("unknown");
    expect(gate.allowed === false && gate.reason).toContain(
      "treated as a mobile",
    );
    expect(canDial(unknown)).toBe(false);
  });

  it("refuses a missing, empty, or short-code number", () => {
    expect(dialGate(null).allowed).toBe(false);
    expect(dialGate(undefined).allowed).toBe(false);
    expect(dialGate({ number: "", source: "apollo", kind: "company" }).allowed).toBe(
      false,
    );
    // 16224-style corporate hotlines are not callable leads.
    expect(
      dialGate({ number: "16224", source: "apollo", kind: "company" }).allowed,
    ).toBe(false);
  });

  it("cannot be talked into dialing a mobile by its kind label", () => {
    for (const kind of ["company", "work", "mobile", "other"] as const) {
      expect(
        canDial({ ...CONTACTOUT_MOBILE, kind, classification: "mobile" }),
      ).toBe(false);
    }
  });
});

describe("companyMainLine", () => {
  it("treats the Apollo organization number as dialable", () => {
    const line = companyMainLine({ phone: "+15615550100" });
    expect(line).not.toBeNull();
    expect(canDial(line)).toBe(true);
  });

  it("honours an explicit reclassification away from business line", () => {
    const line = companyMainLine({
      phone: "+15615550100",
      phoneClassification: "mobile",
    });
    expect(canDial(line)).toBe(false);
  });

  it("returns nothing when the company has no usable number", () => {
    expect(companyMainLine({ phone: null })).toBeNull();
    expect(companyMainLine(null)).toBeNull();
  });
});

describe("classifyContactPhones", () => {
  it("marks ContactOut numbers mobile and shared lines business", () => {
    const classified = classifyContactPhones({
      phones: [CONTACTOUT_MOBILE, APOLLO_MAIN_LINE],
    });
    expect(classified.map((p) => p.classification)).toEqual([
      "mobile",
      "business_line",
    ]);
    expect(classified.filter((p) => canDial(p))).toHaveLength(1);
  });

  it("never upgrades a contact number to dialable from the contact class", () => {
    const classified = classifyContactPhones({
      phones: [{ number: "+15615550144", source: "apollo", kind: "work" }],
      phoneClassification: "business_line",
    });
    expect(classified[0].classification).toBe("unknown");
    expect(canDial(classified[0])).toBe(false);
  });
});
