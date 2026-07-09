import {
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const companyStatusEnum = pgEnum("company_status", [
  "new",
  "contacted",
  "meeting",
  "client",
  "skipped",
]);

export const domainConfidenceEnum = pgEnum("domain_confidence", [
  "high",
  "low",
]);

export const dailyRuns = pgTable("daily_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  runDate: date("run_date").notNull().unique(),
  listingsScraped: integer("listings_scraped").default(0),
  companiesFound: integer("companies_found").default(0),
  companiesSkippedExisting: integer("companies_skipped_existing").default(0),
  companiesEnriched: integer("companies_enriched").default(0),
  contactsEnriched: integer("contacts_enriched").default(0),
  creditsUsed: integer("credits_used").default(0),
  errors: text("errors"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  domain: text("domain").unique(),
  domainConfidence: domainConfidenceEnum("domain_confidence")
    .default("low")
    .notNull(),
  status: companyStatusEnum("status").default("new").notNull(),
  firstSeen: date("first_seen").notNull(),
  dailyRunId: uuid("daily_run_id").references(() => dailyRuns.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  linkedinUrl: text("linkedin_url"),
  apolloId: text("apollo_id"),
  sourceProvider: text("source_provider").default("apollo"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const jobListings = pgTable("job_listings", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id, { onDelete: "cascade" })
    .notNull(),
  title: text("title").notNull(),
  board: text("board"),
  url: text("url"),
  location: text("location"),
  searchName: text("search_name"),
  postedAt: timestamp("posted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Company = typeof companies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type JobListing = typeof jobListings.$inferSelect;
export type DailyRun = typeof dailyRuns.$inferSelect;
export type CompanyStatus = (typeof companyStatusEnum.enumValues)[number];
