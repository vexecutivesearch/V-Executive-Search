CREATE TYPE "public"."company_review_status" AS ENUM('pending', 'approved', 'rejected', 'review_later', 'already_contacted', 'existing_client', 'do_not_contact');--> statement-breakpoint
CREATE TABLE "company_discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vertical" text NOT NULL,
	"market" text NOT NULL,
	"pool" text DEFAULT 'sized' NOT NULL,
	"per_page" integer DEFAULT 25 NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"total_entries" integer,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"pool_exhausted" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp,
	"last_returned" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "vertical" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "review_status" "company_review_status";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "review_status_updated_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "company_discovery_runs_vertical_market_pool_uq" ON "company_discovery_runs" USING btree ("vertical","market","pool");