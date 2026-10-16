CREATE TABLE "app"."tenant_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "tenant_settings_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_settings_tenant_key_unique" UNIQUE("tenant_id","key"),
	CONSTRAINT "tenant_settings_key_format" CHECK ("app"."tenant_settings"."key" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
	CONSTRAINT "tenant_settings_value_not_null" CHECK ("app"."tenant_settings"."value" <> 'null'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "app"."tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tenant_settings" ADD CONSTRAINT "tenant_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;