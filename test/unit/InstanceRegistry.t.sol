// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title InstanceRegistryTest
/// @notice The one-per-chain deployment directory (MULTI_PROGRAM_PLATFORM §4): role gating,
///         register/update/enumerate, and event shapes.
contract InstanceRegistryTest is Test {
    InstanceRegistry reg;
    address admin = address(0x0BE7); // operational timelock

    bytes32 constant TG = keccak256("trust-graph");
    bytes32 constant HC = keccak256("hypercerts");

    event InstanceRegistered(
        bytes32 indexed instanceId,
        bytes32 indexed program,
        address snapshot,
        address verifier,
        address registryOrAccumulator,
        bytes32 paramsHash
    );
    event InstanceUpdated(
        bytes32 indexed instanceId,
        bytes32 indexed program,
        address snapshot,
        address verifier,
        address registryOrAccumulator,
        bytes32 paramsHash
    );
    event ParamsAuthorityUpdated(
        bytes32 indexed instanceId, address indexed oldAuthority, address indexed newAuthority
    );
    event InstanceParamsHashUpdated(bytes32 indexed instanceId, bytes32 oldParamsHash, bytes32 newParamsHash);

    function setUp() public {
        reg = new InstanceRegistry(admin);
    }

    function _rec(bytes32 program, uint160 seed) internal pure returns (IInstanceRegistry.Instance memory) {
        return IInstanceRegistry.Instance({
            program: program,
            snapshot: address(seed),
            verifier: address(seed + 1),
            registryOrAccumulator: address(seed + 2),
            paramsHash: keccak256(abi.encode(program, seed))
        });
    }

    /*//////////////////////////////////////////////////////////////
                            ROLE GATING
    //////////////////////////////////////////////////////////////*/

    function test_ConstructorGrantsRoles() public view {
        assertTrue(reg.hasRole(reg.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(reg.hasRole(reg.OPERATOR_ROLE(), admin));
    }

    /// `register` accepts either role, so its gate is a single explicit check rather than an
    /// `onlyRole` modifier — a caller holding neither gets `NotRegistrar`.
    function test_RegisterRoleGated() public {
        IInstanceRegistry.Instance memory r = _rec(TG, 0x100);
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.NotRegistrar.selector, address(this)));
        reg.register(TG, r);
    }

    /// The split that gives the factory its blast radius: `REGISTRAR_ROLE` may append a row and
    /// nothing else. Granting it must NOT confer the power to rewrite an existing record, which is
    /// what a single shared role would have done.
    function test_RegistrarCanRegisterButNotUpdate() public {
        address factoryLike = address(0xFAC);
        bytes32 registrarRole = reg.REGISTRAR_ROLE();
        vm.prank(admin);
        reg.grantRole(registrarRole, factoryLike);

        vm.prank(factoryLike);
        reg.register(TG, _rec(TG, 0x100));
        assertEq(reg.getInstance(TG).snapshot, address(0x100), "the registrar appended a row");

        IInstanceRegistry.Instance memory hijack = _rec(TG, 0xdead);
        // Read the role BEFORE the prank: a getter is a call, and would otherwise spend it.
        bytes32 operatorRole = reg.OPERATOR_ROLE();
        vm.prank(factoryLike);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, factoryLike, operatorRole)
        );
        reg.update(TG, hijack);
        assertEq(reg.getInstance(TG).snapshot, address(0x100), "and could not rewrite it");
    }

    /// `OPERATOR_ROLE` remains a superset: a timelock-driven deployment needs no new grant.
    function test_OperatorCanStillRegister() public {
        vm.prank(admin);
        reg.register(TG, _rec(TG, 0x100));
        assertTrue(reg.isRegistered(TG));
    }

    function test_UpdateRoleGated() public {
        vm.prank(admin);
        reg.register(TG, _rec(TG, 0x100));

        IInstanceRegistry.Instance memory r = _rec(TG, 0x200);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), reg.OPERATOR_ROLE()
            )
        );
        reg.update(TG, r);
    }

    /// The admin can rotate OPERATOR_ROLE (e.g. to a new timelock).
    function test_AdminRotatesOperatorRole() public {
        address newOp = address(0xF00D);
        bytes32 opRole = reg.OPERATOR_ROLE();
        vm.prank(admin);
        reg.grantRole(opRole, newOp);

        vm.prank(newOp);
        reg.register(TG, _rec(TG, 0x100));
        assertTrue(reg.isRegistered(TG));
    }

    /*//////////////////////////////////////////////////////////////
                        REGISTER / UPDATE / READ
    //////////////////////////////////////////////////////////////*/

    function test_RegisterStoresAndEmits() public {
        IInstanceRegistry.Instance memory r = _rec(TG, 0x100);

        vm.expectEmit(true, true, false, true, address(reg));
        emit InstanceRegistered(TG, r.program, r.snapshot, r.verifier, r.registryOrAccumulator, r.paramsHash);

        vm.prank(admin);
        reg.register(TG, r);

        assertTrue(reg.isRegistered(TG));
        IInstanceRegistry.Instance memory got = reg.getInstance(TG);
        assertEq(got.program, r.program);
        assertEq(got.snapshot, r.snapshot);
        assertEq(got.verifier, r.verifier);
        assertEq(got.registryOrAccumulator, r.registryOrAccumulator);
        assertEq(got.paramsHash, r.paramsHash);
    }

    function test_RegisterRejectsDuplicate() public {
        vm.startPrank(admin);
        reg.register(TG, _rec(TG, 0x100));
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.InstanceAlreadyExists.selector, TG));
        reg.register(TG, _rec(TG, 0x200));
        vm.stopPrank();
    }

    function test_UpdateReplacesRecordAndEmits() public {
        vm.startPrank(admin);
        reg.register(TG, _rec(TG, 0x100));

        IInstanceRegistry.Instance memory r2 = _rec(TG, 0x900);
        vm.expectEmit(true, true, false, true, address(reg));
        emit InstanceUpdated(TG, r2.program, r2.snapshot, r2.verifier, r2.registryOrAccumulator, r2.paramsHash);
        reg.update(TG, r2);
        vm.stopPrank();

        IInstanceRegistry.Instance memory got = reg.getInstance(TG);
        assertEq(got.snapshot, r2.snapshot);
        assertEq(got.paramsHash, r2.paramsHash);
        // Enumeration stays append-only: still exactly one id.
        assertEq(reg.instanceCount(), 1);
    }

    function test_UpdateRejectsUnknown() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.InstanceNotFound.selector, HC));
        reg.update(HC, _rec(HC, 0x100));
    }

    function test_PerInstanceParamsAuthorityCanOnlyChangeItsOwnHash() public {
        address authority = address(0xA11CE);
        IInstanceRegistry.Instance memory r = _rec(TG, 0x100);
        vm.prank(admin);
        reg.registerWithParamsAuthority(TG, r, authority);

        bytes32 nextHash = keccak256("next");
        vm.expectEmit(true, false, false, true, address(reg));
        emit InstanceParamsHashUpdated(TG, r.paramsHash, nextHash);
        vm.prank(authority);
        reg.updateParamsHash(TG, nextHash);

        IInstanceRegistry.Instance memory got = reg.getInstance(TG);
        assertEq(got.paramsHash, nextHash);
        assertEq(got.snapshot, r.snapshot);
        assertEq(got.verifier, r.verifier);
        assertEq(got.registryOrAccumulator, r.registryOrAccumulator);
    }

    function test_ParamsAuthorityIsScopedPerInstance() public {
        address tgAuthority = address(0xA11CE);
        address hcAuthority = address(0xB0B);
        vm.startPrank(admin);
        reg.registerWithParamsAuthority(TG, _rec(TG, 0x100), tgAuthority);
        reg.registerWithParamsAuthority(HC, _rec(HC, 0x200), hcAuthority);
        vm.stopPrank();

        vm.prank(tgAuthority);
        vm.expectRevert(
            abi.encodeWithSelector(IInstanceRegistry.NotParamsAuthority.selector, HC, tgAuthority, hcAuthority)
        );
        reg.updateParamsHash(HC, keccak256("hijack"));
    }

    function test_OperatorCanAssociateLegacyRowWithController() public {
        address controller = address(0xC011);
        vm.startPrank(admin);
        reg.register(TG, _rec(TG, 0x100));
        assertEq(reg.paramsAuthority(TG), address(0));

        vm.expectEmit(true, true, true, true, address(reg));
        emit ParamsAuthorityUpdated(TG, address(0), controller);
        reg.setParamsAuthority(TG, controller);
        vm.stopPrank();
        assertEq(reg.paramsAuthority(TG), controller);
    }

    function test_GetInstanceRevertsUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.InstanceNotFound.selector, HC));
        reg.getInstance(HC);
    }

    /*//////////////////////////////////////////////////////////////
                            ENUMERATION
    //////////////////////////////////////////////////////////////*/

    function test_Enumerate() public {
        vm.startPrank(admin);
        reg.register(TG, _rec(TG, 0x100));
        reg.register(HC, _rec(HC, 0x200));
        vm.stopPrank();

        assertEq(reg.instanceCount(), 2);
        assertEq(reg.instanceIdAt(0), TG);
        assertEq(reg.instanceIdAt(1), HC);

        bytes32[] memory ids = reg.getInstanceIds();
        assertEq(ids.length, 2);
        assertEq(ids[0], TG);
        assertEq(ids[1], HC);
    }

    function test_EmptyEnumeration() public view {
        assertEq(reg.instanceCount(), 0);
        assertEq(reg.getInstanceIds().length, 0);
        assertFalse(reg.isRegistered(TG));
    }
}
