// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {console} from "forge-std/console.sol";

import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {ParamsJson} from "script/lib/ParamsJson.sol";

import {Common} from "script/Common.s.sol";

/// @title CreateGovernedInstanceE2e
/// @notice Harness for `tests/e2e/governed-creation.sh` (indexer M0 regression): creates one
///         governed instance through `GovernedTrustgraphsFactory` exactly the way the wizard
///         does — unpaid policy, signer-sync disabled — so the indexer's behavior on the
///         creation block can be asserted live. Writes the created addresses to
///         `.docker/governed_creation_e2e.json` for the harness to read back.
contract CreateGovernedInstanceE2e is Common {
    function run(string calldata governedFactoryAddr, string calldata paramsPath, string calldata name) public {
        GovernedTrustgraphsFactory governed = GovernedTrustgraphsFactory(vm.parseAddress(governedFactoryAddr));

        // The governance knobs, with every derived (instance-identity) field left at zero — the
        // factory rejects anything else, and fills them itself (CreateDevInstances convention).
        ParamsCodec.Params memory params = ParamsJson.read(paramsPath, bytes32(0), address(0), 0);

        vm.startBroadcast(_privateKey);
        (bytes32 instanceId, address safe, address merkleGovModule, address snapshot) = governed
            .createGovernedInstance(
            TrustgraphsFactory.CreateArgs({
                name: name,
                metadataURI: "",
                params: params,
                admin: address(0), // ignored: the Safe becomes the admin
                epochLength: 1,
                withDistributor: true,
                distributorToken: address(0),
                salt: keccak256(abi.encode(name, block.number, block.timestamp))
            }),
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}),
            GovernedTrustgraphsFactory.SignerSyncConfig({
                enabled: false,
                verifier: address(0),
                programVKey: bytes32(0),
                topN: 0,
                minThreshold: 0,
                targetThresholdBps: 0
            })
        );
        vm.stopBroadcast();

        console.log("governed instance created");
        console.log("  id:      ", vm.toString(instanceId));
        console.log("  safe:    ", safe);
        console.log("  module:  ", merkleGovModule);
        console.log("  snapshot:", snapshot);

        string memory json = "governed_creation_e2e";
        vm.serializeString(json, "instance_id", vm.toString(instanceId));
        vm.serializeAddress(json, "safe", safe);
        vm.serializeAddress(json, "merkle_gov_module", merkleGovModule);
        string memory out = vm.serializeAddress(json, "snapshot", snapshot);
        vm.writeJson(out, ".docker/governed_creation_e2e.json");
    }
}

/// @title SubmitDevRootE2e
/// @notice Triggers a checkpoint on a dev instance and submits a root for it through the REAL
///         `SP1JournalVerifier` over the dev `MockSP1Gateway` (the journal digest is genuinely
///         bound; only the SNARK check is stubbed — the same seam `tests/e2e/run.sh` uses, see
///         research/DEVIATIONS.md #1). The journal is rebuilt here from the same chain state
///         `MerkleSnapshot.submitProof` reads, so the submission is exactly what a prover host
///         would post. Reverts on a non-dev verifier, by construction.
contract SubmitDevRootE2e is Common {
    function run(
        string calldata snapshotAddr,
        bytes32 outputRoot,
        bytes32 ipfsHash,
        string calldata ipfsHashCid,
        uint256 totalValue
    ) public {
        MerkleSnapshot snap = MerkleSnapshot(payable(vm.parseAddress(snapshotAddr)));

        vm.startBroadcast(_privateKey);
        uint256 checkpointId = snap.trigger();

        IAttestationAccumulator.Checkpoint memory c = snap.accumulator().getCheckpoint(checkpointId);
        (bytes32 anchorAcc, uint64 anchorCount) = snap.anchorCheckpoints(checkpointId);
        bytes32 pinnedParamsHash = snap.checkpointParamsHash(checkpointId);
        bytes32 skippedDigest = bytes32(0);
        address recipient = address(0); // no bounty: a dev root, self-proven

        // Journal v3 — field order FROZEN (mirrors MerkleSnapshot.submitProof's digest preimage).
        bytes memory publicValues = abi.encode(
            c.acc,
            c.leafCount,
            anchorAcc,
            anchorCount,
            pinnedParamsHash,
            outputRoot,
            ipfsHash,
            keccak256(bytes(ipfsHashCid)),
            totalValue,
            skippedDigest,
            recipient,
            snap.instanceDomain()
        );
        bytes memory proof = abi.encode(publicValues, bytes(""));

        snap.submitProof(checkpointId, outputRoot, ipfsHash, ipfsHashCid, totalValue, skippedDigest, recipient, proof);
        vm.stopBroadcast();

        console.log("root submitted");
        console.log("  checkpoint:", checkpointId);
        console.log("  root:      ", vm.toString(outputRoot));
    }
}
