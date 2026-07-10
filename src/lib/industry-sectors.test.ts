import { describe, expect, it } from "vitest";
import {
  INDUSTRY_SECTORS,
  OTHER_SECTOR,
  sectorFromIndustry,
} from "@/lib/industry-sectors";

describe("sectorFromIndustry", () => {
  it("rolls up fine-grained healthcare industries", () => {
    expect(sectorFromIndustry("hospital & health care")).toBe(
      "Healthcare & Life Sciences",
    );
    expect(sectorFromIndustry("Medical Devices")).toBe(
      "Healthcare & Life Sciences",
    );
    expect(sectorFromIndustry("veterinary")).toBe(
      "Healthcare & Life Sciences",
    );
  });

  it("merges aviation variants into the right buckets", () => {
    expect(sectorFromIndustry("airlines/aviation")).toBe(
      "Transportation & Logistics",
    );
    expect(sectorFromIndustry("aviation & aerospace")).toBe(
      "Manufacturing & Industrial",
    );
  });

  it("sends unmapped industries to Other — never drops", () => {
    expect(sectorFromIndustry("totally new apollo industry xyz")).toBe(
      OTHER_SECTOR,
    );
  });

  it("returns null for empty", () => {
    expect(sectorFromIndustry(null)).toBeNull();
    expect(sectorFromIndustry("  ")).toBeNull();
  });

  it("covers every known CRM industry without Other", () => {
    const known = [
      "airlines/aviation",
      "alternative medicine",
      "apparel & fashion",
      "architecture & planning",
      "automotive",
      "aviation & aerospace",
      "banking",
      "building materials",
      "chemicals",
      "civil engineering",
      "computer hardware",
      "construction",
      "consumer goods",
      "consumer services",
      "defense & space",
      "design",
      "education management",
      "electrical/electronic manufacturing",
      "entertainment",
      "environmental services",
      "events services",
      "facilities services",
      "financial services",
      "food & beverages",
      "food production",
      "fund-raising",
      "furniture",
      "government administration",
      "health, wellness & fitness",
      "higher education",
      "hospital & health care",
      "hospitality",
      "human resources",
      "individual & family services",
      "information technology & services",
      "insurance",
      "investment banking",
      "law practice",
      "legal services",
      "leisure, travel & tourism",
      "logistics & supply chain",
      "luxury goods & jewelry",
      "machinery",
      "management consulting",
      "maritime",
      "marketing & advertising",
      "mechanical or industrial engineering",
      "media production",
      "medical devices",
      "medical practice",
      "mental health care",
      "museums & institutions",
      "nonprofit organization management",
      "oil & energy",
      "pharmaceuticals",
      "photography",
      "primary/secondary education",
      "printing",
      "professional training & coaching",
      "public safety",
      "real estate",
      "religious institutions",
      "research",
      "restaurants",
      "retail",
      "security & investigations",
      "semiconductors",
      "staffing & recruiting",
      "telecommunications",
      "textiles",
      "transportation/trucking/railroad",
      "utilities",
      "venture capital & private equity",
      "veterinary",
      "warehousing",
      "wholesale",
      "wireless",
    ];
    expect(known).toHaveLength(77);
    for (const raw of known) {
      expect(sectorFromIndustry(raw)).not.toBe(OTHER_SECTOR);
      expect(sectorFromIndustry(raw)).not.toBeNull();
    }
  });
});
