import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
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
import { businessDayFirstSeenDates, businessListDate } from "@/lib/timezone";
import { getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";

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
  const listDates = businessDayFirstSeenDates();
  const geoSettings = await getGeoFocusSettings();

  const allListingsToday = await db
    .select({ listing: jobListings })
    .from(jobListings)
    .innerJoin(companies, eq(jobListings.companyId, companies.id))
    .where(inArray(companies.firstSeen, listDates));

  const listings_scraped = allListingsToday.filter((row) =>
    jobLocationInFocus(row.listing.location, geoSettings),
  ).length;

  const rawRows = await db
    .selectDistinctOn([companies.id, contacts.id], {
      company: companies.name,
      companyId: companies.id,
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
      jobLocation: jobListings.location,
    })
    .from(companies)
    .innerJoin(contacts, eq(contacts.companyId, companies.id))
    .innerJoin(jobListings, eq(jobListings.companyId, companies.id))
    .where(
      and(
        eq(companies.status, "new"),
        inArray(companies.firstSeen, listDates),
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
  const enrichedCompanyIds = new Set<string>();

  for (const row of rawRows) {
    if (!jobLocationInFocus(row.jobLocation, geoSettings)) continue;

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

    enrichedCompanyIds.add(row.companyId);
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
    run_date: businessListDate(),
    listings_scraped,
    companies_enriched: enrichedCompanyIds.size,
    rows,
  };
}
