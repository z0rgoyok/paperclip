-- Managed fork: grouping-only project for chat conversations (never read by run
-- workspace/environment resolution). Idempotent so a later upstream migration
-- renumbering cannot apply it twice.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "organization_project_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issues" ADD CONSTRAINT "issues_organization_project_id_projects_id_fk" FOREIGN KEY ("organization_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_organization_project_idx" ON "issues" USING btree ("company_id","organization_project_id");
