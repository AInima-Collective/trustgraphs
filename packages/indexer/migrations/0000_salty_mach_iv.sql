CREATE SCHEMA "offchain";
--> statement-breakpoint
CREATE TABLE "offchain"."contribution_round" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"checkpointId" text NOT NULL,
	"ipfsHash" text NOT NULL,
	"ipfsHashCid" text NOT NULL,
	"trustAcc" text NOT NULL,
	"trustLeafCount" bigint NOT NULL,
	"anchorAcc" text NOT NULL,
	"anchorCount" bigint NOT NULL,
	"paramsHash" text NOT NULL,
	"params" jsonb,
	"roundStart" numeric(78, 0),
	"roundEnd" numeric(78, 0),
	"totalPool" numeric(78, 0),
	"totalValue" numeric(78, 0) NOT NULL,
	"numClaims" integer NOT NULL,
	"numRecipients" integer NOT NULL,
	"verified" boolean NOT NULL,
	"failureReason" text,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "contribution_round_merkleSnapshotContract_root_pk" PRIMARY KEY("merkleSnapshotContract","root")
);
--> statement-breakpoint
CREATE TABLE "offchain"."contribution_score" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"claimUid" text NOT NULL,
	"scoreFp" numeric(78, 0) NOT NULL,
	"contributors" jsonb NOT NULL,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "contribution_score_merkleSnapshotContract_root_claimUid_pk" PRIMARY KEY("merkleSnapshotContract","root","claimUid")
);
--> statement-breakpoint
CREATE TABLE "offchain"."contribution_valuation_audit" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"claimUid" text NOT NULL,
	"rater" text NOT NULL,
	"score" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"discountFp" numeric(78, 0),
	"raterRepFp" numeric(78, 0) NOT NULL,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "contribution_valuation_audit_merkleSnapshotContract_root_claimUid_rater_pk" PRIMARY KEY("merkleSnapshotContract","root","claimUid","rater")
);
--> statement-breakpoint
CREATE TABLE "offchain"."hypercerts_metadata" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"ipfsHash" text NOT NULL,
	"ipfsHashCid" text NOT NULL,
	"numNodes" integer NOT NULL,
	"totalValue" numeric(78, 0) NOT NULL,
	"skippedDigest" text NOT NULL,
	"anchorAcc" text NOT NULL,
	"anchorCount" bigint NOT NULL,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "hypercerts_metadata_merkleSnapshotContract_root_pk" PRIMARY KEY("merkleSnapshotContract","root")
);
--> statement-breakpoint
CREATE TABLE "offchain"."hypercerts_score" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"nodeId" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"did" text,
	"boundAddress" text,
	"proof" jsonb,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "hypercerts_score_merkleSnapshotContract_root_nodeId_pk" PRIMARY KEY("merkleSnapshotContract","root","nodeId")
);
--> statement-breakpoint
CREATE TABLE "offchain"."merkle_entry" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"account" text NOT NULL,
	"ipfsHashCid" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"proof" jsonb NOT NULL,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "merkle_entry_merkleSnapshotContract_root_account_pk" PRIMARY KEY("merkleSnapshotContract","root","account")
);
--> statement-breakpoint
CREATE TABLE "offchain"."merkle_metadata" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"ipfsHash" text NOT NULL,
	"ipfsHashCid" text NOT NULL,
	"numAccounts" integer NOT NULL,
	"totalValue" numeric(78, 0) NOT NULL,
	"sources" jsonb NOT NULL,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "merkle_metadata_merkleSnapshotContract_root_pk" PRIMARY KEY("merkleSnapshotContract","root")
);
--> statement-breakpoint
CREATE TABLE "offchain"."skipped_node" (
	"checkpointId" text NOT NULL,
	"nodeId" text NOT NULL,
	"reason" text NOT NULL,
	"epochObserved" bigint NOT NULL,
	"validated" boolean,
	"updatedAt" bigint NOT NULL,
	CONSTRAINT "skipped_node_checkpointId_nodeId_pk" PRIMARY KEY("checkpointId","nodeId")
);
--> statement-breakpoint
CREATE INDEX "contribution_round_root_index" ON "offchain"."contribution_round" USING btree ("root");--> statement-breakpoint
CREATE INDEX "contribution_round_ipfsHashCid_index" ON "offchain"."contribution_round" USING btree ("ipfsHashCid");--> statement-breakpoint
CREATE INDEX "contribution_round_timestamp_index" ON "offchain"."contribution_round" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "contribution_score_root_index" ON "offchain"."contribution_score" USING btree ("root");--> statement-breakpoint
CREATE INDEX "contribution_score_claimUid_index" ON "offchain"."contribution_score" USING btree ("claimUid");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_root_index" ON "offchain"."contribution_valuation_audit" USING btree ("root");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_claimUid_index" ON "offchain"."contribution_valuation_audit" USING btree ("claimUid");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_rater_index" ON "offchain"."contribution_valuation_audit" USING btree ("rater");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_status_index" ON "offchain"."contribution_valuation_audit" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hypercerts_metadata_root_index" ON "offchain"."hypercerts_metadata" USING btree ("root");--> statement-breakpoint
CREATE INDEX "hypercerts_metadata_ipfsHashCid_index" ON "offchain"."hypercerts_metadata" USING btree ("ipfsHashCid");--> statement-breakpoint
CREATE INDEX "hypercerts_metadata_timestamp_index" ON "offchain"."hypercerts_metadata" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "hypercerts_score_root_index" ON "offchain"."hypercerts_score" USING btree ("root");--> statement-breakpoint
CREATE INDEX "hypercerts_score_nodeId_index" ON "offchain"."hypercerts_score" USING btree ("nodeId");--> statement-breakpoint
CREATE INDEX "hypercerts_score_boundAddress_index" ON "offchain"."hypercerts_score" USING btree ("boundAddress");--> statement-breakpoint
CREATE INDEX "hypercerts_score_timestamp_index" ON "offchain"."hypercerts_score" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "merkle_entry_root_index" ON "offchain"."merkle_entry" USING btree ("root");--> statement-breakpoint
CREATE INDEX "merkle_entry_account_index" ON "offchain"."merkle_entry" USING btree ("account");--> statement-breakpoint
CREATE INDEX "merkle_entry_ipfsHashCid_index" ON "offchain"."merkle_entry" USING btree ("ipfsHashCid");--> statement-breakpoint
CREATE INDEX "merkle_entry_blockNumber_index" ON "offchain"."merkle_entry" USING btree ("blockNumber");--> statement-breakpoint
CREATE INDEX "merkle_entry_timestamp_index" ON "offchain"."merkle_entry" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "merkle_entry_account_timestamp_index" ON "offchain"."merkle_entry" USING btree ("account","timestamp");--> statement-breakpoint
CREATE INDEX "merkle_metadata_root_index" ON "offchain"."merkle_metadata" USING btree ("root");--> statement-breakpoint
CREATE INDEX "merkle_metadata_ipfsHashCid_index" ON "offchain"."merkle_metadata" USING btree ("ipfsHashCid");--> statement-breakpoint
CREATE INDEX "merkle_metadata_blockNumber_index" ON "offchain"."merkle_metadata" USING btree ("blockNumber");--> statement-breakpoint
CREATE INDEX "merkle_metadata_timestamp_index" ON "offchain"."merkle_metadata" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "skipped_node_checkpointId_index" ON "offchain"."skipped_node" USING btree ("checkpointId");--> statement-breakpoint
CREATE INDEX "skipped_node_nodeId_index" ON "offchain"."skipped_node" USING btree ("nodeId");--> statement-breakpoint
CREATE INDEX "skipped_node_reason_index" ON "offchain"."skipped_node" USING btree ("reason");