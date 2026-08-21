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

/**
 * How the lead entered the system, which decides what channels are legal:
 * cold_discovery is email-only plus a human call to the business line;
 * the inbound lanes arrive with a consent artifact and are excluded from
 * cold calling because they already raised a hand.
 */
export const leadSourceEnum = pgEnum("lead_source", [
  "cold_discovery",
  "inbound_form",
  "inbound_meta",
]);

/**
 * Dial-safety class of a stored number. `unknown` is treated exactly like
 * `mobile` by every gate: TCPA restrictions attach to the number type, so an
 * unclassified number must never be assumed to be a landline.
 */
export const phoneClassificationEnum = pgEnum("phone_classification", [
  "business_line",
  "mobile",
  "unknown",
]);

/**
 * Operator review state for company-first discovery. Deliberately SEPARATE
 * from companyStatusEnum: outreach enrollment gates on `status = 'new'`, so
 * overloading that enum with review states would silently stop enrollment.
 * Null = never went through the review queue (every job-scraped company).
 */
export const companyReviewStatusEnum = pgEnum("company_review_status", [
  "pending",
  "approved",
  "rejected",
  "review_later",
  "already_contacted",
  "existing_client",
  "do_not_contact",
]);

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
  "replied_interested",
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
            /** Google/SerpApi zone collapse: 1–2 hub cities Google queries. */
            googleZones?: string[];
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
    /** Scheduled batch: am (5 AM ET), pm (6 PM ET), or manual. */
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
  /** Main company line from Apollo organization search (not a contact phone). */
  phone: text("phone"),
  /**
   * Dial class of `phone`. Apollo organization search is the only writer of
   * that column and it returns the published main line, so the default is
   * business_line; anything else must be set explicitly.
   */
  phoneClassification: phoneClassificationEnum("phone_classification")
    .default("business_line")
    .notNull(),
  linkedinUrl: text("linkedin_url"),
  /**
   * Lane the lead came in on. Every pre-existing row and every discovery
   * insert is cold_discovery, so channel behaviour for the existing pipeline
   * is unchanged; the inbound lanes are set by the opt-in endpoint.
   */
  leadSource: leadSourceEnum("lead_source").default("cold_discovery").notNull(),
  /** Discovery vertical (legal, finance_accounting, …); null = job-scraped. */
  vertical: text("vertical"),
  city: text("city"),
  state: text("state"),
  /**
   * Review-queue state. Null for every pre-discovery row so existing pipeline
   * behaviour is untouched; discovery stamps 'pending' on what it inserts.
   */
  reviewStatus: companyReviewStatusEnum("review_status"),
  reviewStatusUpdatedAt: timestamp("review_status_updated_at"),
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

/**
 * Pagination state for company-first discovery — "25 new per day" is a
 * sustained rate against a finite pool (a single county's law firms are a few
 * hundred companies), so day 2 must not re-return day 1.
 *
 * One row per (vertical, market, pool). `pool` splits the size-filtered query
 * from the companion query that surfaces unknown-headcount companies: Apollo's
 * `organization_num_employees_ranges` filter drops companies it has no
 * headcount for, and those are exactly the small firms the operator wants.
 * The two queries page independently, so they need independent cursors.
 */
export const companyDiscoveryRuns = pgTable(
  "company_discovery_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vertical: text("vertical").notNull(),
    market: text("market").notNull(),
    /** 'sized' | 'unknown_size' */
    pool: text("pool").default("sized").notNull(),
    /** Apollo page size this cursor was built with — the offset depends on it. */
    perPage: integer("per_page").default(25).notNull(),
    /** Apollo organizations consumed so far; the page offset derives from this. */
    consumed: integer("consumed").default(0).notNull(),
    /** Apollo pagination.total_entries — the pool size for this filter set. */
    totalEntries: integer("total_entries"),
    pagesFetched: integer("pages_fetched").default(0).notNull(),
    /** Set when Apollo has no more results — rotate market. */
    poolExhausted: boolean("pool_exhausted").default(false).notNull(),
    lastRunAt: timestamp("last_run_at"),
    lastReturned: integer("last_returned").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("company_discovery_runs_vertical_market_pool_uq").on(
      table.vertical,
      table.market,
      table.pool,
    ),
  ],
);

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
    .$type<import("@/lib/contact-phones").SourcedPhone[]>()
    .default([]),
  /**
   * Dial class of the contact's primary number. ContactOut is the main source
   * of contact numbers and returns personal mobiles, so the default is mobile
   * — the classification that blocks dialing.
   */
  phoneClassification: phoneClassificationEnum("phone_classification")
    .default("mobile")
    .notNull(),
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
  /**
   * Outreach sequencing: IANA timezone that wins over location inference
   * when set (remote workers whose inferred location is wrong).
   */
  timezoneOverride: text("timezone_override"),
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
    /** Job listing that triggered outreach (Job Listings tab / lead primary). */
    jobListingId: uuid("job_listing_id").references(() => jobListings.id, {
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

/* ============================================================================
 * Consent, consented inbound leads, and compliant human calling.
 *
 * `suppressions` records how to STOP. Nothing recorded how permission was
 * GRANTED, and `sequence_enrollments.legal_basis` is a B2B email posture, not
 * consent. These tables hold the artifact that would have to defend a TCPA
 * claim: the exact words shown, where they were shown, when, and to whom.
 * ========================================================================== */

export const consentChannelScopeEnum = pgEnum("consent_channel_scope", [
  "email",
  "sms",
  "both",
]);

/**
 * Mechanism the consent was captured by. Only mechanisms that produce a
 * written E-SIGN artifact are listed: keypress/voice capture is deliberately
 * absent because E-SIGN 7001(c)(6) excludes recordings of oral communications
 * and the Fifth Circuit split from the FCC on it in Feb 2026.
 */
export const consentSourceEnum = pgEnum("consent_source", [
  "web_form",
  "meta_lead_ad",
  "inbound_written_request",
]);

/** Result of a human dial. No telephony vendor — the operator reports these. */
export const callOutcomeEnum = pgEnum("call_outcome", [
  "placed",
  "connected",
  "no_answer",
  "voicemail",
  "gatekeeper",
  "wrong_number",
]);

/**
 * Consent artifacts. Retention guidance is five years, so nothing here is
 * hard-deleted: a withdrawal sets revoked_at and the row survives as proof
 * that consent existed for the period it covered.
 */
export const consentRecords = pgTable("consent_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  companyId: uuid("company_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  /** Raw values the consent covers, as submitted — not a normalized join key. */
  email: text("email"),
  phone: text("phone"),
  channelScope: consentChannelScopeEnum("channel_scope").notNull(),
  /**
   * The disclosure the person actually saw, stored verbatim. A version tag or
   * a pointer to today's copy would be worthless: the defence is the wording
   * rendered at capture time, not the wording currently deployed.
   */
  disclosureText: text("disclosure_text").notNull(),
  source: consentSourceEnum("source").notNull(),
  /** Form id, Meta campaign/form id, or the inbound message id. */
  sourceIdentifier: text("source_identifier"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  /** Web opt-ins only; null for written requests arriving by email. */
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  revokedAt: timestamp("revoked_at"),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** One row per human dial attempt — the CRM's record of what happened. */
export const callOutcomes = pgTable("call_outcomes", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id, { onDelete: "cascade" })
    .notNull(),
  callListEntryId: uuid("call_list_entry_id").references(
    () => callListEntries.id,
    { onDelete: "set null" },
  ),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  outcome: callOutcomeEnum("outcome").notNull(),
  /** Number dialed and the class it was dialed under (audit of the gate). */
  phone: text("phone"),
  phoneClassification: phoneClassificationEnum("phone_classification"),
  notes: text("notes"),
  loggedBy: text("logged_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Opt-in form links emailed from the call screen. This replaces a press-1
 * IVR: the call's job is to earn a form click, so the send is the tracked
 * unit and consent conversion is measured against it.
 */
export const optInLinkSends = pgTable("opt_in_link_sends", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id, { onDelete: "cascade" })
    .notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  callOutcomeId: uuid("call_outcome_id").references(() => callOutcomes.id, {
    onDelete: "set null",
  }),
  email: text("email").notNull(),
  formUrl: text("form_url").notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  sentBy: text("sent_by"),
  /** Set when the send failed — the attempt is still recorded. */
  error: text("error"),
});

/* ============================================================================
 * Outreach Sequencer — email + iMessage automation.
 * Replies are the main event: every inbound flows through the classifier and
 * rule engine; every decision writes to enrollment_events (append-only audit,
 * doubles as the compliance record).
 * ========================================================================== */

export const outreachChannelEnum = pgEnum("outreach_channel", [
  "email",
  "imessage",
]);

export const outreachTemplateKindEnum = pgEnum("outreach_template_kind", [
  "intro",
  "followup_1",
  "followup_2",
  "text_1",
  "text_2",
  "text_3",
  "reply_positive",
  "reply_info_request",
  "reply_decline",
  /** Texted "your meeting is booked" confirmation for SMS only threads. */
  "booking_confirmation",
]);

export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "active",
  "paused",
  "waiting_on_reply",
  "waiting_on_manual",
  "completed",
  "replied_positive",
  "replied_negative",
  "bounced",
  "stopped",
  "suppressed",
]);

export const outreachMessageStatusEnum = pgEnum("outreach_message_status", [
  "drafted",
  "queued",
  "sent",
  "failed",
  "skipped",
  "cancelled",
]);

export const inboundIntentEnum = pgEnum("inbound_intent", [
  "positive",
  "positive_link_request",
  "info_request",
  "negative",
  "opt_out",
  "wrong_person",
  "ooo",
  "courtesy",
  "data_deletion",
  "bounce_hard",
  "bounce_soft",
  "complaint",
  "unknown",
]);

export const suppressionChannelEnum = pgEnum("suppression_channel", [
  "email",
  "imessage",
  "all",
]);

export const sendingProfileKindEnum = pgEnum("sending_profile_kind", [
  "email_domain",
  "imessage_number",
]);

/** Warm-up state machine: new → verifying → warming → active, with
 * throttled/paused on violations and banned as the terminal state. */
export const sendingProfileStatusEnum = pgEnum("sending_profile_status", [
  "new",
  "verifying",
  "warming",
  "active",
  "throttled",
  "paused",
  "banned",
]);

/** Winning emails as style exemplars — data for the LLM, never executable. */
export const outreachTemplates = pgTable("outreach_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  kind: outreachTemplateKindEnum("kind").notNull(),
  channel: outreachChannelEnum("channel").default("email").notNull(),
  exampleSubject: text("example_subject"),
  exampleBody: text("example_body").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  /**
   * Provenance, not performance: true when this exemplar is a verbatim message
   * that was really sent and really got a reply. False means it was written in
   * that voice to give a step kind coverage. Used to be smuggled into the name
   * as "(won reply)".
   */
  isProven: boolean("is_proven").default(false).notNull(),
  // Performance counters, recomputed from message history (never incremented).
  timesUsed: integer("times_used").default(0).notNull(),
  timesReplied: integer("times_replied").default(0).notNull(),
  timesPositive: integer("times_positive").default(0).notNull(),
  timesOptOut: integer("times_opt_out").default(0).notNull(),
  /** Set when analytics flags this template as underperforming. */
  flaggedAt: timestamp("flagged_at"),
  flagReason: text("flag_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Per-node runtime state for flow enrollments (retry counts, deadlines…). */
export type EnrollmentNodeState = {
  retry_count?: number;
  wait_until?: string;
  manual_deadline?: string;
  split_assignments?: Record<string, string>;
  ooo_count?: number;
  soft_bounce_count?: number;
  [key: string]: unknown;
};

export const sequenceEnrollments = pgTable("sequence_enrollments", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id")
    .references(() => contacts.id, { onDelete: "cascade" })
    .notNull(),
  companyId: uuid("company_id")
    .references(() => companies.id, { onDelete: "cascade" })
    .notNull(),
  /** Listing the sequence was drafted about (Claude personalization pin). */
  jobListingId: uuid("job_listing_id").references(() => jobListings.id, {
    onDelete: "set null",
  }),
  status: enrollmentStatusEnum("status").default("active").notNull(),
  enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
  nextStepAt: timestamp("next_step_at"),
  /** IANA timezone resolved at enrollment (override > inferred > HQ > ET). */
  timezone: text("timezone").default("America/New_York").notNull(),
  /** Email chosen at enrollment (work preferred, personal fallback). */
  emailAddress: text("email_address"),
  /** iMessage-capable number, or null for email-only sequences. */
  phoneNumber: text("phone_number"),
  stopReason: text("stop_reason"),
  stoppedBy: text("stopped_by"),
  legalBasis: text("legal_basis")
    .default("legitimate interest — B2B recruitment outreach")
    .notNull(),
  // Flow engine (phase 5): enrollments pin to an immutable flow version.
  flowVersionId: uuid("flow_version_id"),
  currentNodeId: text("current_node_id"),
  nodeState: jsonb("node_state").$type<EnrollmentNodeState>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const outreachMessages = pgTable("outreach_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  enrollmentId: uuid("enrollment_id")
    .references(() => sequenceEnrollments.id, { onDelete: "cascade" })
    .notNull(),
  stepKind: outreachTemplateKindEnum("step_kind").notNull(),
  /** Flow node that produced this message (phase 5). */
  nodeId: text("node_id"),
  channel: outreachChannelEnum("channel").notNull(),
  scheduledFor: timestamp("scheduled_for"),
  status: outreachMessageStatusEnum("status").default("drafted").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  /** Resend-internal id from the send response (webhook matching). */
  resendId: text("resend_id"),
  /**
   * RFC 5322 Message-ID from Resend's send response — REQUIRED to thread
   * auto-replies via In-Reply-To/References; resend_id alone can't thread.
   */
  messageId: text("message_id"),
  sendingProfileId: uuid("sending_profile_id"),
  templateId: uuid("template_id"),
  sentAt: timestamp("sent_at"),
  attemptCount: integer("attempt_count").default(0).notNull(),
  /** e.g. capacity_exhausted — queued but deferred, re-checked each window. */
  deferredReason: text("deferred_reason"),
  error: text("error"),
  /** Approval gate: dry-run/preview mode holds sends until approved. */
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** All inbound (email + iMessage) in ONE table — the rule engine never
 * cares about channel; a text reply and an email reply branch identically. */
export const inboundMessages = pgTable("inbound_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  enrollmentId: uuid("enrollment_id").references(() => sequenceEnrollments.id, {
    onDelete: "set null",
  }),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  channel: outreachChannelEnum("channel").notNull(),
  fromAddress: text("from_address"),
  subject: text("subject"),
  rawBody: text("raw_body").notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  classifiedIntent: inboundIntentEnum("classified_intent"),
  confidence: real("confidence"),
  actionTaken: text("action_taken"),
  /** IMAP Message-ID / chat.db guid / resend event id — dedupe key. */
  externalId: text("external_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("inbound_messages_external_id_uq").on(table.externalId),
]);

/** Checked per channel before EVERY send — even mid-flow. */
export const suppressions = pgTable("suppressions", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email"),
  phone: text("phone"),
  channel: suppressionChannelEnum("channel").default("all").notNull(),
  reason: text("reason").notNull(),
  legalBasis: text("legal_basis"),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Append-only audit log — every decision reconstructable. Non-negotiable. */
export const enrollmentEvents = pgTable("enrollment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  enrollmentId: uuid("enrollment_id").references(() => sequenceEnrollments.id, {
    onDelete: "cascade",
  }),
  /** enrolled | drafted | sent | reply_received | classified | rule_action |
   *  node_transition | manual_intervention | error | retry | cancelled |
   *  migrated_version | suppressed | deferred | purged */
  eventType: text("event_type").notNull(),
  /** system | rule:<intent> | user */
  actor: text("actor").default("system").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const outreachNotifications = pgTable("outreach_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  intent: text("intent").notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  companyId: uuid("company_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  inboundMessageId: uuid("inbound_message_id").references(
    () => inboundMessages.id,
    { onDelete: "set null" },
  ),
  snippet: text("snippet"),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Flow definitions (phase 5). Versions are immutable JSON graphs. */
export const outreachFlows = pgTable("outreach_flows", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** draft | active | archived */
  status: text("status").default("draft").notNull(),
  /** The pre-built phase-1 cadence ships locked (not editable/deletable). */
  isLocked: boolean("is_locked").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const outreachFlowVersions = pgTable(
  "outreach_flow_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    flowId: uuid("flow_id")
      .references(() => outreachFlows.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    /** Declarative graph: nodes, edges, per-node config. NEVER executed as
     * code — interpreted by the engine, validated against a strict schema. */
    graph: jsonb("graph").$type<import("@/lib/outreach/flow-types").FlowGraph>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("outreach_flow_versions_flow_version_uq").on(
      table.flowId,
      table.version,
    ),
  ],
);

/** Polymorphic sending identities: email domains today, iMessage numbers
 * schema-ready. Dispatch asks the pool for capacity, whatever the kind. */
export const sendingProfiles = pgTable("sending_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: sendingProfileKindEnum("kind").default("email_domain").notNull(),
  label: text("label").notNull(),
  /** email_domain: sending domain (reach1.example.com). */
  domain: text("domain"),
  fromAddress: text("from_address"),
  replyToAddress: text("reply_to_address"),
  /** imessage_number: phone + Apple ID label. */
  phoneNumber: text("phone_number"),
  appleIdLabel: text("apple_id_label"),
  /** Subdomains of one root get correlated — health rolls up per root too. */
  rootDomain: text("root_domain"),
  status: sendingProfileStatusEnum("status").default("new").notNull(),
  /** Env var NAME holding this profile's Resend key — keys never in DB. */
  resendKeyRef: text("resend_key_ref"),
  dailyLimit: integer("daily_limit").default(5).notNull(),
  /** Warm-up ramp step (0-based). Cap = 5 + 5×step, ceiling ~50/day. */
  rampStage: integer("ramp_stage").default(0).notNull(),
  lastRampAt: timestamp("last_ramp_at"),
  /** Start of the current clean streak (no violations). */
  cleanSince: timestamp("clean_since"),
  warmingStartedAt: timestamp("warming_started_at"),
  verifiedAt: timestamp("verified_at"),
  lastDnsCheck: jsonb("last_dns_check").$type<Record<string, unknown>>(),
  // Health counters (bounce-weighted early, reply-weighted after maturity).
  totalSent: integer("total_sent").default(0).notNull(),
  totalDelivered: integer("total_delivered").default(0).notNull(),
  totalBounced: integer("total_bounced").default(0).notNull(),
  totalComplaints: integer("total_complaints").default(0).notNull(),
  totalReplies: integer("total_replies").default(0).notNull(),
  totalPositive: integer("total_positive").default(0).notNull(),
  pausedReason: text("paused_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Singleton — global safety overrides that sit ABOVE sequences/flows. */
export const outreachSettings = pgTable("outreach_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Global kill switch: nothing sends while false. Ships OFF. */
  enabled: boolean("enabled").default(false).notNull(),
  /** Dry-run: draft + schedule but never send; messages held for preview. */
  dryRun: boolean("dry_run").default(true).notNull(),
  /** Approval gate: every message needs approvedAt before dispatch. */
  requireApproval: boolean("require_approval").default(true).notNull(),
  /** System-level daily cap across all profiles (0 = no extra cap). */
  dailySendCap: integer("daily_send_cap").default(100).notNull(),
  /** Auto-enroll on call-list add (+ enrich ingest). Manual enroll always available. */
  autoEnroll: boolean("auto_enroll").default(true).notNull(),
  maxContactsPerCompany: integer("max_contacts_per_company").default(3).notNull(),
  /** Stagger intro emails for 2nd/3rd contact at a company (days). */
  introStaggerDays: integer("intro_stagger_days").default(1).notNull(),
  workEmailPreferred: boolean("work_email_preferred").default(true).notNull(),
  sendWindowStartHour: integer("send_window_start_hour").default(9).notNull(),
  sendWindowEndHour: integer("send_window_end_hour").default(22).notNull(),
  /**
   * Testing-window override. While `testingWindowUntil` is in the future the
   * hours below replace the production window; once it lapses the production
   * window resumes with no further action. Null = off. See send-window.ts.
   */
  testingWindowUntil: timestamp("testing_window_until"),
  testingWindowStartHour: integer("testing_window_start_hour"),
  testingWindowEndHour: integer("testing_window_end_hour"),
  /** CAN-SPAM: physical mailing address appended to every email. */
  physicalAddress: text("physical_address"),
  /** Reply-To for outreach sends; the IMAP poll watches this mailbox. */
  replyToAddress: text("reply_to_address"),
  /** Per-intent email notification toggles ({"positive": true, ...}). */
  notifyIntents: jsonb("notify_intents")
    .$type<Record<string, boolean>>()
    .default({}),
  /** Whitelist for simulation/test sends (never counts against caps). */
  testRecipients: jsonb("test_recipients").$type<string[]>().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
export type CompanyReviewStatus =
  (typeof companyReviewStatusEnum.enumValues)[number];
export type CompanyDiscoveryRun = typeof companyDiscoveryRuns.$inferSelect;
export type LeadSource = (typeof leadSourceEnum.enumValues)[number];
export type StoredPhoneClassification =
  (typeof phoneClassificationEnum.enumValues)[number];

export type ConsentRecord = typeof consentRecords.$inferSelect;
export type NewConsentRecord = typeof consentRecords.$inferInsert;
export type ConsentChannelScope =
  (typeof consentChannelScopeEnum.enumValues)[number];
export type ConsentSource = (typeof consentSourceEnum.enumValues)[number];
export type CallOutcomeRow = typeof callOutcomes.$inferSelect;
export type CallOutcomeKind = (typeof callOutcomeEnum.enumValues)[number];
export type OptInLinkSend = typeof optInLinkSends.$inferSelect;

export type OutreachTemplate = typeof outreachTemplates.$inferSelect;
export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect;
export type OutreachMessage = typeof outreachMessages.$inferSelect;
export type InboundMessage = typeof inboundMessages.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;
export type EnrollmentEvent = typeof enrollmentEvents.$inferSelect;
export type OutreachNotification = typeof outreachNotifications.$inferSelect;
export type OutreachFlow = typeof outreachFlows.$inferSelect;
export type OutreachFlowVersion = typeof outreachFlowVersions.$inferSelect;
export type SendingProfile = typeof sendingProfiles.$inferSelect;
export type OutreachSettings = typeof outreachSettings.$inferSelect;
export type OutreachChannel = (typeof outreachChannelEnum.enumValues)[number];
export type OutreachTemplateKind =
  (typeof outreachTemplateKindEnum.enumValues)[number];
export type EnrollmentStatus = (typeof enrollmentStatusEnum.enumValues)[number];
export type OutreachMessageStatus =
  (typeof outreachMessageStatusEnum.enumValues)[number];
export type InboundIntent = (typeof inboundIntentEnum.enumValues)[number];
export type SendingProfileStatus =
  (typeof sendingProfileStatusEnum.enumValues)[number];
