CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "platform"."industry" AS ENUM('electronics', 'minimarket', 'cosmetics', 'food', 'other');--> statement-breakpoint
CREATE TYPE "platform"."tenant_status" AS ENUM('pilot', 'trial', 'active', 'past_due', 'paused', 'closed');--> statement-breakpoint
CREATE TABLE "platform"."tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" jsonb NOT NULL,
	"legal_name" text,
	"tin" text,
	"industry" "platform"."industry" NOT NULL,
	"plan_key" text NOT NULL,
	"status" "platform"."tenant_status" DEFAULT 'pilot' NOT NULL,
	"timezone" text DEFAULT 'Africa/Addis_Ababa' NOT NULL,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_slug_format" CHECK ("platform"."tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
	CONSTRAINT "tenants_slug_not_reserved" CHECK (slug NOT IN ('app', 'console', 'www', 'api', 'admin', 'static', 'assets', 'mail', 'bot', 'verifier', 'status', 'help', 'docs')),
	CONSTRAINT "tenants_display_name_not_empty" CHECK (jsonb_typeof("platform"."tenants"."display_name") = 'object' AND "platform"."tenants"."display_name" <> '{}'::jsonb)
);
