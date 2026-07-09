import { and, count, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";
import {
  contactPhonesForDisplay,
  phoneKindLabel,
  sortPhonesForDisplay,
  sourceLabel,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { isPersonalEmail } from "@/lib/phone-utils";
import { businessToday } from "@/lib/timezone";

export type DailyReportPhone = SourcedPhone;

export type DailyReportRow = {
  company: string;
  contact_name: string;
  title: string | null;
  work_email: string | null;
  personal_email: string | null;
  phones: DailyReportPhone[];
  imessage_capable: boolean | null;
  job_title: string | null;
};

function resolveEmails(contact: {
  email: string | null;
  workEmail: string | null;
  personalEmail: string | null;
}): { workEmail: string | null; personalEmail: string | null } {
  const personalEmail =
    contact.personalEmail ??
    (contact.email && isPersonalEmail(contact.email) ? contact.email : null);
  const workEmail =
    contact.workEmail ??
    (contact.email && !isPersonalEmail(contact.email) ? contact.email : null);

  return {
    workEmail: workEmail && workEmail !== personalEmail ? workEmail : workEmail,
    personalEmail,
  };
}

export async function getDailyReportData(): Promise<{
  run_date: string;
  listings_scraped: number;
  companies_enriched: number;
  rows: DailyReportRow[];
}> {
  const today = businessToday();

  const [listingStats] = await db
    .select({ count: count() })
    .from(jobListings)
    .innerJoin(companies, eq(jobListings.companyId, companies.id))
    .where(eq(companies.firstSeen, today));

  const [companyStats] = await db
    .select({ count: sql<number>`count(distinct ${companies.id})::int` })
    .from(companies)
    .where(eq(companies.firstSeen, today));

  const rawRows = await db
    .selectDistinctOn([companies.id, contacts.id], {
      company: companies.name,
      contactName: contacts.name,
      title: contacts.title,
      email: contacts.email,
      workEmail: contacts.workEmail,
      personalEmail: contacts.personalEmail,
      phone: contacts.phone,
      personalPhone: contacts.personalPhone,
      companyPhone: contacts.companyPhone,
      phones: contacts.phones,
      sourceProvider: contacts.sourceProvider,
      imessageCapable: contacts.imessageCapable,
      jobTitle: jobListings.title,
      listingCreatedAt: jobListings.createdAt,
    })
    .from(companies)
    .innerJoin(contacts, eq(contacts.companyId, companies.id))
    .leftJoin(jobListings, eq(jobListings.companyId, companies.id))
    .where(
      and(
        eq(companies.status, "new"),
        eq(companies.firstSeen, today),
        or(
          isNotNull(contacts.personalPhone),
          isNotNull(contacts.phone),
          isNotNull(contacts.personalEmail),
          isNotNull(contacts.email),
          isNotNull(contacts.workEmail),
        ),
      ),
    )
    .orderBy(companies.id, contacts.id, jobListings.createdAt);

  const rows: DailyReportRow[] = [];

  for (const row of rawRows) {
    const { workEmail, personalEmail } = resolveEmails(row);
    const phones = sortPhonesForDisplay(
      contactPhonesForDisplay({
        phones: row.phones,
        phone: row.phone,
        personalPhone: row.personalPhone,
        companyPhone: row.companyPhone,
        sourceProvider: row.sourceProvider,
      }),
    );

    if (!workEmail && !personalEmail && phones.length === 0) continue;

    rows.push({
      company: row.company,
      contact_name: row.contactName,
      title: row.title,
      work_email: workEmail,
      personal_email: personalEmail,
      phones: phones.map((p) => ({
        number: p.number,
        source: p.source,
        kind: p.kind,
        source_label: sourceLabel(p.source),
        kind_label: phoneKindLabel(p.kind),
      })),
      imessage_capable: row.imessageCapable,
      job_title: row.jobTitle,
    });
  }

  return {
    run_date: today,
    listings_scraped: Number(listingStats?.count ?? 0),
    companies_enriched: Number(companyStats?.count ?? 0),
    rows,
  };
}
