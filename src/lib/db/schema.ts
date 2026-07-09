import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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

export const geographicScopeEnum = pgEnum("geographic_scope", [
  "national",
  "state",
  "city",
  "county",
]);

export const pipelineSettings = pgTable("pipeline_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  geographicScope: geographicScopeEnum("geographic_scope")
    .default("state")
    .notNull(),
  focusState: text("focus_state").default("Florida"),
  focusCity: text("focus_city"),
  focusCounty: text("focus_county"),
  focusCities: jsonb("focus_cities").$type<string[]>().default([]),
  focusCounties: jsonb("focus_counties").$type<string[]>().default([]),
  notificationEmail: text("notification_email")
    .default("hello@proventheory.co")
    .notNull(),
  runRequestedAt: timestamp("run_requested_at"),
  lastRunAt: timestamp("last_run_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const searchProfiles = pgTable(
  "search_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    searchTerm: text("search_term").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    isRemote: boolean("is_remote"),
    resultsWanted: integer("results_wanted").default(50),
    hoursOld: integer("hours_old").default(24),
    sortOrder: integer("sort_order").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("search_profiles_term_unique").on(table.searchTerm)],
);

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
export type PipelineSettings = typeof pipelineSettings.$inferSelect;
export type SearchProfile = typeof searchProfiles.$inferSelect;
export type CompanyStatus = (typeof companyStatusEnum.enumValues)[number];
export type GeographicScope = (typeof geographicScopeEnum.enumValues)[number];
