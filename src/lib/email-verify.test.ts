import { describe, expect, it } from "vitest";
import { verifyContactEmail, verifyEmailAddress } from "./email-verify";

describe("verifyEmailAddress", () => {
  it("rejects malformed addresses without touching DNS", async () => {
    const result = await verifyEmailAddress("not-an-email");
    expect(result.deliverable).toBe(false);
    expect(result.reason).toBe("invalid_format");
  });

  it("rejects disposable domains", async () => {
    const result = await verifyEmailAddress("someone@mailinator.com");
    expect(result.deliverable).toBe(false);
    expect(result.reason).toBe("disposable_domain");
  });
});

describe("verifyContactEmail", () => {
  it("returns null when the contact has no email at all", async () => {
    expect(await verifyContactEmail({})).toBeNull();
  });

  it("returns null when email columns hold only empty strings", async () => {
    // These rows are non-NULL in SQL, so the verify batch keeps selecting
    // them; the route must mark them checked or they clog every future batch.
    expect(
      await verifyContactEmail({ email: "", workEmail: " ", personalEmail: "" }),
    ).toBeNull();
  });
});
