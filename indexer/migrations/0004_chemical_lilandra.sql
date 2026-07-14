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
	"boundAddress" text,
	"proof" jsonb,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "hypercerts_score_merkleSnapshotContract_root_nodeId_pk" PRIMARY KEY("merkleSnapshotContract","root","nodeId")
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
CREATE INDEX "hypercerts_metadata_root_index" ON "offchain"."hypercerts_metadata" USING btree ("root");--> statement-breakpoint
CREATE INDEX "hypercerts_metadata_ipfsHashCid_index" ON "offchain"."hypercerts_metadata" USING btree ("ipfsHashCid");--> statement-breakpoint
CREATE INDEX "hypercerts_metadata_timestamp_index" ON "offchain"."hypercerts_metadata" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "hypercerts_score_root_index" ON "offchain"."hypercerts_score" USING btree ("root");--> statement-breakpoint
CREATE INDEX "hypercerts_score_nodeId_index" ON "offchain"."hypercerts_score" USING btree ("nodeId");--> statement-breakpoint
CREATE INDEX "hypercerts_score_boundAddress_index" ON "offchain"."hypercerts_score" USING btree ("boundAddress");--> statement-breakpoint
CREATE INDEX "hypercerts_score_timestamp_index" ON "offchain"."hypercerts_score" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "skipped_node_checkpointId_index" ON "offchain"."skipped_node" USING btree ("checkpointId");--> statement-breakpoint
CREATE INDEX "skipped_node_nodeId_index" ON "offchain"."skipped_node" USING btree ("nodeId");--> statement-breakpoint
CREATE INDEX "skipped_node_reason_index" ON "offchain"."skipped_node" USING btree ("reason");