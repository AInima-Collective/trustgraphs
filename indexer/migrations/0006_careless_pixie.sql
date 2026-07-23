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
	"roundStart" bigint,
	"roundEnd" bigint,
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
CREATE INDEX "contribution_round_root_index" ON "offchain"."contribution_round" USING btree ("root");--> statement-breakpoint
CREATE INDEX "contribution_round_ipfsHashCid_index" ON "offchain"."contribution_round" USING btree ("ipfsHashCid");--> statement-breakpoint
CREATE INDEX "contribution_round_timestamp_index" ON "offchain"."contribution_round" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "contribution_score_root_index" ON "offchain"."contribution_score" USING btree ("root");--> statement-breakpoint
CREATE INDEX "contribution_score_claimUid_index" ON "offchain"."contribution_score" USING btree ("claimUid");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_root_index" ON "offchain"."contribution_valuation_audit" USING btree ("root");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_claimUid_index" ON "offchain"."contribution_valuation_audit" USING btree ("claimUid");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_rater_index" ON "offchain"."contribution_valuation_audit" USING btree ("rater");--> statement-breakpoint
CREATE INDEX "contribution_valuation_audit_status_index" ON "offchain"."contribution_valuation_audit" USING btree ("status");