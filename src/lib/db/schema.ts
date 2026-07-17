import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { JobBoardId } from "@/lib/job-boards";
import { DEFAULT_JOB_BOARDS } from "@/lib/job-boards";

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

export const icpStatusEnum = pgEnum("icp_status", ["pass", "fail", "unknown"]);

export type HiringSignalKey =
  | "reposted_role"
  | "multiple_openings"
  | "long_running"
  | "new_location_cluster"
  | "internal_ta_only"
  | "new_company";

export type HiringSignals = Partial<Record<HiringSignalKey, boolean | number>>;

export const activityTypeEnum = pgEnum("activity_type", [
  "call",
  "email",
  "note",
  "meeting",
]);

/** Outreach workflow statuses for the persistent CRM call list. */
export const callStatusEnum = pgEnum("call_status", [
  "new",
  "ready_to_call",
  "called_no_answer",
  "voicemail_left",
  "spoke_follow_up",
  "email_sent",
  "meeting_scheduled",
  "proposal_sent",
  "client_won",
  "not_interested",
  "bad_contact",
  "do_not_contact",
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
  metroCities: jsonb("metro_cities").$type<string[]>().default([]),
  metroAliases: jsonb("metro_aliases").$type<string[]>().default([]),
  notificationEmail: text("notification_email")
    .default("hello@proventheory.co")
    .notNull(),
  jobBoards: jsonb("job_boards")
    .$type<JobBoardId[]>()
    .default([...DEFAULT_JOB_BOARDS]),
  emailReportPreferences: jsonb("email_report_preferences").$type<
    import("@/lib/email-report-preferences").EmailReportPreferences
  >(),
  /** Decision-maker titles for Apollo/ContactOut — not scrape search terms. */
  contactTitles: jsonb("contact_titles").$type<string[]>().default([]),
  runRequestedAt: timestamp("run_requested_at"),
  runClaimedAt: timestamp("run_claimed_at"),
  contactoutSyncRequestedAt: timestamp("contactout_sync_requested_at"),
  contactoutCreditsExhaustedAt: timestamp("contactout_credits_exhausted_at"),
  imessageCheckRequestedAt: timestamp("imessage_check_requested_at"),
  dailyEnrichQuota: integer("daily_enrich_quota").default(25).notNull(),
  minScoreForEnrich: integer("min_score_for_enrich").default(60).notNull(),
  minScoreForPhone: integer("min_score_for_phone").default(75).notNull(),
  lastRunAt: timestamp("last_run_at"),
  workerLastSeenAt: timestamp("worker_last_seen_at"),
  workerCommitSha: text("worker_commit_sha"),
  workerBranch: text("worker_branch"),
  workerDirty: boolean("worker_dirty").default(false),
  workerAgentSummary: text("worker_agent_summary"),
  workerStatusPayload: jsonb("worker_status_payload").$type<Record<string, unknown>>(),
  workerStatusAt: timestamp("worker_status_at"),
  missedRunAlertSlot: text("missed_run_alert_slot"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const stateGeoConfigs = pgTable(
  "state_geo_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stateName: text("state_name").notNull(),
    stateAbbr: text("state_abbr").notNull(),
    cities: jsonb("cities").$type<string[]>().default([]).notNull(),
    counties: jsonb("counties").$type<string[]>().default([]).notNull(),
    defaultFocusCities: jsonb("default_focus_cities")
      .$type<string[]>()
      .default([])
      .notNull(),
    defaultFocusCounties: jsonb("default_focus_counties")
      .$type<string[]>()
      .default([])
      .notNull(),
    defaultMetroCities: jsonb("default_metro_cities")
      .$type<string[]>()
      .default([])
      .notNull(),
    defaultMetroAliases: jsonb("default_metro_aliases")
      .$type<string[]>()
      .default([])
      .notNull(),
    cityCountyMap: jsonb("city_county_map")
      .$type<Record<string, string[]>>()
      .default({})
      .notNull(),
    metroPresets: jsonb("metro_presets")
      .$type<
        Record<
          string,
          {
            marketName?: string;
            metroCities?: string[];
            metroAliases?: string[];
            focusCounties?: string[];
          }
        >
      >()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("state_geo_configs_state_name_uq").on(table.stateName)],
);

export const searchProfiles = pgTable(
  "search_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    searchTerm: text("search_term").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    isRemote: boolean("is_remote"),
    resultsWanted: integer("results_wanted").default(50),
    hoursOld: integer("hours_old").default(168),
    /** LinkedIn search radius in miles; null = wide (JobSpy default). Per-title tuning. */
    linkedinDistance: integer("linkedin_distance"),
    sortOrder: integer("sort_order").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("search_profiles_term_unique").on(table.searchTerm)],
);

export const dailyRuns = pgTable(
  "daily_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runDate: date("run_date").notNull(),
    /** Scheduled batch: am (6 AM ET), pm (6 PM ET), or manual. */
    runSlot: text("run_slot").notNull().default("am"),
    /** Market active in Admin when this run scraped (e.g. "Charlotte, NC"). */
    market: text("market"),
    listingsScraped: integer("listings_scraped").default(0),
    companiesFound: integer("companies_found").default(0),
    companiesSkippedExisting: integer("companies_skipped_existing").default(0),
    companiesEnriched: integer("companies_enriched").default(0),
    contactsEnriched: integer("contacts_enriched").default(0),
    creditsUsed: integer("credits_used").default(0),
    icpMatchCount: integer("icp_match_count").default(0),
    enrichmentQuota: integer("enrichment_quota").default(0),
    companiesScored: integer("companies_scored").default(0),
    companiesDeferred: integer("companies_deferred").default(0),
    errors: text("errors"),
    funnelJson: jsonb("funnel_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daily_runs_date_slot_uq").on(table.runDate, table.runSlot),
  ],
);

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
  leadScore: integer("lead_score").default(0).notNull(),
  hiringSignals: jsonb("hiring_signals").$type<HiringSignals>().default({}),
  reasonToCall: text("reason_to_call"),
  callOpener: text("call_opener"),
  callOpenerGeneratedAt: timestamp("call_opener_generated_at"),
  icpStatus: icpStatusEnum("icp_status").default("unknown").notNull(),
  estimatedEmployees: integer("estimated_employees"),
  industry: text("industry"),
  enrichedAt: timestamp("enriched_at"),
  enrichRunDate: date("enrich_run_date"),
  /**
   * Market active in Admin when this company was first scraped
   * (e.g. "Charlotte, NC"). Provenance tag for the consolidated CRM view;
   * nullable — historical rows are derived from job locations at read time.
   */
  sourceMarket: text("source_market"),
  /**
   * Set when a reveal-off discovery search completed for this company.
   * The candidate cache: re-opening the picker never re-searches — the
   * search credit is paid once per company, ever.
   */
  discoveryCompletedAt: timestamp("discovery_completed_at"),
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
  workEmail: text("work_email"),
  personalEmail: text("personal_email"),
  /** Additional personal emails from ContactOut (up to 2 total), best first. */
  personalEmails: jsonb("personal_emails").$type<string[]>().default([]),
  phone: text("phone"),
  personalPhone: text("personal_phone"),
  companyPhone: text("company_phone"),
  phones: jsonb("phones")
    .$type<
      Array<{
        number: string;
        source: "apollo" | "contactout";
        kind?: "mobile" | "work" | "company" | "other";
      }>
    >()
    .default([]),
  linkedinUrl: text("linkedin_url"),
  apolloId: text("apollo_id"),
  sourceProvider: text("source_provider").default("apollo"),
  imessageCapable: boolean("imessage_capable"),
  emailDeliverable: boolean("email_deliverable"),
  emailVerifiedAt: timestamp("email_verified_at"),
  presenceCheckedAt: timestamp("presence_checked_at"),
  locationMatched: boolean("location_matched").default(false).notNull(),
  contactLocation: text("contact_location"),
  jobLocation: text("job_location"),
  /**
   * Selective enrichment state: 'discovered' = found by a reveal-off search
   * (no email/phone credits spent), 'revealed' = reveal credits spent on
   * selection. NULL = legacy contact from the pre-split enrich flow.
   */
  revealStatus: text("reveal_status"),
  /** Channels paid for at reveal: 'email' | 'email_phone'. */
  revealChannels: text("reveal_channels"),
  /** Best contact for outreach (picker pre-selection). */
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const providerUsageEvents = pgTable("provider_usage_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(),
  endpoint: text("endpoint").notNull(),
  egressContext: text("egress_context").notNull(),
  triggerSource: text("trigger_source").notNull(),
  companyId: uuid("company_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  recordsReturned: integer("records_returned").default(0).notNull(),
  estimatedCost: integer("estimated_cost").default(0).notNull(),
  blocked: boolean("blocked").default(false).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
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
  salaryMin: integer("salary_min"),
  salaryMax: integer("salary_max"),
  salaryCurrency: text("salary_currency").default("USD"),
  salaryText: text("salary_text"),
  postedAt: timestamp("posted_at"),
  posterName: text("poster_name"),
  posterTitle: text("poster_title"),
  posterLinkedinUrl: text("poster_linkedin_url"),
  urlFingerprint: text("url_fingerprint"),
  sightingsCount: integer("sightings_count").default(1).notNull(),
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  lastSeenRunDate: date("last_seen_run_date"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Persistent CRM call list — one entry per approved company.
 * Company/contact/job facts stay on their own tables and are joined live;
 * this table only owns the mutable call-tracking workflow fields.
 */
export const callListEntries = pgTable(
  "call_list_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    /** Best contact to dial — switchable if a better contact turns up. */
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    callStatus: callStatusEnum("call_status").default("ready_to_call").notNull(),
    callStatusUpdatedAt: timestamp("call_status_updated_at"),
    /** Editable override; falls back to companies.reason_to_call when null. */
    outreachAngle: text("outreach_angle"),
    attempts: integer("attempts").default(0).notNull(),
    lastContactAt: timestamp("last_contact_at"),
    nextFollowUpDate: date("next_follow_up_date"),
    notes: text("notes"),
    assignedTo: text("assigned_to"),
    finalResult: text("final_result"),
    addedAt: timestamp("added_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("call_list_entries_company_uq").on(table.companyId),
  ],
);

/**
 * ICP scoring annotations — a sibling table so the ICP layer cannot alter
 * existing company rows. Annotations only: nothing here deletes, hides, or
 * reorders pipeline data; the CRM view applies reversible filters on top.
 */
export const companyIcp = pgTable(
  "company_icp",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    /** Snapshot of the hiring-signal score at scoring time (dual-score view). */
    baseLeadScore: integer("base_lead_score"),
    /** base × recruiter-fit multiplier + bonuses, clamped 0–100. */
    icpAdjustedScore: integer("icp_adjusted_score"),
    /** e.g. ["fortune_500","public_sector","staffing_agency"]. */
    exclusionFlags: jsonb("exclusion_flags").$type<string[]>(),
    /** Per-flag confidence 0–1 — every flag MUST have an entry. */
    exclusionConfidence: jsonb("exclusion_confidence").$type<
      Record<string, number>
    >(),
    roleType: text("role_type"),
    roleTypeConfidence: real("role_type_confidence"),
    compAnnualMin: integer("comp_annual_min"),
    compAnnualMax: integer("comp_annual_max"),
    /** True when comp was estimated from the config table, not the listing. */
    compEstimatedFlag: boolean("comp_estimated_flag"),
    compConfidence: text("comp_confidence"),
    companySizeBand: text("company_size_band"),
    likelyToUseRecruiter: real("likely_to_use_recruiter"),
    enrichmentTier: text("enrichment_tier"),
    scoredAt: timestamp("scored_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("company_icp_company_uq").on(table.companyId)],
);

export const companyActivities = pgTable("company_activities", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id, { onDelete: "cascade" })
    .notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  type: activityTypeEnum("type").notNull(),
  summary: text("summary").notNull(),
  rawTranscript: text("raw_transcript"),
  classification: text("classification"),
  source: text("source").default("manual").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Company = typeof companies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type JobListing = typeof jobListings.$inferSelect;
export type CompanyActivity = typeof companyActivities.$inferSelect;
export type ActivityType = (typeof activityTypeEnum.enumValues)[number];
export type DailyRun = typeof dailyRuns.$inferSelect;
export type ProviderUsageEvent = typeof providerUsageEvents.$inferSelect;
export type PipelineSettings = typeof pipelineSettings.$inferSelect;
export type StateGeoConfigRow = typeof stateGeoConfigs.$inferSelect;
export type SearchProfile = typeof searchProfiles.$inferSelect;
export type CallListEntry = typeof callListEntries.$inferSelect;
export type CompanyIcp = typeof companyIcp.$inferSelect;
export type CallStatus = (typeof callStatusEnum.enumValues)[number];
export type CompanyStatus = (typeof companyStatusEnum.enumValues)[number];
export type GeographicScope = (typeof geographicScopeEnum.enumValues)[number];
export type IcpStatus = (typeof icpStatusEnum.enumValues)[number];
