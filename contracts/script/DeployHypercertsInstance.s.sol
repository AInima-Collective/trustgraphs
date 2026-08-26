// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {EmptyLaneAccumulator} from "src/merkle/EmptyLaneAccumulator.sol";
import {AnchorRegistry} from "src/registry/AnchorRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployHypercertsInstance
/// @notice One labeled script for the WHOLE lane-2-only hypercerts instance battery
///         (research/operations/hypercerts/runbook.md): EmptyLaneAccumulator → AnchorRegistry →
///         SP1JournalVerifier (hypercerts vkey, canonical gateway) → MerkleSnapshot
///         (journal v3) → setAnchorRegistry → setEpochLength → optional InstanceRegistry
///         entry. Inputs via env so local rehearsals and the Sepolia release use the same script.
///
/// Env: SP1_VERIFIER_GATEWAY (canonical per-chain gateway; MockSP1Gateway only on a dev
///      chain), HYPERCERTS_VKEY (derive on the PINNED toolchain — docs/concepts/networks-and-programs.md caveat),
///      HYPERCERTS_PARAMS_HASH (`prover hypercerts paramshash params.json`),
///      HYPERCERTS_EPOCH_LENGTH (blocks; 50400 = 1 week @ 12s; 0 = unscheduled rehearsal),
///      CONSTITUTIONAL_ADMIN / OPERATIONAL_ADMIN / REGISTRAR_ADMIN (default: deployer),
///      HYPERCERTS_MAX_TOTAL_INPUTS (combined-count anchor-ingress ceiling; default/max: 200000),
///      INSTANCE_REGISTRY (optional; register the instance if set).
contract DeployHypercertsInstance is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    function run(string calldata outLabel) public {
        address deployer = vm.addr(_privateKey);
        address gateway = vm.envAddress("SP1_VERIFIER_GATEWAY");
        bytes32 vkey = vm.envBytes32("HYPERCERTS_VKEY");
        bytes32 paramsHash = vm.envBytes32("HYPERCERTS_PARAMS_HASH");
        uint64 epochLength = uint64(vm.envOr("HYPERCERTS_EPOCH_LENGTH", uint256(0)));
        address constitutional = vm.envOr("CONSTITUTIONAL_ADMIN", deployer);
        address operational = vm.envOr("OPERATIONAL_ADMIN", deployer);
        address registrar = vm.envOr("REGISTRAR_ADMIN", deployer);
        uint256 maxTotalInputsRaw = vm.envOr("HYPERCERTS_MAX_TOTAL_INPUTS", uint256(200_000));
        require(gateway != address(0) && vkey != bytes32(0), "gateway/vkey required");
        require(maxTotalInputsRaw <= type(uint64).max, "input capacity too large");

        _startBroadcast();

        EmptyLaneAccumulator emptyAcc = new EmptyLaneAccumulator();
        // The require above proves this deployment parameter fits without truncation.
        // forge-lint: disable-next-line(unsafe-typecast)
        AnchorRegistry anchorRegistry = new AnchorRegistry(registrar, uint64(maxTotalInputsRaw));
        SP1JournalVerifier verifier = new SP1JournalVerifier(ISP1Verifier(gateway), vkey);
        MerkleSnapshot snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            paramsHash,
            IAttestationAccumulator(address(emptyAcc)),
            // Deployer holds the roles during wiring; hand-off to the timelocks is the
            // last rehearsal step (see the runbook's roles table).
            deployer,
            operational
        );
        snapshot.setAnchorRegistry(IAnchorRegistry(address(anchorRegistry)));
        anchorRegistry.bindSnapshot(address(snapshot));
        // Only this snapshot's trigger() may mint checkpoints (issue #10). It matters more on a
        // lane-2-only instance than anywhere else: lane 1 is constant (0, 0), so the checkpoint id
        // is the ONLY thing separating one epoch's inputs from another's.
        emptyAcc.bindSnapshot(address(snapshot));
        if (epochLength > 0) {
            snapshot.setEpochLength(epochLength);
        }
        if (constitutional != deployer) {
            snapshot.grantRole(snapshot.CONSTITUTIONAL_ROLE(), constitutional);
            snapshot.renounceRole(snapshot.CONSTITUTIONAL_ROLE(), deployer);
        }

        address instanceRegistry = vm.envOr("INSTANCE_REGISTRY", address(0));
        if (instanceRegistry != address(0)) {
            InstanceRegistry(instanceRegistry)
                .register(
                    keccak256(bytes(outLabel)),
                    IInstanceRegistry.Instance({
                    program: keccak256("hypercerts"),
                    snapshot: address(snapshot),
                    verifier: address(verifier),
                    registryOrAccumulator: address(anchorRegistry),
                    paramsHash: paramsHash
                })
                );
        }

        vm.stopBroadcast();

        console.log("EmptyLaneAccumulator:", address(emptyAcc));
        console.log("AnchorRegistry:      ", address(anchorRegistry));
        console.log("Max total inputs:    ", maxTotalInputsRaw);
        console.log("SP1JournalVerifier:  ", address(verifier));
        console.log("MerkleSnapshot:      ", address(snapshot));

        string memory _json = "json";
        _json.serialize("empty_lane_accumulator", Strings.toChecksumHexString(address(emptyAcc)));
        _json.serialize("anchor_registry", Strings.toChecksumHexString(address(anchorRegistry)));
        _json.serialize("max_total_inputs", maxTotalInputsRaw);
        _json.serialize("zk_verifier", Strings.toChecksumHexString(address(verifier)));
        string memory out = _json.serialize("merkle_snapshot", Strings.toChecksumHexString(address(snapshot)));
        vm.writeFile(string.concat(root, "/.docker/hypercerts_instance_", outLabel, "_deploy.json"), out);
    }
}
