// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {ISubnetworkRegistry} from "interfaces/registry/ISubnetworkRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {SubnetworkRegistry} from "src/registry/SubnetworkRegistry.sol";

contract SubnetworkAuthority {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function rotate(address owner_) external {
        owner = owner_;
    }
}

contract BareSubnetworkAuthority {}

contract SubnetworkRegistryTest is Test {
    address internal admin = address(0xA11CE);
    address internal registrar = address(0xFAC);
    address internal childAuthority = address(0xC111D);
    address internal parentAuthority = address(0xA4E17);
    address internal outsider = address(0xBAD);

    bytes32 internal constant CHILD = keccak256("child");
    bytes32 internal constant PARENT = keccak256("parent");
    bytes32 internal constant OTHER_PARENT = keccak256("other-parent");

    InstanceRegistry internal instances;
    SubnetworkRegistry internal subnetworks;
    SubnetworkAuthority internal childController;
    SubnetworkAuthority internal parentController;
    SubnetworkAuthority internal otherParentController;

    event ParentClaimed(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed childAuthority
    );
    event ChildAccepted(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed parentAuthority
    );
    event ParentClaimCancelled(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed cancelledBy
    );
    event SubnetworkRegistered(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed registrar
    );
    event SubnetworkReleased(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed parentAuthority
    );

    function setUp() public {
        instances = new InstanceRegistry(admin);
        subnetworks = new SubnetworkRegistry(instances, admin);
        childController = new SubnetworkAuthority(childAuthority);
        parentController = new SubnetworkAuthority(parentAuthority);
        otherParentController = new SubnetworkAuthority(address(0x07AE4));

        _register(CHILD, address(childController));
        _register(PARENT, address(parentController));
        _register(OTHER_PARENT, address(otherParentController));

        bytes32 registrarRole = subnetworks.REGISTRAR_ROLE();
        vm.prank(admin);
        subnetworks.grantRole(registrarRole, registrar);
    }

    function _record(uint256 seed) internal pure returns (IInstanceRegistry.Instance memory) {
        return IInstanceRegistry.Instance({
            program: keccak256("trust-graph"),
            snapshot: address(uint160(seed + 1)),
            verifier: address(uint160(seed + 2)),
            registryOrAccumulator: address(uint160(seed + 3)),
            paramsHash: keccak256(abi.encode(seed))
        });
    }

    function _register(bytes32 instanceId, address controller) internal {
        vm.prank(admin);
        instances.registerWithParamsAuthority(instanceId, _record(uint256(instanceId)), controller);
    }

    function _registerBare(bytes32 instanceId) internal returns (BareSubnetworkAuthority authority) {
        authority = new BareSubnetworkAuthority();
        _register(instanceId, address(authority));
    }

    function _claimAndAccept(bytes32 child, bytes32 parent, address childOwner, address parentOwner) internal {
        vm.prank(childOwner);
        subnetworks.claimParent(child, parent);
        vm.prank(parentOwner);
        subnetworks.acceptChild(child);
    }

    function test_HandshakeRecordsConsentAndParentCanRelease() public {
        vm.expectEmit(true, true, true, true, address(subnetworks));
        emit ParentClaimed(CHILD, PARENT, childAuthority);
        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, PARENT);

        assertEq(subnetworks.pendingParentOf(CHILD), PARENT);
        assertEq(subnetworks.parentOf(CHILD), bytes32(0));

        vm.expectEmit(true, true, true, true, address(subnetworks));
        emit ChildAccepted(CHILD, PARENT, parentAuthority);
        vm.prank(parentAuthority);
        subnetworks.acceptChild(CHILD);

        assertEq(subnetworks.pendingParentOf(CHILD), bytes32(0));
        assertEq(subnetworks.parentOf(CHILD), PARENT);

        vm.expectEmit(true, true, true, true, address(subnetworks));
        emit SubnetworkReleased(CHILD, PARENT, parentAuthority);
        vm.prank(parentAuthority);
        subnetworks.release(CHILD);
        assertEq(subnetworks.parentOf(CHILD), bytes32(0));
    }

    function test_OnlyCurrentAuthoritiesMayClaimAcceptAndRelease() public {
        vm.expectRevert(
            abi.encodeWithSelector(ISubnetworkRegistry.Unauthorized.selector, CHILD, outsider, childAuthority)
        );
        vm.prank(outsider);
        subnetworks.claimParent(CHILD, PARENT);

        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, PARENT);

        vm.expectRevert(
            abi.encodeWithSelector(ISubnetworkRegistry.Unauthorized.selector, PARENT, outsider, parentAuthority)
        );
        vm.prank(outsider);
        subnetworks.acceptChild(CHILD);

        vm.prank(parentAuthority);
        subnetworks.acceptChild(CHILD);

        vm.expectRevert(
            abi.encodeWithSelector(ISubnetworkRegistry.Unauthorized.selector, PARENT, childAuthority, parentAuthority)
        );
        vm.prank(childAuthority);
        subnetworks.release(CHILD);
    }

    function test_EitherCurrentAuthorityCanCancelAPendingClaim() public {
        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, PARENT);

        vm.expectRevert(
            abi.encodeWithSelector(
                ISubnetworkRegistry.NotClaimParticipant.selector, CHILD, outsider, childAuthority, parentAuthority
            )
        );
        vm.prank(outsider);
        subnetworks.cancelParentClaim(CHILD);

        vm.expectEmit(true, true, true, true, address(subnetworks));
        emit ParentClaimCancelled(CHILD, PARENT, parentAuthority);
        vm.prank(parentAuthority);
        subnetworks.cancelParentClaim(CHILD);
        assertEq(subnetworks.pendingParentOf(CHILD), bytes32(0));

        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, PARENT);
        vm.prank(childAuthority);
        subnetworks.cancelParentClaim(CHILD);
        assertEq(subnetworks.pendingParentOf(CHILD), bytes32(0));
    }

    function test_AuthorityRotationAppliesWithoutRewritingTheClaim() public {
        address nextChildAuthority = address(0xC222D);
        address nextParentAuthority = address(0xA4E18);

        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, PARENT);
        childController.rotate(nextChildAuthority);
        parentController.rotate(nextParentAuthority);

        assertEq(subnetworks.authorityOf(CHILD), nextChildAuthority);
        assertEq(subnetworks.authorityOf(PARENT), nextParentAuthority);

        vm.expectRevert(
            abi.encodeWithSelector(
                ISubnetworkRegistry.Unauthorized.selector, PARENT, parentAuthority, nextParentAuthority
            )
        );
        vm.prank(parentAuthority);
        subnetworks.acceptChild(CHILD);

        vm.prank(nextParentAuthority);
        subnetworks.acceptChild(CHILD);

        parentController.rotate(parentAuthority);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubnetworkRegistry.Unauthorized.selector, PARENT, nextParentAuthority, parentAuthority
            )
        );
        vm.prank(nextParentAuthority);
        subnetworks.release(CHILD);

        vm.prank(parentAuthority);
        subnetworks.release(CHILD);
    }

    function test_BareParamsAuthorityIsTheAuthorityFallback() public {
        bytes32 bareChild = keccak256("bare-child");
        BareSubnetworkAuthority bare = _registerBare(bareChild);
        assertEq(subnetworks.authorityOf(bareChild), address(bare));
    }

    function test_UnknownAndControllerlessInstancesFailClosed() public {
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.UnknownInstance.selector, unknown));
        subnetworks.authorityOf(unknown);

        bytes32 controllerless = keccak256("controllerless");
        vm.prank(admin);
        instances.register(controllerless, _record(uint256(controllerless)));
        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.MissingAuthority.selector, controllerless));
        subnetworks.authorityOf(controllerless);
    }

    function test_RegistrarCanCreateAcceptedLinkAtomicallyButCannotRewriteIt() public {
        vm.expectEmit(true, true, true, true, address(subnetworks));
        emit SubnetworkRegistered(CHILD, PARENT, registrar);
        vm.prank(registrar);
        subnetworks.registerSubnetwork(CHILD, PARENT);
        assertEq(subnetworks.parentOf(CHILD), PARENT);
        assertEq(subnetworks.pendingParentOf(CHILD), bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.ParentAlreadySet.selector, CHILD, PARENT));
        vm.prank(registrar);
        subnetworks.registerSubnetwork(CHILD, OTHER_PARENT);
    }

    function test_RegistrarRoleIsLeastPrivilegeAndAdminDoesNotReceiveItImplicitly() public {
        assertFalse(subnetworks.hasRole(subnetworks.REGISTRAR_ROLE(), admin));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, subnetworks.REGISTRAR_ROLE()
            )
        );
        vm.prank(outsider);
        subnetworks.registerSubnetwork(CHILD, PARENT);
    }

    function test_RejectsSelfParentAndDuplicatePendingClaim() public {
        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.SelfParent.selector, CHILD));
        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, CHILD);

        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, PARENT);
        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.PendingClaimExists.selector, CHILD, PARENT));
        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, OTHER_PARENT);
    }

    function test_AcceptanceRechecksRacingPendingClaimsForCycles() public {
        vm.prank(childAuthority);
        subnetworks.claimParent(CHILD, PARENT);
        vm.prank(parentAuthority);
        subnetworks.claimParent(PARENT, CHILD);

        vm.prank(parentAuthority);
        subnetworks.acceptChild(CHILD);

        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.CycleDetected.selector, PARENT, CHILD));
        vm.prank(childAuthority);
        subnetworks.acceptChild(PARENT);
    }

    function test_RegistrarRejectsDirectCycle() public {
        vm.prank(registrar);
        subnetworks.registerSubnetwork(CHILD, PARENT);

        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.CycleDetected.selector, PARENT, CHILD));
        vm.prank(registrar);
        subnetworks.registerSubnetwork(PARENT, CHILD);
    }

    function test_AllowsSixteenAncestorsAndRejectsASeventeenth() public {
        bytes32[18] memory ids;
        address[18] memory authorities;
        ids[0] = keccak256("depth-root");
        authorities[0] = address(_registerBare(ids[0]));

        for (uint256 i = 1; i < ids.length; ++i) {
            ids[i] = keccak256(abi.encode("depth", i));
            authorities[i] = address(_registerBare(ids[i]));
        }

        for (uint256 i = 1; i <= subnetworks.MAXIMUM_DEPTH(); ++i) {
            vm.prank(registrar);
            subnetworks.registerSubnetwork(ids[i], ids[i - 1]);
        }
        assertEq(subnetworks.parentOf(ids[16]), ids[15]);

        vm.expectRevert(
            abi.encodeWithSelector(
                ISubnetworkRegistry.MaximumDepthExceeded.selector, ids[17], ids[16], subnetworks.MAXIMUM_DEPTH()
            )
        );
        vm.prank(registrar);
        subnetworks.registerSubnetwork(ids[17], ids[16]);
    }

    function test_NoPendingAndNoParentOperationsUseTypedErrors() public {
        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.NoPendingClaim.selector, CHILD));
        subnetworks.acceptChild(CHILD);
        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.NoPendingClaim.selector, CHILD));
        subnetworks.cancelParentClaim(CHILD);
        vm.expectRevert(abi.encodeWithSelector(ISubnetworkRegistry.NoParent.selector, CHILD));
        subnetworks.release(CHILD);
    }
}
