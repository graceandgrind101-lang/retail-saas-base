CREATE TYPE "platform"."setting_state" AS ENUM('editable', 'locked', 'hidden');--> statement-breakpoint
CREATE TABLE "platform"."setting_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"key" text NOT NULL,
	"state" "platform"."setting_state" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_policies_tenant_key_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","key"),
	CONSTRAINT "setting_policies_key_format" CHECK ("platform"."setting_policies"."key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint
CREATE TABLE "platform"."tenant_modules" (
	"tenant_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_modules_tenant_id_module_key_pk" PRIMARY KEY("tenant_id","module_key"),
	CONSTRAINT "tenant_modules_key_format" CHECK ("platform"."tenant_modules"."module_key" ~ '^[a-z][a-z_]*$')
);
--> statement-breakpoint
CREATE TABLE "app"."branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"name" jsonb NOT NULL,
	"address" text,
	"phone" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "branches_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "branches_name_not_empty" CHECK (jsonb_typeof("app"."branches"."name") = 'object' AND "app"."branches"."name" <> '{}'::jsonb),
	CONSTRAINT "branches_default_not_archived" CHECK (NOT ("app"."branches"."is_default" AND "app"."branches"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "platform"."setting_policies" ADD CONSTRAINT "setting_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branches_one_default_per_tenant" ON "app"."branches" USING btree ("tenant_id") WHERE "app"."branches"."is_default";