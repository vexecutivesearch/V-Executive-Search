import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { enrichCompanyContacts } from "@/lib/apollo-enrich";
import { resolveCompanyDomain } from "@/lib/domain-resolver";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  let enriched: Awaited<ReturnType<typeof enrichCompanyContacts>>;
  try {
    enriched = await enrichCompanyContacts({
      apiKey,
      domain,
      jobLocations,
      existingApolloIds,
      contactOutApiKey: process.env.CONTACTOUT_API_KEY,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Enrichment failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!enriched.length) {
    return NextResponse.json({
      ok: true,
      contacts_added: 0,
      message: "No new contacts found at this company",
      domain,
    });
  }

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
      linkedinUrl: c.linkedinUrl,
      apolloId: c.apolloId,
      sourceProvider: c.sourceProvider,
      locationMatched: c.locationMatched,
      contactLocation: c.contactLocation,
      jobLocation: c.jobLocation,
    });
  }

  return NextResponse.json({
    ok: true,
    contacts_added: enriched.length,
    domain,
    contacts: enriched.map((c) => ({
      name: c.name,
      title: c.title,
      email: c.email,
      location_matched: c.locationMatched,
    })),
  });
}
