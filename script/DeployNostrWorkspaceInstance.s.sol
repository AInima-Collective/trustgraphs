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
import {SP1JournalVerifier} from "contracts/merkle/SP1JournalVerifier.sol";
import {EmptyLaneAccumulator} from "contracts/merkle/EmptyLaneAccumulator.sol";
import {AnchorRegistry} from "contracts/registry/AnchorRegistry.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {NostrWorkspaceParamsAuthority} from "contracts/factory/NostrWorkspaceParamsAuthority.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployNostrWorkspaceInstance
/// @notice Deploy and register one complete lane-2-only `nostr-workspace` instance in the required
///         order: EmptyLaneAccumulator → AnchorRegistry → labeled SP1JournalVerifier → snapshot →
///         reciprocal bindings → node-kind policy → immutable params authority → InstanceRegistry.
///
/// Env: SP1_VERIFIER_GATEWAY, NOSTR_WORKSPACE_VKEY, NOSTR_WORKSPACE_PARAMS_HASH,
///      NOSTR_COMMUNITY_NODE_ID, optional comma-delimited NOSTR_MEMBER_NODE_IDS,
///      INSTANCE_REGISTRY, NOSTR_EPOCH_LENGTH (default 0), NOSTR_MAX_TOTAL_INPUTS (default 200000),
///      CONSTITUTIONAL_ADMIN / OPERATIONAL_ADMIN / ANCHORER_ADMIN (default deployer).
contract DeployNostrWorkspaceInstance is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    function run(string calldata outLabel) public {
        address deployer = vm.addr(_privateKey);
        address gateway = vm.envAddress("SP1_VERIFIER_GATEWAY");
        bytes32 vkey = vm.envBytes32("NOSTR_WORKSPACE_VKEY");
        bytes32 paramsHash = vm.envBytes32("NOSTR_WORKSPACE_PARAMS_HASH");
        bytes32 communityNode = vm.envBytes32("NOSTR_COMMUNITY_NODE_ID");
        bytes32[] memory memberNodes = vm.envOr("NOSTR_MEMBER_NODE_IDS", ",", new bytes32[](0));
        address instanceRegistry = vm.envAddress("INSTANCE_REGISTRY");
        uint256 capacity = vm.envOr("NOSTR_MAX_TOTAL_INPUTS", uint256(200_000));
        uint64 epochLength = uint64(vm.envOr("NOSTR_EPOCH_LENGTH", uint256(0)));
        address constitutional = vm.envOr("CONSTITUTIONAL_ADMIN", deployer);
        address operational = vm.envOr("OPERATIONAL_ADMIN", deployer);
        address anchorer = vm.envOr("ANCHORER_ADMIN", operational);

        require(
            gateway != address(0) && vkey != bytes32(0) && paramsHash != bytes32(0) && communityNode != bytes32(0)
                && instanceRegistry != address(0),
            "nostr deployment identity required"
        );
        require(capacity <= type(uint64).max, "input capacity too large");

        vm.startBroadcast(_privateKey);

        EmptyLaneAccumulator emptyAcc = new EmptyLaneAccumulator();
        AnchorRegistry anchors = new AnchorRegistry(deployer, uint64(capacity));
        SP1JournalVerifier verifier = new SP1JournalVerifier(ISP1Verifier(gateway), vkey);
        MerkleSnapshot snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            paramsHash,
            IAttestationAccumulator(address(emptyAcc)),
            deployer,
            operational
        );
        snapshot.setAnchorRegistry(IAnchorRegistry(address(anchors)));
        anchors.bindSnapshot(address(snapshot));
        emptyAcc.bindSnapshot(address(snapshot));
        if (epochLength > 0) snapshot.setEpochLength(epochLength);

        anchors.registerNode(communityNode, anchors.NODE_KIND_BUZZ_COMMUNITY());
        for (uint256 i; i < memberNodes.length; ++i) {
            require(memberNodes[i] != bytes32(0), "zero nostr member node");
            anchors.registerNode(memberNodes[i], anchors.NODE_KIND_NOSTR());
        }

        if (operational != deployer) {
            anchors.grantRole(anchors.DEFAULT_ADMIN_ROLE(), operational);
            anchors.grantRole(anchors.REGISTRAR_ROLE(), operational);
        }
        if (anchorer != deployer) anchors.grantRole(anchors.ANCHORER_ROLE(), anchorer);
        if (operational != deployer) {
            anchors.renounceRole(anchors.REGISTRAR_ROLE(), deployer);
            if (anchorer != deployer) anchors.renounceRole(anchors.ANCHORER_ROLE(), deployer);
            anchors.renounceRole(anchors.DEFAULT_ADMIN_ROLE(), deployer);
        }
        if (constitutional != deployer) {
            snapshot.grantRole(snapshot.CONSTITUTIONAL_ROLE(), constitutional);
            snapshot.renounceRole(snapshot.CONSTITUTIONAL_ROLE(), deployer);
        }

        bytes32 instanceId = keccak256(abi.encode(deployer, "nostr-workspace", outLabel, address(snapshot)));
        NostrWorkspaceParamsAuthority authority =
            new NostrWorkspaceParamsAuthority(instanceId, address(snapshot), paramsHash);
        InstanceRegistry(instanceRegistry)
            .registerWithParamsAuthority(
                instanceId,
                IInstanceRegistry.Instance({
                program: keccak256("nostr-workspace"),
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(anchors),
                paramsHash: paramsHash
            }),
                address(authority)
            );

        vm.stopBroadcast();

        console.log("instanceId:              ", vm.toString(instanceId));
        console.log("EmptyLaneAccumulator:    ", address(emptyAcc));
        console.log("AnchorRegistry:          ", address(anchors));
        console.log("SP1JournalVerifier:      ", address(verifier));
        console.log("MerkleSnapshot:          ", address(snapshot));
        console.log("NostrParamsAuthority:    ", address(authority));

        string memory json = "json";
        json.serialize("instance_id", vm.toString(instanceId));
        json.serialize("empty_lane_accumulator", Strings.toChecksumHexString(address(emptyAcc)));
        json.serialize("anchor_registry", Strings.toChecksumHexString(address(anchors)));
        json.serialize("zk_verifier", Strings.toChecksumHexString(address(verifier)));
        json.serialize("params_authority", Strings.toChecksumHexString(address(authority)));
        json.serialize("params_hash", vm.toString(paramsHash));
        json.serialize("program_vkey", vm.toString(vkey));
        json.serialize("max_total_inputs", capacity);
        string memory out = json.serialize("merkle_snapshot", Strings.toChecksumHexString(address(snapshot)));
        vm.writeFile(string.concat(root, "/.docker/nostr_workspace_instance_", outLabel, "_deploy.json"), out);
    }
}
