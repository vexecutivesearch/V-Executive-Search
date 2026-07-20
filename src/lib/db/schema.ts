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
  // Performance counters (phase 6 rollups read these).
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
  dailySendCap: integer("daily_send_cap").default(50).notNull(),
  /** Auto-enroll on call-list add (+ enrich ingest). Manual enroll always available. */
  autoEnroll: boolean("auto_enroll").default(true).notNull(),
  maxContactsPerCompany: integer("max_contacts_per_company").default(3).notNull(),
  /** Stagger intro emails for 2nd/3rd contact at a company (days). */
  introStaggerDays: integer("intro_stagger_days").default(1).notNull(),
  workEmailPreferred: boolean("work_email_preferred").default(true).notNull(),
  sendWindowStartHour: integer("send_window_start_hour").default(9).notNull(),
  sendWindowEndHour: integer("send_window_end_hour").default(17).notNull(),
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
