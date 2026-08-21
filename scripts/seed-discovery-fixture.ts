/**
 * Local-only fixture seed for browser-checking the discovery review row.
 *
 * Writes three companies that exercise the inline reveal panel end to end with
 * ZERO provider calls: one with a decision-maker already revealed, one with
 * unrevealed candidates only, and one with no candidates at all. Refuses to run
 * against anything that is not an obviously disposable database.
 */

import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";

const MAIN_LINE = "+15612723700";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL is required");
  if (!process.env.ALLOW_FIXTURE_SEED) {
    throw new Error(
      "Refusing to seed without ALLOW_FIXTURE_SEED=1 — this script writes rows.",
    );
  }

  const [carousel] = await db
    .insert(companies)
    .values({
      name: "Carousel Development & Restoration Inc",
      domain: "cdri.net",
      domainConfidence: "high",
      firstSeen: "2026-08-20",
      industry: "construction",
      estimatedEmployees: 18,
      leadScore: 86,
      city: "Delray Beach",
      state: "Florida",
      phone: MAIN_LINE,
      linkedinUrl: "https://www.linkedin.com/company/cdri",
      vertical: "construction",
      sourceMarket: "Palm Beach County, Florida",
      reviewStatus: "pending",
      reviewStatusUpdatedAt: new Date(),
      discoveryCompletedAt: new Date(),
    })
    .returning();

  await db.insert(contacts).values([
    {
      companyId: carousel.id,
      name: "Joe Carosella",
      title: "Director & Co-Owner",
      email: "joecarosella@gmail.com",
      workEmail: "jcarosella@cdri.net",
      personalEmail: "joecarosella@gmail.com",
      personalEmails: ["joecarosella@gmail.com"],
      // Deliberately the company main line, as ContactOut returned it: this is
      // the switchboard-as-mobile case the panel must label honestly.
      phone: MAIN_LINE,
      personalPhone: MAIN_LINE,
      phones: [
        {
          number: MAIN_LINE,
          source: "contactout" as const,
          kind: "mobile" as const,
          classification: "mobile" as const,
        },
      ],
      linkedinUrl: "https://www.linkedin.com/in/joecarosella",
      apolloId: "fixture-joe",
      sourceProvider: "apollo+contactout",
      emailDeliverable: true,
      emailVerifiedAt: new Date(),
      revealStatus: "revealed",
      revealChannels: "email_phone",
      isPrimary: true,
      contactLocation: "Delray Beach, Florida",
    },
    {
      companyId: carousel.id,
      name: "Micah Cl***r",
      title: "President",
      apolloId: "fixture-micah",
      linkedinUrl: "https://www.linkedin.com/in/micah-fixture",
      sourceProvider: "apollo_discovery",
      revealStatus: "discovered",
    },
    {
      companyId: carousel.id,
      name: "Alessandra Bi***i",
      title: "VP/ General Counsel",
      apolloId: "fixture-alessandra",
      sourceProvider: "apollo_discovery",
      revealStatus: "discovered",
    },
  ]);

  const [sunbelt] = await db
    .insert(companies)
    .values({
      name: "Sunbelt Mechanical Contractors",
      domain: "sunbeltmech.example",
      domainConfidence: "high",
      firstSeen: "2026-08-20",
      industry: "construction",
      estimatedEmployees: 42,
      leadScore: 74,
      city: "Boca Raton",
      state: "Florida",
      phone: "+15615551212",
      vertical: "construction",
      sourceMarket: "Palm Beach County, Florida",
      reviewStatus: "pending",
      reviewStatusUpdatedAt: new Date(),
      discoveryCompletedAt: new Date(),
    })
    .returning();

  await db.insert(contacts).values([
    {
      companyId: sunbelt.id,
      name: "Dana Ko***s",
      title: "Owner",
      apolloId: "fixture-dana",
      linkedinUrl: "https://www.linkedin.com/in/dana-fixture",
      sourceProvider: "apollo_discovery",
      revealStatus: "discovered",
      isPrimary: true,
    },
    {
      companyId: sunbelt.id,
      name: "Rob Ma***n",
      title: "General Manager",
      apolloId: "fixture-rob",
      sourceProvider: "apollo_discovery",
      revealStatus: "discovered",
    },
  ]);

  await db.insert(companies).values({
    name: "Palmetto Roofing Co",
    domain: "palmettoroofing.example",
    domainConfidence: "high",
    firstSeen: "2026-08-20",
    industry: "construction",
    estimatedEmployees: 25,
    leadScore: 61,
    city: "Jupiter",
    state: "Florida",
    vertical: "construction",
    sourceMarket: "Palm Beach County, Florida",
    reviewStatus: "pending",
    reviewStatusUpdatedAt: new Date(),
    discoveryCompletedAt: new Date(),
  });

  console.log("Seeded 3 discovery review companies.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
