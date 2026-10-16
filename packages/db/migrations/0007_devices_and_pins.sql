CREATE TABLE "app"."device_pairing_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"branch_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_device_id" uuid,
	CONSTRAINT "device_pairing_codes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "device_pairing_codes_expiry_after_creation" CHECK ("app"."device_pairing_codes"."expires_at" > "app"."device_pairing_codes"."created_at"),
	CONSTRAINT "device_pairing_codes_used_consistent" CHECK (("app"."device_pairing_codes"."used_at" IS NULL) = ("app"."device_pairing_codes"."used_by_device_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"paired_by" uuid NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"pin_failed_count" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	CONSTRAINT "devices_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "devices_name_not_empty" CHECK (btrim("app"."devices"."name") <> ''),
	CONSTRAINT "devices_kind" CHECK ("app"."devices"."kind" IN ('pos', 'phone', 'tablet', 'desktop')),
	CONSTRAINT "devices_revoked_consistent" CHECK (("app"."devices"."revoked_at" IS NULL) = ("app"."devices"."revoked_by" IS NULL)),
	CONSTRAINT "devices_pin_failed_count" CHECK ("app"."devices"."pin_failed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."pin_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"staff_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"device_id" uuid,
	"action_key" text NOT NULL,
	"entity_id" uuid,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "pin_verifications_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "pin_verifications_action_key" CHECK ("app"."pin_verifications"."action_key" ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'),
	CONSTRAINT "pin_verifications_expiry" CHECK ("app"."pin_verifications"."expires_at" > "app"."pin_verifications"."verified_at")
);
--> statement-breakpoint
ALTER TABLE "app"."device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "app"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_device_fk" FOREIGN KEY ("tenant_id","used_by_device_id") REFERENCES "app"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "app"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_paired_by_fk" FOREIGN KEY ("tenant_id","paired_by") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pin_verifications" ADD CONSTRAINT "pin_verifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pin_verifications" ADD CONSTRAINT "pin_verifications_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pin_verifications" ADD CONSTRAINT "pin_verifications_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pin_verifications" ADD CONSTRAINT "pin_verifications_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "app"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairing_codes_hash_unique" ON "app"."device_pairing_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token_hash_unique" ON "app"."devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "devices_branch_idx" ON "app"."devices" USING btree ("tenant_id","branch_id");--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "app"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_sessions_device_open_idx" ON "app"."staff_sessions" USING btree ("tenant_id","device_id") WHERE "app"."staff_sessions"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."staff_sessions" ADD CONSTRAINT "staff_sessions_pin_needs_device" CHECK ("app"."staff_sessions"."method" <> 'pin' OR "app"."staff_sessions"."device_id" IS NOT NULL);