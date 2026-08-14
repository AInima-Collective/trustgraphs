CREATE TABLE "offchain"."erc8004_reputation_document" (
	"id" text PRIMARY KEY NOT NULL,
	"subjectId" text NOT NULL,
	"feedbackId" text NOT NULL,
	"kind" text NOT NULL,
	"uri" text NOT NULL,
	"finalUri" text,
	"expectedHash" text NOT NULL,
	"contentHash" text,
	"hashStatus" text NOT NULL,
	"parsedJson" jsonb,
	"fetchedAt" bigint NOT NULL,
	"fetchStatus" text NOT NULL,
	"error" text,
	"httpStatus" integer,
	"contentType" text,
	"byteLength" integer,
	"mutable" boolean NOT NULL,
	"sourceBlock" bigint NOT NULL,
	"sourceTransactionIndex" integer NOT NULL,
	"sourceLogIndex" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "erc8004_reputation_document_subjectId_fetchedAt_index" ON "offchain"."erc8004_reputation_document" USING btree ("subjectId","fetchedAt");--> statement-breakpoint
CREATE INDEX "erc8004_reputation_document_feedbackId_kind_index" ON "offchain"."erc8004_reputation_document" USING btree ("feedbackId","kind");--> statement-breakpoint
CREATE INDEX "erc8004_reputation_document_fetchStatus_index" ON "offchain"."erc8004_reputation_document" USING btree ("fetchStatus");--> statement-breakpoint
CREATE INDEX "erc8004_reputation_document_hashStatus_index" ON "offchain"."erc8004_reputation_document" USING btree ("hashStatus");