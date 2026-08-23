// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustgraphsFactoryBase} from "./TrustgraphsFactoryBase.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsController} from "src/factory/TrustgraphsParamsController.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {TrustgraphsParamsValidator} from "src/params/TrustgraphsParamsValidator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

contract TrustgraphsParamsControllerTest is TrustgraphsFactoryBase {
    address internal constant PUBLISHER = address(0xB0B);

    function test_FactoryCreatedControllerStartsPublishedAndOwnsOnlyOperationalUpdates() public {
        Created memory created = _create(_lane1Args("controller-direct"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(created.controller);
        ParamsCodec.Params memory current = controller.getCurrentParams();

        assertEq(controller.instanceId(), created.instanceId);
        assertEq(controller.snapshot(), created.snapshot);
        assertEq(address(controller.registry()), address(registry));
        assertEq(controller.owner(), address(this));
        assertEq(controller.version(), 1);
        assertTrue(controller.versionOnePublished());
        assertEq(controller.currentParamsHash(), ParamsCodec.hash(current));
        assertTrue(
            MerkleSnapshot(created.snapshot)
                .hasRole(MerkleSnapshot(created.snapshot).OPERATIONAL_ROLE(), address(controller))
        );
        assertFalse(
            MerkleSnapshot(created.snapshot).hasRole(MerkleSnapshot(created.snapshot).OPERATIONAL_ROLE(), address(this))
        );
    }

    function test_InitialPublicationIsPublisherOnlyOneShotAndRequiredBeforeUpdates() public {
        Created memory created = _create(_lane1Args("controller-publisher"));
        ParamsCodec.Params memory current = TrustgraphsParamsController(created.controller).getCurrentParams();
        TrustgraphsParamsController standalone = new TrustgraphsParamsController(
            created.instanceId, created.snapshot, registry, current, address(this), PUBLISHER
        );

        ParamsCodec.Params memory next = current;
        next.dampingFp = 8e17;
        vm.expectRevert(TrustgraphsParamsController.InitialVersionNotPublished.selector);
        standalone.updateParams(next, "ipfs://review");

        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(TrustgraphsParamsController.NotInitialPublisher.selector, address(0xBAD))
        );
        standalone.publishInitialVersion();

        vm.prank(PUBLISHER);
        standalone.publishInitialVersion();
        assertTrue(standalone.versionOnePublished());
        vm.prank(PUBLISHER);
        vm.expectRevert(TrustgraphsParamsController.InitialVersionAlreadyPublished.selector);
        standalone.publishInitialVersion();
    }

    function test_UpdateIsOwnerOnlyRejectsNoopAndMovesSnapshotRegistryAndLocalStateAtomically() public {
        Created memory created = _create(_lane1Args("controller-update"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(created.controller);
        ParamsCodec.Params memory initial = controller.getCurrentParams();

        vm.prank(address(0xBAD));
        vm.expectRevert();
        controller.updateParams(initial, "ipfs://unauthorized");

        vm.expectRevert(
            abi.encodeWithSelector(TrustgraphsParamsController.NoopUpdate.selector, controller.currentParamsHash())
        );
        controller.updateParams(initial, "ipfs://noop");

        bytes32 previousHash = controller.currentParamsHash();
        ParamsCodec.Params memory next = initial;
        next.dampingFp = 8e17;
        (uint64 newVersion, bytes32 newHash) = controller.updateParams(next, "ipfs://review");

        assertEq(newVersion, 2);
        assertEq(controller.version(), 2);
        assertEq(newHash, ParamsCodec.hash(next));
        assertNotEq(newHash, previousHash);
        assertEq(controller.currentParamsHash(), newHash);
        assertEq(MerkleSnapshot(created.snapshot).paramsHash(), newHash);
        assertEq(registry.getInstance(created.instanceId).paramsHash, newHash);
        assertEq(controller.getCurrentParams().dampingFp, next.dampingFp);
    }

    function test_UpdateRejectsIdentityFieldChangesAndConstructorRejectsHashMismatch() public {
        Created memory created = _create(_lane1Args("controller-identity"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(created.controller);
        ParamsCodec.Params memory initial = controller.getCurrentParams();
        ParamsCodec.Params memory changed = initial;
        changed.chainId += 1;
        vm.expectRevert(TrustgraphsParamsValidator.IdentityFieldChanged.selector);
        controller.updateParams(changed, "ipfs://invalid");

        changed = initial;
        changed.dampingFp = 8e17;
        bytes32 changedHash = ParamsCodec.hash(changed);
        vm.expectRevert(
            abi.encodeWithSelector(
                TrustgraphsParamsController.InitialHashMismatch.selector,
                changedHash,
                MerkleSnapshot(created.snapshot).paramsHash()
            )
        );
        new TrustgraphsParamsController(
            created.instanceId,
            created.snapshot,
            IInstanceRegistry(address(registry)),
            changed,
            address(this),
            PUBLISHER
        );
    }

    function _lane1Args(string memory name) internal view returns (TrustgraphsFactory.CreateArgs memory) {
        ParamsCodec.Params memory params = _baseParams();
        params.envelope0DomainSeparators = new bytes32[](0);
        params.lane2MaxHeadAge = 0;
        return _args(name, params);
    }
}
