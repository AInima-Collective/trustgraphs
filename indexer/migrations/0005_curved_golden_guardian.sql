CREATE TABLE "offchain"."nostr_workspace_metadata" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"checkpointId" bigint NOT NULL,
	"ipfsHash" text NOT NULL,
	"ipfsHashCid" text NOT NULL,
	"numNodes" integer NOT NULL,
	"totalValue" numeric(78, 0) NOT NULL,
	"skippedDigest" text NOT NULL,
	"anchorAcc" text NOT NULL,
	"anchorCount" bigint NOT NULL,
	"accessPolicy" text NOT NULL,
	"epochTrustClass" text NOT NULL,
	"reducedRecomputeStatus" text NOT NULL,
	"skipSummary" jsonb NOT NULL,
	"archiveProvenance" jsonb NOT NULL,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	"programId" text NOT NULL,
	"outputDomain" text NOT NULL,
	"programProvenance" jsonb NOT NULL,
	CONSTRAINT "nostr_workspace_metadata_merkleSnapshotContract_root_pk" PRIMARY KEY("merkleSnapshotContract","root")
);
--> statement-breakpoint
CREATE TABLE "offchain"."nostr_workspace_score" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"nodeId" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"nostrPubkey" text,
	"actorKind" text NOT NULL,
	"ownerNodeId" text,
	"boundAddress" text,
	"proof" jsonb NOT NULL,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	"programId" text NOT NULL,
	"outputDomain" text NOT NULL,
	CONSTRAINT "nostr_workspace_score_merkleSnapshotContract_root_nodeId_pk" PRIMARY KEY("merkleSnapshotContract","root","nodeId")
);
--> statement-breakpoint
CREATE INDEX "nostr_workspace_metadata_checkpointId_index" ON "offchain"."nostr_workspace_metadata" USING btree ("checkpointId");--> statement-breakpoint
CREATE INDEX "nostr_workspace_metadata_ipfsHashCid_index" ON "offchain"."nostr_workspace_metadata" USING btree ("ipfsHashCid");--> statement-breakpoint
CREATE INDEX "nostr_workspace_metadata_accessPolicy_index" ON "offchain"."nostr_workspace_metadata" USING btree ("accessPolicy");--> statement-breakpoint
CREATE INDEX "nostr_workspace_metadata_timestamp_index" ON "offchain"."nostr_workspace_metadata" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "nostr_workspace_score_nodeId_index" ON "offchain"."nostr_workspace_score" USING btree ("nodeId");--> statement-breakpoint
CREATE INDEX "nostr_workspace_score_ownerNodeId_index" ON "offchain"."nostr_workspace_score" USING btree ("ownerNodeId");--> statement-breakpoint
CREATE INDEX "nostr_workspace_score_boundAddress_index" ON "offchain"."nostr_workspace_score" USING btree ("boundAddress");--> statement-breakpoint
CREATE INDEX "nostr_workspace_score_actorKind_index" ON "offchain"."nostr_workspace_score" USING btree ("actorKind");--> statement-breakpoint
CREATE INDEX "nostr_workspace_score_timestamp_index" ON "offchain"."nostr_workspace_score" USING btree ("timestamp");