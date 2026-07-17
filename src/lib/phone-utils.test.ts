import { describe, expect, it } from "vitest";
import { isDialablePhone, parsePhoneValue } from "./phone-utils";

describe("phone validity — reject short codes / hotlines", () => {
  it("rejects the AKAM-style 5-digit corporate hotline", () => {
    expect(parsePhoneValue("16224")).toBeNull();
    expect(isDialablePhone("16224")).toBe(false);
  });

  it("keeps real US and international numbers", () => {
    expect(parsePhoneValue("+1 772 267 4249")).toBe("+1 772 267 4249");
    expect(parsePhoneValue("+20 100 123 4567")).toBe("+20 100 123 4567");
    expect(isDialablePhone("+17722674249")).toBe(true);
  });

  it("rejects short codes nested in Apollo JSON blobs", () => {
    expect(parsePhoneValue('{"sanitized_number":"16224"}')).toBeNull();
    expect(parsePhoneValue('{"sanitized_number":"+17046329955"}')).toBe(
      "+17046329955",
    );
  });

  it("rejects empty / junk values", () => {
    expect(parsePhoneValue("")).toBeNull();
    expect(parsePhoneValue("[object Object]")).toBeNull();
    expect(parsePhoneValue("123")).toBeNull();
  });
});
