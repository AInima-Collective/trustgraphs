// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";

import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {DistributorAttaching} from "src/factory/DistributorAttaching.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

/// @notice `attachDistributor`: the read-only "created without a fund" state becomes reversible.
///         Anyone may pay the gas, but the fund is owned by a VERIFIED current constitutional
///         holder — so the permissionless caller can route value only to the instance's own live
///         authority, and one instance never accumulates two factory-known funds.
contract TrustgraphsFactoryAttachDistributorTest is TrustgraphsFactoryBase {
    address internal admin;
    address internal stranger = address(0x57AA);

    function setUp() public override {
        super.setUp();
        admin = address(safeAdmin);
    }

    function test_AttachDeploysAFundOwnedByTheVerifiedAuthority() public {
        TrustgraphsFactory.CreateArgs memory args = _args("fundless");
        args.admin = admin;
        Created memory created = _create(args);
        assertEq(created.distributor, address(0), "created without a fund");
        assertEq(factory.distributorOf(created.instanceId), address(0));

        // A stranger pays the gas; the fund still belongs to the instance's authority.
        vm.recordLogs();
        vm.prank(stranger);
        address distributor = factory.attachDistributor(created.instanceId, admin, address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        MerkleFundDistributor fund = MerkleFundDistributor(payable(distributor));
        assertEq(fund.owner(), admin, "fund owner is the constitutional holder, never the caller");
        assertEq(fund.pendingOwner(), address(0), "no dangling handoff");
        assertEq(fund.merkleSnapshot(), created.snapshot, "fund reads this instance's proven root");
        assertEq(factory.distributorOf(created.instanceId), distributor, "factory records the attachment");

        bool sawEvent;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(factory)
                    && logs[i].topics[0] == DistributorAttaching.DistributorAttached.selector
                    && logs[i].topics[1] == created.instanceId
            ) {
                (address emittedDistributor, address emittedToken) = abi.decode(logs[i].data, (address, address));
                assertEq(emittedDistributor, distributor);
                assertEq(emittedToken, address(0));
                sawEvent = true;
            }
        }
        assertTrue(sawEvent, "DistributorAttached must be emitted for the indexer");

        // The factory retains nothing on what it attached.
        assertFalse(
            MerkleSnapshot(created.snapshot)
                .hasRole(MerkleSnapshot(created.snapshot).CONSTITUTIONAL_ROLE(), address(factory))
        );
    }

    function test_AttachRefusesADuplicateFund() public {
        TrustgraphsFactory.CreateArgs memory args = _args("already funded");
        args.admin = admin;
        args.withDistributor = true;
        Created memory created = _create(args);
        assertEq(factory.distributorOf(created.instanceId), created.distributor, "creation-time fund is recorded");

        vm.expectRevert(
            abi.encodeWithSelector(
                DistributorAttaching.DistributorAlreadyAttached.selector, created.instanceId, created.distributor
            )
        );
        factory.attachDistributor(created.instanceId, admin, address(0));

        // And an attached fund cannot be attached over either.
        TrustgraphsFactory.CreateArgs memory second = _args("attach twice");
        second.admin = admin;
        Created memory again = _create(second);
        address attached = factory.attachDistributor(again.instanceId, admin, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(DistributorAttaching.DistributorAlreadyAttached.selector, again.instanceId, attached)
        );
        factory.attachDistributor(again.instanceId, admin, address(0));
    }

    function test_AttachRefusesAnUnknownInstanceAndANonAuthorityOwner() public {
        // An unregistered id fails inside the registry itself, with its own descriptive error.
        bytes32 unknown = keccak256("no such instance");
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.InstanceNotFound.selector, unknown));
        factory.attachDistributor(unknown, admin, address(0));

        TrustgraphsFactory.CreateArgs memory args = _args("authority gated");
        args.admin = admin;
        Created memory created = _create(args);
        vm.expectRevert(
            abi.encodeWithSelector(DistributorAttaching.NotInstanceAuthority.selector, created.instanceId, stranger)
        );
        factory.attachDistributor(created.instanceId, stranger, address(0));
    }

    function test_AttachRejectsAConstitutionalEoaOwner() public {
        address eoaAdmin = address(0xE0A);
        TrustgraphsFactory.CreateArgs memory args = _args("eoa authority");
        args.admin = eoaAdmin;
        Created memory created = _create(args);

        vm.expectRevert(abi.encodeWithSelector(DistributorAttaching.InvalidDistributorSafe.selector, eoaAdmin));
        factory.attachDistributor(created.instanceId, eoaAdmin, address(0));
    }
}
