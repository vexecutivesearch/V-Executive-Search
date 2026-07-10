/**
 * Config-driven Apollo raw industry → broad sector rollup.
 * Filter on sector; keep companies.industry as the fine-grained value.
 * Unmapped values → Other (never silently drop).
 */

export const OTHER_SECTOR = "Other";

/** Stable recruiter-facing buckets (order = Admin / Today filter order). */
export const INDUSTRY_SECTORS = [
  "Healthcare & Life Sciences",
  "Financial Services",
  "Technology & Telecom",
  "Manufacturing & Industrial",
  "Construction & Real Estate",
  "Retail & Consumer Goods",
  "Professional & Business Services",
  "Education",
  "Transportation & Logistics",
  "Hospitality, Travel & Media",
  "Energy & Utilities",
  "Government & Nonprofit",
] as const;

export type IndustrySector = (typeof INDUSTRY_SECTORS)[number] | typeof OTHER_SECTOR;

/** Raw industry string (lowercased) → sector. Extend when Apollo adds new values. */
const RAW_INDUSTRY_TO_SECTOR: Record<string, (typeof INDUSTRY_SECTORS)[number]> = {
  // Healthcare & Life Sciences
  "hospital & health care": "Healthcare & Life Sciences",
  "medical devices": "Healthcare & Life Sciences",
  "medical practice": "Healthcare & Life Sciences",
  pharmaceuticals: "Healthcare & Life Sciences",
  "mental health care": "Healthcare & Life Sciences",
  veterinary: "Healthcare & Life Sciences",
  "health, wellness & fitness": "Healthcare & Life Sciences",
  "alternative medicine": "Healthcare & Life Sciences",

  // Financial Services
  banking: "Financial Services",
  "financial services": "Financial Services",
  insurance: "Financial Services",
  "investment banking": "Financial Services",
  "venture capital & private equity": "Financial Services",

  // Technology & Telecom
  "information technology & services": "Technology & Telecom",
  "computer hardware": "Technology & Telecom",
  semiconductors: "Technology & Telecom",
  telecommunications: "Technology & Telecom",
  wireless: "Technology & Telecom",

  // Manufacturing & Industrial
  automotive: "Manufacturing & Industrial",
  chemicals: "Manufacturing & Industrial",
  machinery: "Manufacturing & Industrial",
  "electrical/electronic manufacturing": "Manufacturing & Industrial",
  "food production": "Manufacturing & Industrial",
  "aviation & aerospace": "Manufacturing & Industrial",
  "defense & space": "Manufacturing & Industrial",
  printing: "Manufacturing & Industrial",
  textiles: "Manufacturing & Industrial",
  "building materials": "Manufacturing & Industrial",
  "mechanical or industrial engineering": "Manufacturing & Industrial",
  furniture: "Manufacturing & Industrial",

  // Construction & Real Estate
  construction: "Construction & Real Estate",
  "civil engineering": "Construction & Real Estate",
  "architecture & planning": "Construction & Real Estate",
  "real estate": "Construction & Real Estate",

  // Retail & Consumer Goods
  retail: "Retail & Consumer Goods",
  "consumer goods": "Retail & Consumer Goods",
  "consumer services": "Retail & Consumer Goods",
  "apparel & fashion": "Retail & Consumer Goods",
  "food & beverages": "Retail & Consumer Goods",
  restaurants: "Retail & Consumer Goods",
  "luxury goods & jewelry": "Retail & Consumer Goods",
  wholesale: "Retail & Consumer Goods",

  // Professional & Business Services
  "management consulting": "Professional & Business Services",
  "marketing & advertising": "Professional & Business Services",
  "law practice": "Professional & Business Services",
  "legal services": "Professional & Business Services",
  design: "Professional & Business Services",
  "human resources": "Professional & Business Services",
  "staffing & recruiting": "Professional & Business Services",
  "professional training & coaching": "Professional & Business Services",
  "facilities services": "Professional & Business Services",
  "security & investigations": "Professional & Business Services",
  research: "Professional & Business Services",

  // Education
  "education management": "Education",
  "higher education": "Education",
  "primary/secondary education": "Education",

  // Transportation & Logistics
  "logistics & supply chain": "Transportation & Logistics",
  "transportation/trucking/railroad": "Transportation & Logistics",
  maritime: "Transportation & Logistics",
  "airlines/aviation": "Transportation & Logistics",
  warehousing: "Transportation & Logistics",

  // Hospitality, Travel & Media
  hospitality: "Hospitality, Travel & Media",
  "leisure, travel & tourism": "Hospitality, Travel & Media",
  entertainment: "Hospitality, Travel & Media",
  "media production": "Hospitality, Travel & Media",
  "events services": "Hospitality, Travel & Media",
  photography: "Hospitality, Travel & Media",
  "museums & institutions": "Hospitality, Travel & Media",

  // Energy & Utilities
  "oil & energy": "Energy & Utilities",
  utilities: "Energy & Utilities",
  "environmental services": "Energy & Utilities",

  // Government & Nonprofit
  "government administration": "Government & Nonprofit",
  "nonprofit organization management": "Government & Nonprofit",
  "fund-raising": "Government & Nonprofit",
  "religious institutions": "Government & Nonprofit",
  "public safety": "Government & Nonprofit",
  "individual & family services": "Government & Nonprofit",
};

export function normalizeIndustryKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Map raw Apollo industry → sector. Empty → null. Unknown → Other. */
export function sectorFromIndustry(
  raw: string | null | undefined,
): IndustrySector | null {
  if (!raw?.trim()) return null;
  const key = normalizeIndustryKey(raw);
  return RAW_INDUSTRY_TO_SECTOR[key] ?? OTHER_SECTOR;
}

export function isKnownSectorName(value: string): boolean {
  const v = value.trim();
  if (v === OTHER_SECTOR) return true;
  return (INDUSTRY_SECTORS as readonly string[]).includes(v);
}

/** All sector labels for filters (12 + Other). */
export function allSectorFilterOptions(): string[] {
  return [...INDUSTRY_SECTORS, OTHER_SECTOR];
}
