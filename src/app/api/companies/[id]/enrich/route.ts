import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { enrichCompanyContacts, refreshCompanyContactsFromApollo, apolloWebhookConfigured } from "@/lib/apollo-enrich";
import { isContactOutCreditsAvailable } from "@/lib/contactout-credits";
import { searchContactOutByDomain, searchContactOutByCompanyName } from "@/lib/contactout-domain-search";
import { guessDomain, resolveCompanyOrg } from "@/lib/domain-resolver";
import { normalizeContactChannels } from "@/lib/contact-enrichment-limits";
import { contactPhonesForDisplay } from "@/lib/contact-phones";
import { refreshCompanyContactsFromContactOut } from "@/lib/refresh-company-contacts";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";
import { getCompanyById } from "@/lib/queries";
import { requestImessageCheck } from "@/lib/imessage-check";
import { contactIsCallable } from "@/lib/lead-score";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import { businessListDate } from "@/lib/timezone";
import { manualEnrichContext } from "@/lib/paid-egress";

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
  const egressContext = manualEnrichContext(id);

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

  const existingContactRows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, id));

  const posterContacts = existingContactRows.filter(
    (c) => c.sourceProvider === "linkedin_poster" && c.linkedinUrl,
  );

  // Upgrade missing or guessed domains via Apollo org search before people lookup.
  if (!domain || domainConfidence === "low") {
    const resolved = await resolveCompanyOrg(company.name, apiKey, egressContext);
    const patch: Partial<typeof companies.$inferInsert> = {};
    if (
      resolved.domain &&
      (!domain ||
        (domainConfidence === "low" && resolved.confidence === "high"))
    ) {
      domain = resolved.domain;
      domainConfidence = resolved.confidence;
      patch.domain = domain;
      patch.domainConfidence = domainConfidence;
    }
    if (resolved.industry && !company.industry?.trim()) {
      patch.industry = resolved.industry;
    }
    if (resolved.estimatedEmployees != null && company.estimatedEmployees == null) {
      patch.estimatedEmployees = resolved.estimatedEmployees;
    }
    if (Object.keys(patch).length) {
      await db
        .update(companies)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(companies.id, id));
    }
  }

  if (!domain) {
    const guessed = guessDomain(company.name);
    if (guessed) {
      domain = guessed;
      domainConfidence = "low";
      await db
        .update(companies)
        .set({
          domain,
          domainConfidence: "low",
          updatedAt: new Date(),
        })
        .where(eq(companies.id, id));
    }
  }

  if (!domain) {
    if (posterContacts.length === 0 || !contactOutKey) {
      return NextResponse.json(
        {
          error: posterContacts.length
            ? "CONTACTOUT_API_KEY is not configured — needed to enrich LinkedIn job posters without a company domain."
            : `Could not resolve a domain for "${company.name}" — try adding a domain on the company record.`,
        },
        { status: posterContacts.length ? 503 : 422 },
      );
    }

    const contactOutAvailable = contactOutKey
      ? await isContactOutCreditsAvailable(
          contactOutKey,
          posterContacts.find((c) => c.linkedinUrl)?.linkedinUrl ?? null,
        )
      : false;

    const refresh = await refreshCompanyContactsFromContactOut(id, contactOutKey, {
      contactOutAvailable,
      context: egressContext,
    });

    const finalContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, id));

    if (finalContacts.some(contactIsCallable)) {
      await db
        .update(companies)
        .set({
          enrichRunDate: businessListDate(),
          enrichedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companies.id, id));
      await recomputeCompanyScores([id]);
    }

    revalidatePath("/today");
    revalidatePath("/companies");
    revalidatePath(`/companies/${id}`);

    const updatedCompany = await getCompanyById(id);
    return NextResponse.json({
      ok: true,
      contacts_added: 0,
      personal_updated: refresh.updated,
      contactout_checked: refresh.checked,
      contactout_phone_locked: refresh.phoneApiLocked || !contactOutAvailable,
      contactout_available: contactOutAvailable,
      company: updatedCompany,
      message:
        refresh.updated > 0
          ? `Enriched ${refresh.updated} LinkedIn job poster contact(s) via ContactOut`
          : `ContactOut checked ${refresh.checked} job poster(s) — no new personal data`,
    });
  }

  const listings = await db
    .select({ location: jobListings.location })
    .from(jobListings)
    .where(eq(jobListings.companyId, id));

  const existingApolloIds = new Set(
    existingContactRows.map((c) => c.apolloId).filter(Boolean) as string[],
  );

  const jobLocations = listings
    .map((l) => l.location)
    .filter((l): l is string => Boolean(l));

  const sampleLinkedIn =
    existingContactRows.find((c) => c.linkedinUrl)?.linkedinUrl ?? null;

  const contactOutAvailable = contactOutKey
    ? await isContactOutCreditsAvailable(contactOutKey, sampleLinkedIn)
    : false;

  let contactsAdded = 0;
  try {
    const enriched = await enrichCompanyContacts({
      apiKey,
      domain,
      companyName: company.name,
      jobLocations,
      existingApolloIds,
      contactOutApiKey: contactOutKey,
      contactOutAvailable,
      context: egressContext,
      companyId: id,
    });

    for (const c of enriched) {
      const channels = normalizeContactChannels(c);
      await db.insert(contacts).values({
        companyId: id,
        name: c.name,
        title: c.title,
        email: channels.email,
        workEmail: channels.workEmail,
        personalEmail: channels.personalEmail,
        phone: channels.phone,
        personalPhone: channels.personalPhone,
        companyPhone: channels.companyPhone,
        phones: channels.phones,
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

  if (contactsAdded === 0 && contactOutKey && contactOutAvailable) {
    let coPeople = domain
      ? await searchContactOutByDomain(contactOutKey, domain, 3, egressContext, id)
      : [];
    if (coPeople.length === 0) {
      coPeople = await searchContactOutByCompanyName(
        contactOutKey,
        company.name,
        3,
        domain,
        egressContext,
        id,
      );
    }
    const existingLinkedIn = new Set(
      existingContactRows.map((c) => c.linkedinUrl).filter(Boolean),
    );
    const existingEmails = new Set(
      existingContactRows
        .flatMap((c) => [c.email, c.workEmail, c.personalEmail])
        .filter(Boolean)
        .map((e) => e!.toLowerCase()),
    );

    for (const person of coPeople) {
      if (person.linkedinUrl && existingLinkedIn.has(person.linkedinUrl)) continue;
      const emails = [person.workEmail, person.personalEmail].filter(Boolean);
      if (emails.some((e) => existingEmails.has(e!.toLowerCase()))) continue;

      const email = person.workEmail ?? person.personalEmail ?? null;
      const channels = normalizeContactChannels({
        workEmail: person.workEmail,
        personalEmail: person.personalEmail,
        email,
        phone: person.phone,
        personalPhone: person.personalPhone,
        phones: person.phones,
        sourceProvider: "contactout",
      });
      await db.insert(contacts).values({
        companyId: id,
        name: person.name,
        title: person.title || null,
        email: channels.email,
        workEmail: channels.workEmail,
        personalEmail: channels.personalEmail,
        phone: channels.phone,
        personalPhone: channels.personalPhone,
        companyPhone: channels.companyPhone,
        phones: channels.phones,
        linkedinUrl: person.linkedinUrl || null,
        sourceProvider: "contactout",
      });
      contactsAdded += 1;
      if (person.linkedinUrl) existingLinkedIn.add(person.linkedinUrl);
      for (const e of emails) existingEmails.add(e!.toLowerCase());
    }
  }

  const personalUpdated = 0;
  let contactoutChecked = 0;
  const contactoutPhoneLocked = false;
  let apolloRefreshed = 0;
  let apolloPhonesRequested = 0;
  let apolloPhonesAdded = 0;

  const apolloRefresh = await refreshCompanyContactsFromApollo(
    id,
    apiKey,
    contactOutAvailable,
    egressContext,
  );
  apolloRefreshed = apolloRefresh.updated;
  apolloPhonesRequested = apolloRefresh.phonesRequested;
  apolloPhonesAdded = apolloRefresh.phonesAdded;

  if (contactOutKey && contactOutAvailable) {
    contactoutChecked = existingContactRows.filter((c) => c.linkedinUrl).length;
  }

  // Backfill phones json from legacy phone fields (e.g. Apollo webhook async delivery).
  const allContacts = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, id));
  let phonesBackfilled = 0;
  for (const contact of allContacts) {
    const normalized = normalizeContactChannels(contact);
    if (
      JSON.stringify(normalized.phones) !== JSON.stringify(contact.phones ?? []) ||
      normalized.phone !== contact.phone ||
      normalized.personalPhone !== contact.personalPhone ||
      normalized.workEmail !== contact.workEmail ||
      normalized.personalEmail !== contact.personalEmail
    ) {
      await db
        .update(contacts)
        .set({
          phones: normalized.phones,
          phone: normalized.phone ?? contact.phone,
          personalPhone: normalized.personalPhone ?? contact.personalPhone,
          companyPhone: normalized.companyPhone ?? contact.companyPhone,
          workEmail: normalized.workEmail,
          personalEmail: normalized.personalEmail,
          email: normalized.email ?? contact.email,
        })
        .where(eq(contacts.id, contact.id));
      phonesBackfilled += 1;
    }
  }

  // Apollo phone reveal is async — wait for webhook, then re-read contacts.
  if (apolloPhonesRequested > 0 && apolloWebhookConfigured()) {
    const phonesBefore = allContacts.reduce(
      (n, c) => n + contactPhonesForDisplay(c).length,
      0,
    );
    await new Promise((r) => setTimeout(r, 5000));
    const afterContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, id));
    const phonesAfter = afterContacts.reduce(
      (n, c) => n + contactPhonesForDisplay(c).length,
      0,
    );
    if (phonesAfter > phonesBefore) {
      apolloPhonesAdded += phonesAfter - phonesBefore;
    }
  }

  const totalContacts = existingContactRows.length + contactsAdded;

  const finalContacts = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, id));

  if (finalContacts.some(contactIsCallable)) {
    await db
      .update(companies)
      .set({
        enrichRunDate: businessListDate(),
        enrichedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(companies.id, id));
    await recomputeCompanyScores([id]);
  }

  revalidatePath("/today");
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);

  const updatedCompany = await getCompanyById(id);
  const existingCount = updatedCompany?.contacts.length ?? totalContacts;

  if (
    updatedCompany?.contacts.some(
      (c) => c.personalEmail && c.imessageCapable == null,
    )
  ) {
    await requestImessageCheck();
  }

  let message: string | undefined;
    if (contactsAdded === 0 &&
    personalUpdated === 0 &&
    apolloPhonesAdded === 0 &&
    apolloRefreshed === 0
  ) {
    const parts = [`${existingCount} contact${existingCount === 1 ? "" : "s"} on file`];
    if (domainConfidence === "low") {
      parts.push(
        "domain is unverified — Apollo may not have HR contacts for this company",
      );
    }
    if (apolloPhonesRequested > 0) {
      if (apolloWebhookConfigured()) {
        parts.push("waiting for Apollo phone webhook");
      } else {
        parts.push(
          "Apollo phone webhook not configured — set NEXT_PUBLIC_APP_URL on Vercel",
        );
      }
    }
    if (contactoutChecked > 0) {
      if (contactoutPhoneLocked) {
        parts.push("ContactOut phone API locked — personal email/mobile unavailable");
      } else {
        parts.push(`ContactOut checked ${contactoutChecked} — no new personal data`);
      }
    } else if (!contactOutAvailable && contactOutKey) {
      parts.push("ContactOut out of credits — using Apollo emails and phones");
    } else if (!contactOutKey) {
      parts.push("ContactOut not configured on Vercel");
    }
    message = parts.join(" · ");
  } else if (apolloPhonesRequested > 0 && apolloPhonesAdded === 0 && contactsAdded === 0) {
    message = apolloWebhookConfigured()
      ? `${apolloRefreshed} contact(s) refreshed — phones may still be loading from Apollo`
      : `${apolloRefreshed} refreshed — configure NEXT_PUBLIC_APP_URL for Apollo phones`;
  }

  return NextResponse.json({
    ok: true,
    contacts_added: contactsAdded,
    apollo_refreshed: apolloRefreshed,
    apollo_phones_requested: apolloPhonesRequested,
    apollo_phones_added: apolloPhonesAdded,
    apollo_webhook_configured: apolloWebhookConfigured(),
    existing_contacts: existingCount,
    personal_updated: personalUpdated,
    contactout_checked: contactoutChecked,
    contactout_phone_locked: contactoutPhoneLocked || !contactOutAvailable,
    contactout_available: contactOutAvailable,
    phones_backfilled: phonesBackfilled,
    total_contacts: totalContacts,
    domain,
    company: updatedCompany,
    message,
  });
}
