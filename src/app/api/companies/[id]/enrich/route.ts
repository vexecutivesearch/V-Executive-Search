import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { enrichCompanyContacts } from "@/lib/apollo-enrich";
import { resolveCompanyDomain } from "@/lib/domain-resolver";
import { refreshCompanyContactsFromContactOut } from "@/lib/refresh-company-contacts";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Full enrich: Apollo discovery + ContactOut personal data on all contacts. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "APOLLO_API_KEY is not configured on Vercel. Add it in Project Settings → Environment Variables.",
      },
      { status: 503 },
    );
  }

  const contactOutKey = process.env.CONTACTOUT_API_KEY;
  const { id } = await params;

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);

  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  let domain = company.domain;
  let domainConfidence = company.domainConfidence;

  if (!domain) {
    const resolved = await resolveCompanyDomain(company.name, apiKey);
    domain = resolved.domain;
    domainConfidence = resolved.confidence;
    if (domain) {
      await db
        .update(companies)
        .set({
          domain,
          domainConfidence,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, id));
    }
  }

  if (!domain) {
    return NextResponse.json(
      { error: `Could not resolve a domain for "${company.name}"` },
      { status: 422 },
    );
  }

  const listings = await db
    .select({ location: jobListings.location })
    .from(jobListings)
    .where(eq(jobListings.companyId, id));

  const existingContacts = await db
    .select({ apolloId: contacts.apolloId })
    .from(contacts)
    .where(eq(contacts.companyId, id));

  const existingApolloIds = new Set(
    existingContacts.map((c) => c.apolloId).filter(Boolean) as string[],
  );

  const jobLocations = listings
    .map((l) => l.location)
    .filter((l): l is string => Boolean(l));

  let contactsAdded = 0;
  try {
    const enriched = await enrichCompanyContacts({
      apiKey,
      domain,
      jobLocations,
      existingApolloIds,
      contactOutApiKey: contactOutKey,
    });

    for (const c of enriched) {
      await db.insert(contacts).values({
        companyId: id,
        name: c.name,
        title: c.title,
        email: c.email,
        workEmail: c.workEmail,
        personalEmail: c.personalEmail,
        phone: c.phone,
        personalPhone: c.personalPhone,
        companyPhone: c.companyPhone,
        phones: c.phones,
        linkedinUrl: c.linkedinUrl,
        apolloId: c.apolloId,
        sourceProvider: c.sourceProvider,
        locationMatched: c.locationMatched,
        contactLocation: c.contactLocation,
        jobLocation: c.jobLocation,
      });
      contactsAdded += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Enrichment failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  let personalUpdated = 0;
  if (contactOutKey) {
    const refresh = await refreshCompanyContactsFromContactOut(id, contactOutKey);
    personalUpdated = refresh.updated;
  }

  const totalContacts = existingContacts.length + contactsAdded;

  return NextResponse.json({
    ok: true,
    contacts_added: contactsAdded,
    personal_updated: personalUpdated,
    total_contacts: totalContacts,
    domain,
    message:
      contactsAdded === 0 && personalUpdated === 0
        ? "No new contacts or personal data found"
        : undefined,
  });
}
