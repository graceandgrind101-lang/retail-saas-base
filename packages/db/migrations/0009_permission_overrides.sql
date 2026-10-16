CREATE TABLE "app"."staff_permission_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"staff_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"effect" text NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid NOT NULL,
	CONSTRAINT "staff_permission_overrides_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_permission_overrides_unique" UNIQUE("tenant_id","staff_id","permission_key"),
	CONSTRAINT "staff_permission_overrides_key_format" CHECK ("app"."staff_permission_overrides"."permission_key" ~ '^[a-z][a-z_]*:[a-z][a-z_]*$'),
	CONSTRAINT "staff_permission_overrides_effect" CHECK ("app"."staff_permission_overrides"."effect" IN ('allow', 'deny')),
	CONSTRAINT "staff_permission_overrides_reason" CHECK (btrim("app"."staff_permission_overrides"."reason") <> '')
);
--> statement-breakpoint
ALTER TABLE "app"."staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_granted_by_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;