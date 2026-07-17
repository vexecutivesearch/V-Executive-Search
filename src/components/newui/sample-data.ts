import type { PreviewData } from "./NewUiApp";

/** Fallback so /newui always renders as a design preview, even without a DB. */
export const SAMPLE_PREVIEW: PreviewData = {
  live: false,
  kpis: {
    totalCompanies: 4318,
    newToday: 1577,
    enriched: 126,
    hot: 28,
    dueToday: 5,
    totalListings: 218470,
  },
  counts: { allLeads: 4318, hot: 28, callList: 12 },
  totalLocations: 4318,
  states: [
    {
      stateName: "North Carolina",
      stateAbbr: "NC",
      count: 1571,
      cities: [
        { city: "Charlotte", count: 611 },
        { city: "Concord", count: 92 },
        { city: "Huntersville", count: 71 },
        { city: "Mooresville", count: 40 },
      ],
    },
    {
      stateName: "Florida",
      stateAbbr: "FL",
      count: 1077,
      cities: [
        { city: "West Palm Beach", count: 227 },
        { city: "Miami", count: 104 },
        { city: "Weston", count: 15 },
      ],
    },
    {
      stateName: "Georgia",
      stateAbbr: "GA",
      count: 988,
      cities: [
        { city: "Atlanta", count: 540 },
        { city: "Decatur", count: 61 },
      ],
    },
  ],
  leads: [
    { id: "1", name: "Atlanta Legal Aid Society", domain: "atlantalegalaid.org", score: 100, icpScore: 94, roleType: "professional", marketLabel: "Atlanta, GA", jobTitle: "Legal Assistant", jobBoard: "linkedin", jobLocation: "Decatur, GA", salary: null, sector: "Government & Nonprofit", contactsCallable: 3, contactsTotal: 3, discovered: 0, hot: false, onList: true, reasonToCall: "Same role reposted 4× in 21 days" },
    { id: "2", name: "Menzies Aviation LATAM", domain: "menziesaviationlatam.com", score: 95, icpScore: 53, roleType: "professional", marketLabel: "Charlotte, NC", jobTitle: "Accounting Clerk", jobBoard: "linkedin", jobLocation: "Rock Hill, SC", salary: null, sector: "Transportation & Logistics", contactsCallable: 1, contactsTotal: 3, discovered: 2, hot: true, onList: false, reasonToCall: "Reposted 8× in 21 days" },
    { id: "3", name: "Palm Beach Ortho Group", domain: "pbortho.com", score: 88, icpScore: 84, roleType: "management", marketLabel: "West Palm Beach, FL", jobTitle: "Practice Administrator", jobBoard: "indeed", jobLocation: "Boca Raton, FL", salary: "$95,000–$120,000", sector: "Healthcare & Life Sciences", contactsCallable: 1, contactsTotal: 1, discovered: 0, hot: false, onList: false, reasonToCall: "Hiring a practice administrator" },
    { id: "4", name: "Coastal Law Group LLP", domain: "coastallawgroup.com", score: 81, icpScore: 79, roleType: "leadership", marketLabel: "Charleston, SC", jobTitle: "Managing Partner", jobBoard: "google", jobLocation: "Charleston, SC", salary: null, sector: "Professional & Business Services", contactsCallable: 0, contactsTotal: 4, discovered: 4, hot: true, onList: false, reasonToCall: "Multiple openings" },
    { id: "5", name: "Papa Johns", domain: "papajohns.com", score: 93, icpScore: 0, roleType: "hourly", marketLabel: "Charlotte, NC", jobTitle: "Delivery Driver", jobBoard: "linkedin", jobLocation: "Albemarle, NC", salary: "$15–$17.50 an hour", sector: "Retail & Consumer Goods", contactsCallable: 0, contactsTotal: 0, discovered: 0, hot: false, onList: false, reasonToCall: null },
    { id: "6", name: "Sunbelt Manufacturing Inc", domain: "sunbeltmfg.com", score: 76, icpScore: 88, roleType: "specialized", marketLabel: "Greenville, SC", jobTitle: "Plant Controller", jobBoard: "indeed", jobLocation: "Greenville, SC", salary: "$110,000–$140,000", sector: "Manufacturing & Industrial", contactsCallable: 2, contactsTotal: 2, discovered: 0, hot: true, onList: true, reasonToCall: "New finance leadership role" },
  ],
  listings: [
    { id: "l1", title: "Accounting Clerk", company: "Menzies Aviation LATAM", location: "Rock Hill, SC", board: "linkedin", market: "Charlotte, NC", reposts: 8, postedAt: "2026-07-16" },
    { id: "l2", title: "Managing Partner", company: "Coastal Law Group LLP", location: "Charleston, SC", board: "google", market: "Charleston, SC", reposts: 3, postedAt: "2026-07-16" },
    { id: "l3", title: "Practice Administrator", company: "Palm Beach Ortho Group", location: "Boca Raton, FL", board: "indeed", market: "West Palm Beach, FL", reposts: 1, postedAt: "2026-07-15" },
    { id: "l4", title: "Plant Controller", company: "Sunbelt Manufacturing Inc", location: "Greenville, SC", board: "indeed", market: "Greenville, SC", reposts: 2, postedAt: "2026-07-15" },
  ],
  callList: [
    { id: "c1", company: "Alzheimer's Community Care", score: 92, contactName: "Doug Freeman", contactTitle: "CEO", status: "Meeting Scheduled", attempts: 2, nextFollowUp: "2026-07-18", assignedTo: "Miguel", market: "West Palm Beach, FL" },
    { id: "c2", company: "Menzies Aviation LATAM", score: 95, contactName: "S. Gottlieb", contactTitle: "CEO", status: "Spoke — Follow-Up Needed", attempts: 3, nextFollowUp: "2026-07-16", assignedTo: "Miguel", market: "Charlotte, NC" },
    { id: "c3", company: "Palm Beach Ortho Group", score: 84, contactName: "Rachel Kim", contactTitle: "HR Manager", status: "Voicemail Left", attempts: 1, nextFollowUp: "2026-07-17", assignedTo: "Alejandro", market: "West Palm Beach, FL" },
    { id: "c4", company: "Oceanside Health Partners", score: 79, contactName: "Paul Mercer", contactTitle: "Head of Talent", status: "Ready to Call", attempts: 0, nextFollowUp: null, assignedTo: "Alejandro", market: "Charlotte, NC" },
  ],
};
