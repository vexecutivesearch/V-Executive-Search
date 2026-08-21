CREATE TYPE "public"."lead_source" AS ENUM('cold_discovery', 'inbound_form', 'inbound_meta');--> statement-breakpoint
CREATE TYPE "public"."phone_classification" AS ENUM('business_line', 'mobile', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."consent_channel_scope" AS ENUM('email', 'sms', 'both');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('web_form', 'meta_lead_ad', 'inbound_written_request');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('placed', 'connected', 'no_answer', 'voicemail', 'gatekeeper', 'wrong_number');--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"email" text,
	"phone" text,
	"channel_scope" "consent_channel_scope" NOT NULL,
	"disclosure_text" text NOT NULL,
	"source" "consent_source" NOT NULL,
	"source_identifier" text,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"revoked_at" timestamp,
	"revoked_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"call_list_entry_id" uuid,
	"contact_id" uuid,
	"outcome" "call_outcome" NOT NULL,
	"phone" text,
	"phone_classification" "phone_classification",
	"notes" text,
	"logged_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opt_in_link_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"call_outcome_id" uuid,
	"email" text NOT NULL,
	"form_url" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"sent_by" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_call_list_entry_id_call_list_entries_id_fk" FOREIGN KEY ("call_list_entry_id") REFERENCES "public"."call_list_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_in_link_sends" ADD CONSTRAINT "opt_in_link_sends_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_in_link_sends" ADD CONSTRAINT "opt_in_link_sends_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_in_link_sends" ADD CONSTRAINT "opt_in_link_sends_call_outcome_id_call_outcomes_id_fk" FOREIGN KEY ("call_outcome_id") REFERENCES "public"."call_outcomes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "phone_classification" "phone_classification" DEFAULT 'business_line' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "lead_source" "lead_source" DEFAULT 'cold_discovery' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone_classification" "phone_classification" DEFAULT 'mobile' NOT NULL;
