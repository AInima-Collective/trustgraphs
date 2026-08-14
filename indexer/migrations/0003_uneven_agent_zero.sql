ALTER TABLE "offchain"."contribution_round" ADD COLUMN "programId" text;--> statement-breakpoint
ALTER TABLE "offchain"."contribution_round" ADD COLUMN "outputDomain" text;--> statement-breakpoint
ALTER TABLE "offchain"."contribution_round" ADD COLUMN "programProvenance" jsonb;--> statement-breakpoint
ALTER TABLE "offchain"."contribution_score" ADD COLUMN "programId" text;--> statement-breakpoint
ALTER TABLE "offchain"."contribution_score" ADD COLUMN "outputDomain" text;--> statement-breakpoint
ALTER TABLE "offchain"."contribution_valuation_audit" ADD COLUMN "programId" text;--> statement-breakpoint
ALTER TABLE "offchain"."contribution_valuation_audit" ADD COLUMN "outputDomain" text;--> statement-breakpoint
ALTER TABLE "offchain"."hypercerts_metadata" ADD COLUMN "programId" text;--> statement-breakpoint
ALTER TABLE "offchain"."hypercerts_metadata" ADD COLUMN "outputDomain" text;--> statement-breakpoint
ALTER TABLE "offchain"."hypercerts_metadata" ADD COLUMN "programProvenance" jsonb;--> statement-breakpoint
ALTER TABLE "offchain"."hypercerts_score" ADD COLUMN "programId" text;--> statement-breakpoint
ALTER TABLE "offchain"."hypercerts_score" ADD COLUMN "outputDomain" text;--> statement-breakpoint
ALTER TABLE "offchain"."merkle_entry" ADD COLUMN "programId" text;--> statement-breakpoint
ALTER TABLE "offchain"."merkle_entry" ADD COLUMN "outputDomain" text;--> statement-breakpoint
ALTER TABLE "offchain"."merkle_metadata" ADD COLUMN "programId" text;--> statement-breakpoint
ALTER TABLE "offchain"."merkle_metadata" ADD COLUMN "outputDomain" text;--> statement-breakpoint
ALTER TABLE "offchain"."merkle_metadata" ADD COLUMN "programProvenance" jsonb;