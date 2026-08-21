import { describe, expect, it } from "vitest";
import {
  eligibleForColdCalling,
  isInboundLane,
  isLeadSource,
  lanePermitsSms,
  leadSourceLabel,
  normalizeLeadSource,
} from "@/lib/lead-lanes";

/**
 * The lane decides which channels are even on the table. Cold is email plus a
 * call to the main line and never SMS; inbound arrived with a consent artifact
 * so SMS is permitted, and it drops out of the cold-calling list because it
 * already raised a hand.
 */

describe("lead lanes", () => {
  it("treats a missing lane as cold, which is how every legacy row reads", () => {
    expect(normalizeLeadSource(null)).toBe("cold_discovery");
    expect(normalizeLeadSource(undefined)).toBe("cold_discovery");
    expect(normalizeLeadSource("nonsense")).toBe("cold_discovery");
    expect(eligibleForColdCalling(null)).toBe(true);
    expect(lanePermitsSms(null)).toBe(false);
  });

  it("keeps cold leads off SMS and on the calling list", () => {
    expect(lanePermitsSms("cold_discovery")).toBe(false);
    expect(eligibleForColdCalling("cold_discovery")).toBe(true);
    expect(isInboundLane("cold_discovery")).toBe(false);
  });

  it("permits SMS for both inbound lanes and excludes them from cold calling", () => {
    for (const lane of ["inbound_form", "inbound_meta"] as const) {
      expect(lanePermitsSms(lane)).toBe(true);
      expect(eligibleForColdCalling(lane)).toBe(false);
      expect(isInboundLane(lane)).toBe(true);
    }
  });

  it("validates lane values coming off a query string", () => {
    expect(isLeadSource("inbound_form")).toBe(true);
    expect(isLeadSource("inbound")).toBe(false);
    expect(isLeadSource(null)).toBe(false);
  });

  it("labels every lane", () => {
    expect(leadSourceLabel("cold_discovery")).toBe("Cold");
    expect(leadSourceLabel("inbound_form")).toBe("Inbound — form");
    expect(leadSourceLabel("inbound_meta")).toBe("Inbound — Meta");
  });
});
