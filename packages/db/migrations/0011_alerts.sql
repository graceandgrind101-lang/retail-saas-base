CREATE TABLE "app"."alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"branch_id" uuid,
	"category" text NOT NULL,
	"rule_key" text NOT NULL,
	"severity" smallint NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"assignee_staff_id" uuid,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "alerts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "alerts_category" CHECK ("app"."alerts"."category" IN ('fraud', 'suspicion', 'error', 'alert', 'message', 'info')),
	CONSTRAINT "alerts_status" CHECK ("app"."alerts"."status" IN ('new', 'ack', 'resolved', 'dismissed')),
	CONSTRAINT "alerts_severity" CHECK ("app"."alerts"."severity" BETWEEN 1 AND 5),
	CONSTRAINT "alerts_rule_key_format" CHECK ("app"."alerts"."rule_key" ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
	CONSTRAINT "alerts_payload_is_object" CHECK (jsonb_typeof("app"."alerts"."payload") = 'object'),
	CONSTRAINT "alerts_entity_pair" CHECK (("app"."alerts"."entity_type" IS NULL) = ("app"."alerts"."entity_id" IS NULL)),
	CONSTRAINT "alerts_closed_consistent" CHECK (("app"."alerts"."status" IN ('resolved', 'dismissed')) = ("app"."alerts"."resolved_at" IS NOT NULL AND "app"."alerts"."resolved_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "app"."alerts" ADD CONSTRAINT "alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alerts" ADD CONSTRAINT "alerts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "app"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alerts" ADD CONSTRAINT "alerts_assignee_fk" FOREIGN KEY ("tenant_id","assignee_staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alerts" ADD CONSTRAINT "alerts_resolved_by_fk" FOREIGN KEY ("tenant_id","resolved_by") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_list_idx" ON "app"."alerts" USING btree ("tenant_id","status","category","created_at" DESC NULLS LAST);