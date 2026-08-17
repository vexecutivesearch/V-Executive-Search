import { describe, expect, it, vi } from "vitest";

// The module pulls in the DB and the whole send stack; only the pure URL
// helper is under test here.
vi.mock("@/lib/db", () => ({ db: {} }));

import { resendEmailUrl } from "@/lib/outreach/dispatch";

describe("resendEmailUrl", () => {
  it("links a sent email to its Resend delivery record", () => {
    expect(resendEmailUrl("4ef9a417-02e9-4d39-ad75-9611e0e83f9e")).toBe(
      "https://resend.com/emails/4ef9a417-02e9-4d39-ad75-9611e0e83f9e",
    );
  });

  it("has no link when Resend returned no id", () => {
    expect(resendEmailUrl(null)).toBeNull();
    expect(resendEmailUrl(undefined)).toBeNull();
    expect(resendEmailUrl("")).toBeNull();
    expect(resendEmailUrl("   ")).toBeNull();
  });
});
