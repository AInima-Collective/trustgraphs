CREATE TABLE "offchain"."erc8004_endpoint_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"documentId" text NOT NULL,
	"agentKey" text NOT NULL,
	"serviceName" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"httpStatus" integer,
	"checkedAt" bigint NOT NULL,
	"latencyMs" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "offchain"."erc8004_registration_document" (
	"id" text PRIMARY KEY NOT NULL,
	"agentKey" text NOT NULL,
	"uri" text NOT NULL,
	"finalUri" text,
	"contentHash" text,
	"schemaVersion" text,
	"parsedJson" jsonb,
	"fetchedAt" bigint NOT NULL,
	"fetchStatus" text NOT NULL,
	"error" text,
	"httpStatus" integer,
	"contentType" text,
	"byteLength" integer,
	"mutable" boolean NOT NULL,
	"sourceBlock" bigint NOT NULL,
	"sourceLogIndex" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "erc8004_endpoint_observation_documentId_index" ON "offchain"."erc8004_endpoint_observation" USING btree ("documentId");--> statement-breakpoint
CREATE INDEX "erc8004_endpoint_observation_agentKey_checkedAt_index" ON "offchain"."erc8004_endpoint_observation" USING btree ("agentKey","checkedAt");--> statement-breakpoint
CREATE INDEX "erc8004_endpoint_observation_status_index" ON "offchain"."erc8004_endpoint_observation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "erc8004_registration_document_agentKey_index" ON "offchain"."erc8004_registration_document" USING btree ("agentKey");--> statement-breakpoint
CREATE INDEX "erc8004_registration_document_agentKey_fetchedAt_index" ON "offchain"."erc8004_registration_document" USING btree ("agentKey","fetchedAt");--> statement-breakpoint
CREATE INDEX "erc8004_registration_document_contentHash_index" ON "offchain"."erc8004_registration_document" USING btree ("contentHash");--> statement-breakpoint
CREATE INDEX "erc8004_registration_document_fetchStatus_index" ON "offchain"."erc8004_registration_document" USING btree ("fetchStatus");