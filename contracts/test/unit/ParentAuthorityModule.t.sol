// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {ParentAuthorityModule} from "src/zodiac/ParentAuthorityModule.sol";
import {ParentAuthorityModuleDeployer} from "src/factory/InstanceDeployers.sol";

contract ParentModuleController {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function rotate(address owner_) external {
        owner = owner_;
    }
}

contract ParentModuleTarget {
    uint256 public number;

    function setNumber(uint256 number_) external payable {
        number = number_;
    }
}

contract ParentAuthorityModuleTest is Test {
    address internal admin = address(0xA11CE);
    address internal parentAuthority = address(0xA4E17);
    address internal outsider = address(0xBAD);
    bytes32 internal constant CHILD = keccak256("child");
    bytes32 internal constant PARENT = keccak256("parent");

    InstanceRegistry internal instances;
    GnosisSafe internal safe;
    ParentModuleController internal childController;
    ParentModuleController internal parentController;
    ParentModuleTarget internal target;
    ParentAuthorityModuleDeployer internal deployer;

    function setUp() public {
        instances = new InstanceRegistry(admin);
        GnosisSafe singleton = new GnosisSafe();
        GnosisSafeProxyFactory safeFactory = new GnosisSafeProxyFactory();
        address[] memory owners = new address[](1);
        owners[0] = address(this);
        bytes memory initializer = abi.encodeCall(
            GnosisSafe.setup, (owners, 1, address(0), bytes(""), address(0), address(0), 0, payable(address(0)))
        );
        safe = GnosisSafe(payable(address(safeFactory.createProxyWithNonce(address(singleton), initializer, 1))));

        childController = new ParentModuleController(address(safe));
        parentController = new ParentModuleController(parentAuthority);
        target = new ParentModuleTarget();
        deployer = new ParentAuthorityModuleDeployer();
        _register(CHILD, address(childController));
        _register(PARENT, address(parentController));
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

    function _deploy(uint48 delay) internal returns (ParentAuthorityModule module) {
        module = deployer.deploy(address(safe), instances, CHILD, PARENT, delay);
        vm.prank(address(safe));
        safe.enableModule(address(module));
    }

    function _setNumberCall(uint256 number) internal pure returns (bytes memory) {
        return abi.encodeCall(ParentModuleTarget.setNumber, (number));
    }

    function test_ZeroDelayParentExecutesImmediatelyThroughChildSafe() public {
        ParentAuthorityModule module = _deploy(0);
        bytes memory data = _setNumberCall(42);

        vm.prank(parentAuthority);
        bytes32 actionId = module.execute(address(target), 0, data, Enum.Operation.Call);

        assertEq(target.number(), 42);
        assertEq(module.nextNonce(), 1);
        assertEq(actionId, module.hashAction(0, address(target), 0, data, Enum.Operation.Call));
    }

    function test_OnlyCurrentParentAuthorityCanExecuteOrSchedule() public {
        ParentAuthorityModule instant = _deploy(0);
        vm.expectRevert(
            abi.encodeWithSelector(ParentAuthorityModule.OnlyParentAuthority.selector, outsider, parentAuthority)
        );
        vm.prank(outsider);
        instant.execute(address(target), 0, _setNumberCall(1), Enum.Operation.Call);

        ParentAuthorityModule delayed = _deploy(3 days);
        vm.expectRevert(
            abi.encodeWithSelector(ParentAuthorityModule.OnlyParentAuthority.selector, outsider, parentAuthority)
        );
        vm.prank(outsider);
        delayed.schedule(address(target), 0, _setNumberCall(2), Enum.Operation.Call);
    }

    function test_DelayedActionIsExactPublicAndChildCancellable() public {
        uint48 delay = 3 days;
        ParentAuthorityModule module = _deploy(delay);
        bytes memory data = _setNumberCall(7);

        vm.prank(parentAuthority);
        bytes32 actionId = module.schedule(address(target), 0, data, Enum.Operation.Call);
        uint256 executableAt = block.timestamp + delay;
        assertEq(module.readyAt(actionId), executableAt);

        vm.expectRevert(
            abi.encodeWithSelector(ParentAuthorityModule.ExecutionDelayNotElapsed.selector, actionId, executableAt)
        );
        module.executeScheduled(0, address(target), 0, data, Enum.Operation.Call);

        vm.warp(executableAt);
        vm.prank(outsider);
        module.executeScheduled(0, address(target), 0, data, Enum.Operation.Call);
        assertEq(target.number(), 7);
        assertEq(module.readyAt(actionId), 0);

        vm.prank(parentAuthority);
        actionId = module.schedule(address(target), 0, _setNumberCall(8), Enum.Operation.Call);
        vm.prank(address(safe));
        module.cancel(actionId);
        assertEq(module.readyAt(actionId), 0);
    }

    function test_ParentCanCancelAndOutsiderCannot() public {
        ParentAuthorityModule module = _deploy(1 days);
        vm.prank(parentAuthority);
        bytes32 actionId = module.schedule(address(target), 0, _setNumberCall(7), Enum.Operation.Call);

        vm.expectRevert(
            abi.encodeWithSelector(
                ParentAuthorityModule.NotAuthorizedToCancel.selector, outsider, parentAuthority, address(safe)
            )
        );
        vm.prank(outsider);
        module.cancel(actionId);

        vm.prank(parentAuthority);
        module.cancel(actionId);
        assertEq(module.readyAt(actionId), 0);
    }

    function test_AuthorityRotationTakesEffectImmediately() public {
        ParentAuthorityModule module = _deploy(0);
        address nextAuthority = address(0xA4E18);
        parentController.rotate(nextAuthority);
        assertEq(module.parentAuthority(), nextAuthority);

        vm.expectRevert(
            abi.encodeWithSelector(ParentAuthorityModule.OnlyParentAuthority.selector, parentAuthority, nextAuthority)
        );
        vm.prank(parentAuthority);
        module.execute(address(target), 0, _setNumberCall(1), Enum.Operation.Call);

        vm.prank(nextAuthority);
        module.execute(address(target), 0, _setNumberCall(2), Enum.Operation.Call);
        assertEq(target.number(), 2);
    }

    function test_RenouncePermanentlyMakesModuleInertIncludingQueuedActions() public {
        ParentAuthorityModule module = _deploy(1 days);
        vm.prank(parentAuthority);
        module.schedule(address(target), 0, _setNumberCall(9), Enum.Operation.Call);

        vm.prank(parentAuthority);
        module.renounce();
        assertTrue(module.renounced());

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(ParentAuthorityModule.ParentAuthorityRenounced.selector);
        module.executeScheduled(0, address(target), 0, _setNumberCall(9), Enum.Operation.Call);
        vm.expectRevert(ParentAuthorityModule.ParentAuthorityRenounced.selector);
        vm.prank(parentAuthority);
        module.schedule(address(target), 0, _setNumberCall(10), Enum.Operation.Call);
        vm.expectRevert(ParentAuthorityModule.ParentAuthorityRenounced.selector);
        vm.prank(parentAuthority);
        module.renounce();
    }

    function test_InstantAndDelayedModesAreMutuallyExclusive() public {
        ParentAuthorityModule instant = _deploy(0);
        vm.expectRevert(ParentAuthorityModule.SchedulingDisabled.selector);
        vm.prank(parentAuthority);
        instant.schedule(address(target), 0, _setNumberCall(1), Enum.Operation.Call);

        ParentAuthorityModule delayed = _deploy(1);
        vm.expectRevert(abi.encodeWithSelector(ParentAuthorityModule.InstantExecutionDisabled.selector, uint48(1)));
        vm.prank(parentAuthority);
        delayed.execute(address(target), 0, _setNumberCall(1), Enum.Operation.Call);
    }

    function test_ModuleMustBeBoundToTheChildsLiveSafeAuthority() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ParentAuthorityModule.ChildAuthorityMismatch.selector, CHILD, address(safe), address(0x5AFE)
            )
        );
        deployer.deploy(address(0x5AFE), instances, CHILD, PARENT, 0);
    }

    function test_DisabledModuleCannotExerciseParentPower() public {
        ParentAuthorityModule module = deployer.deploy(address(safe), instances, CHILD, PARENT, 0);
        vm.expectRevert(bytes("GS104"));
        vm.prank(parentAuthority);
        module.execute(address(target), 0, _setNumberCall(1), Enum.Operation.Call);
        assertEq(target.number(), 0);
    }

    function test_DeployerAndModuleKeepEip170Headroom() public {
        assertLt(address(deployer).code.length, 24_576);
        ParentAuthorityModule module = new ParentAuthorityModule(address(safe), instances, CHILD, PARENT, 0);
        assertLt(address(module).code.length, 24_576);
        assertGt(24_576 - address(deployer).code.length, 3_000, "deployer runtime margin");
        assertGt(24_576 - address(module).code.length, 3_000, "module runtime margin");
    }
}
