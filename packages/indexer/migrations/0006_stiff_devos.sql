CREATE TABLE "offchain"."score_blob_ingestion" (
	"id" text PRIMARY KEY NOT NULL,
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"ipfsHash" text NOT NULL,
	"ipfsHashCid" text NOT NULL,
	"totalValue" numeric(78, 0) NOT NULL,
	"blockNumber" bigint NOT NULL,
	"logIndex" integer NOT NULL,
	"timestamp" bigint NOT NULL,
	"transactionHash" text NOT NULL,
	"transactionInput" text NOT NULL,
	"programProvenance" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"nextAttemptBlock" bigint,
	"lastAttemptBlock" bigint,
	"lastError" text
);
--> statement-breakpoint
CREATE INDEX "score_blob_ingestion_status_nextAttemptBlock_index" ON "offchain"."score_blob_ingestion" USING btree ("status","nextAttemptBlock");--> statement-breakpoint
CREATE INDEX "score_blob_ingestion_merkleSnapshotContract_blockNumber_logIndex_index" ON "offchain"."score_blob_ingestion" USING btree ("merkleSnapshotContract","blockNumber","logIndex");--> statement-breakpoint
CREATE INDEX "score_blob_ingestion_ipfsHashCid_index" ON "offchain"."score_blob_ingestion" USING btree ("ipfsHashCid");