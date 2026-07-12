/** People titles to find at hiring companies — not JobSpy scrape queries. */
export const TARGET_TITLES = [
  "HR Director",
  "VP People",
  "Head of Talent",
  "Director of Human Resources",
  "VP Human Resources",
  "Chief People Officer",
  "CHRO",
  "Head of HR",
  "Head of People",
];

export const TARGET_SENIORITIES = ["c_suite", "vp", "head", "director"];

/** Broader seniority for SMB owner/GM fallback when HR search is empty. */
export const FALLBACK_SENIORITIES = [
  "c_suite",
  "owner",
  "founder",
  "vp",
  "head",
  "director",
  "manager",
];

/** When HR titles return nothing (typical for SMBs), try these decision-makers. */
export const FALLBACK_TITLES = [
  "Owner",
  "President",
  "General Manager",
  "Office Manager",
  "Practice Manager",
  "Managing Director",
  "Founder",
  "CEO",
  "Operations Manager",
];

export const CONTACTS_PER_COMPANY = 3;

export const ENRICH_PHONE = true;
