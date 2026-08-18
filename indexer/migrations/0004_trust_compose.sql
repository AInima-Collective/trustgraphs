CREATE TABLE "offchain"."composition_attribution" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"checkpointId" bigint NOT NULL,
	"sourceId" text NOT NULL,
	"account" text NOT NULL,
	"exactValue" numeric(78, 0) NOT NULL,
	"idealNumerator" text NOT NULL,
	"idealDenominator" text NOT NULL,
	"roundingDeltaNumerator" text NOT NULL,
	CONSTRAINT "composition_attribution_merkleSnapshotContract_checkpointId_sourceId_account_pk" PRIMARY KEY("merkleSnapshotContract","checkpointId","sourceId","account")
);
--> statement-breakpoint
CREATE TABLE "offchain"."composition_epoch" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"instanceId" text NOT NULL,
	"checkpointId" bigint NOT NULL,
	"policyVersion" bigint NOT NULL,
	"paramsHash" text NOT NULL,
	"captureManifestSha256" text NOT NULL,
	"outputBlobSha256" text NOT NULL,
	"outputCid" text NOT NULL,
	"totalValue" numeric(78, 0) NOT NULL,
	"work" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"cryptographicProvenance" jsonb NOT NULL,
	"governanceProvenance" jsonb NOT NULL,
	"verifiedAt" bigint NOT NULL,
	"blockNumber" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "composition_epoch_merkleSnapshotContract_checkpointId_pk" PRIMARY KEY("merkleSnapshotContract","checkpointId")
);
--> statement-breakpoint
CREATE TABLE "offchain"."composition_source" (
	"merkleSnapshotContract" text NOT NULL,
	"root" text NOT NULL,
	"checkpointId" bigint NOT NULL,
	"sourceId" text NOT NULL,
	"position" integer NOT NULL,
	"snapshot" text NOT NULL,
	"familyId" text NOT NULL,
	"programId" text NOT NULL,
	"adapter" text NOT NULL,
	"deploymentProvenance" text NOT NULL,
	"stateIndex" bigint NOT NULL,
	"sourceCheckpointId" bigint NOT NULL,
	"freezeBlock" bigint NOT NULL,
	"outputRoot" text NOT NULL,
	"blobSha256" text NOT NULL,
	"cid" text NOT NULL,
	"totalValue" numeric(78, 0) NOT NULL,
	"weight" bigint NOT NULL,
	"maxAgeBlocks" bigint NOT NULL,
	"quota" numeric(78, 0) NOT NULL,
	"entryCount" integer NOT NULL,
	"blobBytes" integer NOT NULL,
	"cryptographicallyBound" boolean NOT NULL,
	"governanceAdmitted" boolean NOT NULL,
	CONSTRAINT "composition_source_merkleSnapshotContract_checkpointId_sourceId_pk" PRIMARY KEY("merkleSnapshotContract","checkpointId","sourceId")
);
--> statement-breakpoint
CREATE INDEX "composition_attribution_merkleSnapshotContract_checkpointId_account_index" ON "offchain"."composition_attribution" USING btree ("merkleSnapshotContract","checkpointId","account");--> statement-breakpoint
CREATE INDEX "composition_attribution_root_index" ON "offchain"."composition_attribution" USING btree ("root");--> statement-breakpoint
CREATE INDEX "composition_attribution_sourceId_account_index" ON "offchain"."composition_attribution" USING btree ("sourceId","account");--> statement-breakpoint
CREATE INDEX "composition_epoch_instanceId_checkpointId_index" ON "offchain"."composition_epoch" USING btree ("instanceId","checkpointId");--> statement-breakpoint
CREATE INDEX "composition_epoch_merkleSnapshotContract_root_index" ON "offchain"."composition_epoch" USING btree ("merkleSnapshotContract","root");--> statement-breakpoint
CREATE INDEX "composition_epoch_paramsHash_index" ON "offchain"."composition_epoch" USING btree ("paramsHash");--> statement-breakpoint
CREATE INDEX "composition_epoch_timestamp_index" ON "offchain"."composition_epoch" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "composition_source_merkleSnapshotContract_checkpointId_position_index" ON "offchain"."composition_source" USING btree ("merkleSnapshotContract","checkpointId","position");--> statement-breakpoint
CREATE INDEX "composition_source_root_index" ON "offchain"."composition_source" USING btree ("root");--> statement-breakpoint
CREATE INDEX "composition_source_snapshot_stateIndex_index" ON "offchain"."composition_source" USING btree ("snapshot","stateIndex");--> statement-breakpoint
CREATE INDEX "composition_source_familyId_index" ON "offchain"."composition_source" USING btree ("familyId");