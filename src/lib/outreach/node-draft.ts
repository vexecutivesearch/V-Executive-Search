import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  companyIcp,
  contacts,
  jobListings,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { draftStep, type DraftContext, type DraftedStep } from "@/lib/outreach-draft";
import type { ConditionNodeConfig, SendNodeConfig } from "@/lib/outreach/flow-types";

const SENDER_NAME = process.env.OUTREACH_SENDER_NAME ?? "Alejandro O Delgado";
const SENDER_FIRM = process.env.OUTREACH_SENDER_FIRM ?? "Villatoro Executive Search";

/** Build the same context pack used at enrollment, for node-entry drafting. */
export async function contextForEnrollment(
  enrollment: SequenceEnrollment,
): Promise<DraftContext | null> {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, enrollment.contactId))
    .limit(1);
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, enrollment.companyId))
    .limit(1);
  if (!contact || !company) return null;

  const listings = await db
    .select()
    .from(jobListings)
    .where(eq(jobListings.companyId, company.id))
    .orderBy(desc(jobListings.lastSeenAt))
    .limit(8);

  const jobTitles = [...new Set(listings.map((l) => l.title).filter(Boolean))];
  const jobDetails = listings.map((l) => {
    const parts = [l.title];
    if (l.location) parts.push(`location: ${l.location}`);
    if (l.salaryText) parts.push(`comp: ${l.salaryText}`);
    if (l.board && l.board !== "manual_seed") parts.push(`board: ${l.board}`);
    return parts.join(", ");
  });

  return {
    contactName: contact.name || null,
    contactTitle: contact.title,
    companyName: company.name,
    industry: company.industry,
    estimatedEmployees: company.estimatedEmployees,
    jobTitles,
    jobDetails,
    jobLocation: listings[0]?.location ?? null,
    hiringSignals: Object.entries(company.hiringSignals ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k.replace(/_/g, " ")),
    reasonToCall: company.reasonToCall,
    market: company.sourceMarket,
    senderName: SENDER_NAME,
    senderFirm: SENDER_FIRM,
  };
}

/** Node-entry drafting for flow-built send nodes (no pre-drafted message). */
export async function draftStepForEnrollment(
  enrollment: SequenceEnrollment,
  config: SendNodeConfig,
): Promise<DraftedStep | null> {
  const context = await contextForEnrollment(enrollment);
  if (!context) return null;
  return draftStep({
    spec: { stepKind: config.stepKind, channel: config.channel },
    context,
    priorSteps: [],
  });
}

/** Condition node: contact/company property comparison. */
export async function evaluateContactProperty(
  enrollment: SequenceEnrollment,
  config: ConditionNodeConfig,
): Promise<boolean> {
  const property = String(config.property ?? "");
  let actual: string | number | null = null;

  if (property === "icp_score") {
    const [row] = await db
      .select({ score: companyIcp.icpAdjustedScore })
      .from(companyIcp)
      .where(eq(companyIcp.companyId, enrollment.companyId))
      .limit(1);
    actual = row?.score ?? null;
  } else if (property === "lead_score") {
    const [row] = await db
      .select({ score: companies.leadScore })
      .from(companies)
      .where(eq(companies.id, enrollment.companyId))
      .limit(1);
    actual = row?.score ?? null;
  } else if (property === "contact_title") {
    const [row] = await db
      .select({ title: contacts.title })
      .from(contacts)
      .where(eq(contacts.id, enrollment.contactId))
      .limit(1);
    actual = row?.title ?? null;
  }

  if (actual === null) return false;
  const expected = config.value;
  switch (config.op ?? "eq") {
    case "eq":
      return String(actual).toLowerCase() === String(expected).toLowerCase();
    case "neq":
      return String(actual).toLowerCase() !== String(expected).toLowerCase();
    case "gte":
      return Number(actual) >= Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "contains":
      return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    default:
      return false;
  }
}
