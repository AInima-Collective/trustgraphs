// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;
import {Test} from "forge-std/Test.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";
import {TestAccumulator} from "test/mocks/TestAccumulator.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {SubnetworkRegistry} from "src/registry/SubnetworkRegistry.sol";

contract ReleaseReadinessPoC is Test {
    function test_ChangedParamsCannotBeCheckpointedWithoutUnrelatedInput() public {
        MockZkVerifier verifier = new MockZkVerifier();
        TestAccumulator accumulator = new TestAccumulator();
        bytes32 oldParams = keccak256("old parameters");
        bytes32 newParams = keccak256("new parameters");
        MerkleSnapshot snapshot = new MerkleSnapshot(verifier, oldParams, accumulator, address(this), address(this), "");
        accumulator.bindSnapshot(address(snapshot));
        accumulator.fold(0, address(1), address(2), bytes32(uint256(1)), bytes32(uint256(2)));
        uint256 checkpointId = snapshot.trigger();
        snapshot.submitProof(
            checkpointId, bytes32(uint256(3)), bytes32(uint256(4)), "cid", 1, bytes32(0), address(1), ""
        );
        snapshot.setParamsHash(newParams);
        vm.roll(block.number + 10_000);
        vm.expectRevert(IAttestationAccumulator.NoNewInputs.selector);
        snapshot.trigger();
        assertEq(snapshot.paramsHash(), newParams);
        assertEq(snapshot.checkpointParamsHash(checkpointId), oldParams);
        assertEq(snapshot.nextCheckpointId(), 1);
        assertTrue(snapshot.hasAppliedCheckpoint());
        // Only unrelated new ingress allows the new scoring configuration to be frozen.
        accumulator.fold(0, address(3), address(4), bytes32(uint256(5)), bytes32(uint256(6)));
        uint256 newId = snapshot.trigger();
        assertEq(snapshot.checkpointParamsHash(newId), newParams);
    }

    function test_BuildingHierarchyFromLeavesExceedsDeclaredMaximumDepth() public {
        InstanceRegistry registry = new InstanceRegistry(address(this));
        SubnetworkRegistry subnetworks = new SubnetworkRegistry(registry, address(this));
        for (uint256 i = 1; i <= 34; ++i) {
            registry.registerWithParamsAuthority(
                bytes32(i),
                IInstanceRegistry.Instance({
                    program: keccak256("trust-graph"),
                    snapshot: address(1),
                    verifier: address(2),
                    registryOrAccumulator: address(3),
                    paramsHash: keccak256("params")
                }),
                address(this)
            );
        }
        // Every new parent is a root, so the validator observes depth one each time.
        for (uint256 i = 1; i < 34; ++i) {
            subnetworks.claimParent(bytes32(i), bytes32(i + 1));
            subnetworks.acceptChild(bytes32(i));
        }
        uint256 depth;
        bytes32 node = bytes32(uint256(1));
        while (subnetworks.parentOf(node) != bytes32(0)) {
            node = subnetworks.parentOf(node);
            ++depth;
        }
        assertEq(depth, 33);
        assertGt(depth, subnetworks.MAXIMUM_DEPTH());
    }
}
