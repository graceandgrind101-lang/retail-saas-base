CREATE TYPE "app"."staff_status" AS ENUM('invited', 'active', 'suspended', 'archived');--> statement-breakpoint
CREATE TABLE "app"."role_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "role_permissions_unique" UNIQUE("tenant_id","role_id","permission_key"),
	CONSTRAINT "role_permissions_key_format" CHECK ("app"."role_permissions"."permission_key" ~ '^[a-z][a-z_]*:[a-z][a-z_]*$')
);
--> statement-breakpoint
CREATE TABLE "app"."roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"template_key" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "roles_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "roles_tenant_key_unique" UNIQUE("tenant_id","key"),
	CONSTRAINT "roles_key_format" CHECK ("app"."roles"."key" ~ '^[a-z][a-z_]*$'),
	CONSTRAINT "roles_name_not_empty" CHECK (jsonb_typeof("app"."roles"."name") = 'object' AND "app"."roles"."name" <> '{}'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "app"."staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"auth_user_id" uuid,
	"display_name" text NOT NULL,
	"phone" text,
	"role_id" uuid NOT NULL,
	"branch_ids" uuid[],
	"pin_hash" text,
	"pin_set_at" timestamp with time zone,
	"pin_failed_count" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"status" "app"."staff_status" DEFAULT 'invited' NOT NULL,
	"preferred_language" text,
	"preferred_calendar" text,
	"theme" text,
	"invite_email" text,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	CONSTRAINT "staff_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_display_name_not_empty" CHECK (btrim("app"."staff"."display_name") <> ''),
	CONSTRAINT "staff_invite_complete" CHECK ("app"."staff"."status" <> 'invited' OR ("app"."staff"."invite_token_hash" IS NOT NULL AND "app"."staff"."invite_email" IS NOT NULL AND "app"."staff"."invite_expires_at" IS NOT NULL AND "app"."staff"."auth_user_id" IS NULL)),
	CONSTRAINT "staff_no_stale_invite" CHECK ("app"."staff"."status" = 'invited' OR "app"."staff"."invite_token_hash" IS NULL),
	CONSTRAINT "staff_invite_email_lowercase" CHECK ("app"."staff"."invite_email" IS NULL OR "app"."staff"."invite_email" = lower("app"."staff"."invite_email")),
	CONSTRAINT "staff_pin_failed_count" CHECK ("app"."staff"."pin_failed_count" >= 0),
	CONSTRAINT "staff_calendar" CHECK ("app"."staff"."preferred_calendar" IS NULL OR "app"."staff"."preferred_calendar" IN ('gregorian', 'ethiopian')),
	CONSTRAINT "staff_theme" CHECK ("app"."staff"."theme" IS NULL OR "app"."staff"."theme" IN ('system', 'light', 'dark'))
);
--> statement-breakpoint
CREATE TABLE "app"."staff_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"staff_id" uuid NOT NULL,
	"device_id" uuid,
	"method" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "staff_sessions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_sessions_method" CHECK ("app"."staff_sessions"."method" IN ('pin', 'password', 'google', 'telegram')),
	CONSTRAINT "staff_sessions_ended_reason" CHECK ("app"."staff_sessions"."ended_reason" IS NULL OR "app"."staff_sessions"."ended_reason" IN ('logout', 'expired', 'revoked', 'staff_suspended', 'device_revoked')),
	CONSTRAINT "staff_sessions_ended_consistent" CHECK (("app"."staff_sessions"."ended_at" IS NULL) = ("app"."staff_sessions"."ended_reason" IS NULL)),
	CONSTRAINT "staff_sessions_expiry_after_start" CHECK ("app"."staff_sessions"."expires_at" > "app"."staff_sessions"."started_at")
);
--> statement-breakpoint
ALTER TABLE "app"."role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "app"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff" ADD CONSTRAINT "staff_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff" ADD CONSTRAINT "staff_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "app"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_tenant_auth_user_unique" ON "app"."staff" USING btree ("tenant_id","auth_user_id") WHERE "app"."staff"."auth_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invite_token_unique" ON "app"."staff" USING btree ("invite_token_hash") WHERE "app"."staff"."invite_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "staff_sessions_open_idx" ON "app"."staff_sessions" USING btree ("tenant_id","staff_id") WHERE "app"."staff_sessions"."ended_at" IS NULL;