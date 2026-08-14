// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {MultiSend} from "@gnosis.pm/safe-contracts/libraries/MultiSend.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Vm} from "forge-std/Vm.sol";

import {GovernedTrustgraphsFactory} from "contracts/factory/GovernedTrustgraphsFactory.sol";
import {GovernedAuthorityDeployer} from "contracts/factory/InstanceDeployers.sol";
import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsController} from "contracts/factory/TrustgraphsParamsController.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleGovModule} from "contracts/zodiac/MerkleGovModule.sol";
import {DelayedRecoveryModule} from "contracts/zodiac/DelayedRecoveryModule.sol";
import {SafeExecutionGuard} from "contracts/zodiac/SafeExecutionGuard.sol";
import {SignerSyncZkModule} from "contracts/zodiac/SignerSyncZkModule.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {DeployZodiacSafes} from "script/DeployZodiacSafes.s.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract DeployZodiacSafesHarness is DeployZodiacSafes {
    function handoff(address deployer, SafeDeployment memory deployment, TrustgraphsParamsController controller)
        external
    {
        _handoffScoringAuthority(deployer, deployment, controller);
    }
}

contract GovernedTrustgraphsFactoryTest is TrustgraphsFactoryBase {
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GovernedAuthorityDeployer internal authorityDeployer;
    DeployZodiacSafesHarness internal zodiacHarness;

    address internal creator = address(0xA11CE);

    function _unpaidPolicy() internal pure returns (GovernedTrustgraphsFactory.InitialPolicy memory) {
        return GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
    }

    function setUp() public override {
        super.setUp();
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        authorityDeployer = new GovernedAuthorityDeployer();
        governedFactory =
            new GovernedTrustgraphsFactory(factory, safeFactory, address(safeSingleton), authorityDeployer);
        zodiacHarness = new DeployZodiacSafesHarness();
    }

    function test_CreateGovernedInstanceMakesSafeTheAuthorityFromGenesis() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-owned");
        args.admin = address(0xBAD); // ignored: governed creation is never EOA-administered
        args.withDistributor = true;
        args.salt = bytes32(uint256(7));

        vm.recordLogs();
        vm.prank(creator);
        (bytes32 instanceId, address safe, address module, address snapshot) =
            governedFactory.createGovernedInstance(args, _unpaidPolicy());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        CreatedEvent memory created = _decodeCreated(logs);
        address controller = _decodeController(logs, instanceId);

        assertEq(created.creator, safe, "the Safe must be the canonical factory caller");
        assertEq(created.admin, safe, "the Safe must hold every instance authority");
        assertEq(factory.computeInstanceId(safe, args.name, args.salt), instanceId, "instance id creator mismatch");
        assertEq(created.snapshot, snapshot, "wrapper discovered the wrong snapshot");

        assertEq(TrustgraphsParamsController(controller).owner(), safe, "Safe must own scoring controller");
        assertEq(MerkleFundDistributor(created.distributor).owner(), safe, "Safe must own shared fund");
        assertTrue(
            MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), safe),
            "Safe must hold constitutional authority"
        );

        MerkleGovModule gov = MerkleGovModule(module);
        assertEq(gov.owner(), safe, "Safe must own governance settings");
        assertEq(gov.avatar(), safe, "module avatar must be Safe");
        assertEq(gov.target(), safe, "module target must be Safe");
        assertEq(gov.merkleSnapshotContract(), snapshot, "module must vote from this network");
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(module), "governance module must be enabled");
        assertEq(MerkleSnapshot(snapshot).hookCount(), 1, "governance hook must be installed");
        assertEq(address(MerkleSnapshot(snapshot).hooks(1)), module, "wrong governance hook");

        address[] memory owners = GnosisSafe(payable(safe)).getOwners();
        assertEq(owners.length, 1, "bootstrap owner must be removed");
        assertEq(owners[0], creator, "creator must remain the visible Safe owner");
        assertEq(GnosisSafe(payable(safe)).getThreshold(), 1, "initial Safe threshold");
        assertFalse(GnosisSafe(payable(safe)).isOwner(address(governedFactory)), "wrapper retained Safe ownership");

        GovernedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        assertEq(authority.safe, safe, "authority Safe");
        assertEq(authority.governanceModule, module, "authority governance module");
        assertEq(authority.initialRecoveryProposer, creator, "authority recovery proposer");
        assertEq(authority.recoveryDelay, 14 days, "authority recovery delay");
        assertTrue(SafeExecutionGuard(authority.executionGuard).isSealed(), "owner route must be sealed");
        assertEq(SafeExecutionGuard(authority.executionGuard).safe(), safe, "guard Safe");
        assertEq(address(DelayedRecoveryModule(authority.recoveryModule).safe()), safe, "recovery Safe");
        assertTrue(
            GnosisSafe(payable(safe)).isModuleEnabled(authority.recoveryModule), "recovery module must be enabled"
        );

        address installedGuard = address(uint160(uint256(vm.load(safe, GUARD_STORAGE_SLOT))));
        assertEq(installedGuard, authority.executionGuard, "authority guard must be installed on Safe");
        (address[] memory modules, address next) = GnosisSafe(payable(safe)).getModulesPaginated(address(0x1), 10);
        assertEq(modules.length, 2, "only the two delayed authority routes may be enabled");
        assertEq(next, address(0x1), "module list must be exhausted");
    }

    function test_CreatorCannotExecuteAnyOwnerTransactionAfterAtomicGraduation() public {
        TrustgraphsFactory.CreateArgs memory args = _args("sealed-owner-route");
        args.withDistributor = true;

        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) =
            governedFactory.createGovernedInstance(args, _unpaidPolicy());
        GovernedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        SafeExecutionGuard guard = SafeExecutionGuard(authority.executionGuard);
        bytes32 originalParamsHash = MerkleSnapshot(snapshot).paramsHash();

        _expectOwnerExecutionLocked(
            guard,
            safe,
            snapshot,
            0,
            abi.encodeCall(MerkleSnapshot.setParamsHash, (bytes32(uint256(0xBEEF)))),
            Enum.Operation.Call
        );

        vm.deal(safe, 1 ether);
        uint256 creatorBalance = creator.balance;
        _expectOwnerExecutionLocked(guard, safe, creator, 1 ether, bytes(""), Enum.Operation.Call);
        assertEq(creator.balance, creatorBalance, "owner path withdrew Safe funds");

        _expectOwnerExecutionLocked(
            guard, safe, safe, 0, abi.encodeWithSignature("setGuard(address)", address(0)), Enum.Operation.Call
        );
        _expectOwnerExecutionLocked(
            guard, safe, safe, 0, abi.encodeWithSignature("enableModule(address)", address(0xB0B)), Enum.Operation.Call
        );

        // Arbitrary upgrade/delegatecall paths are covered by the same sealed owner boundary.
        _expectOwnerExecutionLocked(guard, safe, snapshot, 0, bytes(""), Enum.Operation.DelegateCall);

        MultiSend multiSend = new MultiSend();
        bytes memory inner = abi.encodeCall(MerkleSnapshot.setParamsHash, (bytes32(uint256(0xCAFE))));
        bytes memory transactions = abi.encodePacked(uint8(0), snapshot, uint256(0), uint256(inner.length), inner);
        _expectOwnerExecutionLocked(
            guard,
            safe,
            address(multiSend),
            0,
            abi.encodeCall(MultiSend.multiSend, (transactions)),
            Enum.Operation.DelegateCall
        );

        assertEq(MerkleSnapshot(snapshot).paramsHash(), originalParamsHash, "blocked paths changed scoring truth");
        assertFalse(GnosisSafe(payable(safe)).isModuleEnabled(address(0xB0B)), "owner enabled a bypass module");
        assertEq(address(uint160(uint256(vm.load(safe, GUARD_STORAGE_SLOT)))), address(guard), "owner removed guard");
    }

    function test_RecoveryRouteEnforcesFourteenDayDelayAndExecutesPermissionlessly() public {
        TrustgraphsFactory.CreateArgs memory args = _args("delayed-recovery");
        vm.prank(creator);
        (bytes32 instanceId,,, address snapshot) = governedFactory.createGovernedInstance(args, _unpaidPolicy());
        GovernedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        DelayedRecoveryModule recovery = DelayedRecoveryModule(authority.recoveryModule);

        uint64 nextEpochLength = EPOCH_FLOOR + 1;
        bytes memory data = abi.encodeCall(MerkleSnapshot.setEpochLength, (nextEpochLength));
        uint256 scheduledAt = block.timestamp;
        vm.prank(creator);
        bytes32 actionId = recovery.schedule(snapshot, 0, data, Enum.Operation.Call);

        assertEq(recovery.readyAt(actionId), scheduledAt + 14 days, "wrong public recovery deadline");
        vm.expectRevert(
            abi.encodeWithSelector(
                DelayedRecoveryModule.RecoveryDelayNotElapsed.selector, actionId, scheduledAt + 14 days
            )
        );
        recovery.execute(0, snapshot, 0, data, Enum.Operation.Call);

        vm.warp(scheduledAt + 14 days);
        address publicExecutor = address(0xE7EC);
        vm.prank(publicExecutor);
        recovery.execute(0, snapshot, 0, data, Enum.Operation.Call);

        assertEq(MerkleSnapshot(snapshot).epochLength(), nextEpochLength, "delayed Safe action did not execute");
        assertEq(recovery.readyAt(actionId), 0, "executed recovery remained queued");
    }

    function test_RecoveryActionsCanBeCancelledByProposerOrSafe() public {
        TrustgraphsFactory.CreateArgs memory args = _args("recovery-veto");
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) =
            governedFactory.createGovernedInstance(args, _unpaidPolicy());
        DelayedRecoveryModule recovery = DelayedRecoveryModule(governedFactory.authorityOf(instanceId).recoveryModule);
        bytes memory data = abi.encodeCall(MerkleSnapshot.setParamsHash, (bytes32(uint256(0xA))));

        vm.prank(creator);
        bytes32 first = recovery.schedule(snapshot, 0, data, Enum.Operation.Call);
        vm.prank(creator);
        recovery.cancel(first);
        assertEq(recovery.readyAt(first), 0, "proposer cancellation failed");

        vm.prank(creator);
        bytes32 second = recovery.schedule(snapshot, 0, data, Enum.Operation.Call);
        vm.prank(safe);
        recovery.cancel(second);
        assertEq(recovery.readyAt(second), 0, "member-governed Safe veto failed");
    }

    function test_RecoveryDelegatecallBatchCannotBypassDelay() public {
        TrustgraphsFactory.CreateArgs memory args = _args("delayed-recovery-batch");
        vm.prank(creator);
        (bytes32 instanceId,,, address snapshot) = governedFactory.createGovernedInstance(args, _unpaidPolicy());
        DelayedRecoveryModule recovery = DelayedRecoveryModule(governedFactory.authorityOf(instanceId).recoveryModule);

        MultiSend multiSend = new MultiSend();
        uint64 nextEpochLength = EPOCH_FLOOR + 2;
        bytes memory inner = abi.encodeCall(MerkleSnapshot.setEpochLength, (nextEpochLength));
        bytes memory transactions = abi.encodePacked(uint8(0), snapshot, uint256(0), uint256(inner.length), inner);
        bytes memory batch = abi.encodeCall(MultiSend.multiSend, (transactions));

        uint256 scheduledAt = block.timestamp;
        vm.prank(creator);
        bytes32 actionId = recovery.schedule(address(multiSend), 0, batch, Enum.Operation.DelegateCall);

        vm.expectRevert(
            abi.encodeWithSelector(
                DelayedRecoveryModule.RecoveryDelayNotElapsed.selector, actionId, scheduledAt + 14 days
            )
        );
        recovery.execute(0, address(multiSend), 0, batch, Enum.Operation.DelegateCall);

        vm.warp(scheduledAt + 14 days);
        recovery.execute(0, address(multiSend), 0, batch, Enum.Operation.DelegateCall);
        assertEq(MerkleSnapshot(snapshot).epochLength(), nextEpochLength, "delayed batch did not execute");
    }

    function test_RecoveryModuleCannotBeConfiguredBelowFourteenDays() public {
        uint48 tooShort = uint48(14 days - 1);
        vm.expectRevert(abi.encodeWithSelector(DelayedRecoveryModule.DelayTooShort.selector, tooShort, uint48(14 days)));
        new DelayedRecoveryModule(address(0x5AFE), creator, tooShort);
    }

    function test_GuardCanOnlyBeSealedOnceByItsBootstrapper() public {
        SafeExecutionGuard guard = new SafeExecutionGuard(address(0x5AFE), address(this));

        vm.expectRevert(abi.encodeWithSelector(SafeExecutionGuard.OnlyBootstrapper.selector, creator));
        vm.prank(creator);
        guard.seal();

        guard.seal();
        vm.expectRevert(SafeExecutionGuard.AlreadySealed.selector);
        guard.seal();
    }

    function test_CreateGovernedInstanceForwardsPrepayAndInstallsPayablePolicyThroughSafe() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-funded");
        uint96 cap = 25e8;
        vault.setFeePerRootUsd(factory.PROGRAM(), 1, 5e8);
        vm.deal(creator, 3 ether);

        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = governedFactory.createGovernedInstance{value: 3 ether}(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: cap})
        );

        IProvingVault.Account memory account = vault.accountOf(instanceId);
        assertEq(account.ethBalance, 3 ether, "the instance tank must receive the full prepay");
        IProvingVault.Policy memory policy = vault.policyOf(instanceId);
        assertEq(policy.minPaidIntervalBlocks, EPOCH_FLOOR, "paid cadence must be installed atomically");
        assertEq(policy.maxPerRootUsd, cap, "per-root cap must be installed atomically");
        assertEq(address(vault).balance, 3 ether, "the governed wrapper must retain nothing");
        assertEq(safe.balance, 0, "the bootstrap Safe must retain nothing");
        assertEq(address(governedFactory).balance, 0, "the wrapper must retain nothing");

        MerkleSnapshot snapshotContract = MerkleSnapshot(snapshot);
        vm.roll(uint256(snapshotContract.epochOriginBlock()) + EPOCH_FLOOR);
        snapshotContract.trigger();
        IProvingVault.Quote memory quote = vault.quote(instanceId, 0);
        assertTrue(quote.eligible, "the first valid checkpoint must be payable");
        assertTrue(
            quote.reason != uint8(IProvingVault.IneligibleReason.PolicyDisabled),
            "a prepaid instance must never start policy-disabled"
        );
    }

    function test_CreateGovernedInstanceRejectsPrepayWithoutPolicy() public {
        TrustgraphsFactory.CreateArgs memory args = _args("disabled-prepay");
        vm.deal(creator, 1 ether);

        vm.prank(creator);
        vm.expectRevert(GovernedTrustgraphsFactory.PrepayRequiresPolicy.selector);
        governedFactory.createGovernedInstance{value: 1 ether}(args, _unpaidPolicy());
        assertEq(registry.instanceCount(), 0, "invalid prepay must create nothing");
    }

    function test_CreateGovernedInstanceRejectsPolicyWithoutPrepay() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unfunded-policy");

        vm.prank(creator);
        vm.expectRevert(GovernedTrustgraphsFactory.PolicyRequiresPrepay.selector);
        governedFactory.createGovernedInstance(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8})
        );
        assertEq(registry.instanceCount(), 0, "unfunded policy must create nothing");
    }

    function test_CreateGovernedInstanceRequiresAPricedInitialBand() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unpriced-prepay");
        vm.deal(creator, 1 ether);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialFeeUnpriced.selector, factory.PROGRAM(), uint8(1))
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8})
        );
    }

    function test_CreateGovernedInstanceBoundsInitialPaidTerms() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unsafe-policy");
        vault.setFeePerRootUsd(factory.PROGRAM(), 1, 5e8);
        vm.deal(creator, 2 ether);

        vm.startPrank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedTrustgraphsFactory.InitialPaidIntervalTooShort.selector, EPOCH_FLOOR - 1, EPOCH_FLOOR
            )
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR - 1, maxPerRootUsd: 25e8})
        );

        uint96 maximum = governedFactory.MAX_INITIAL_MAX_PER_ROOT_USD();
        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialCapTooHigh.selector, maximum + 1, maximum)
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: maximum + 1})
        );

        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialCapBelowFee.selector, uint96(4e8), uint256(5e8))
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 4e8})
        );
        vm.stopPrank();
    }

    function test_DemoHandoffMakesSafeTheScoringAuthority() public {
        TrustgraphsFactory.CreateArgs memory args = _args("demo-handoff");
        args.admin = address(zodiacHarness);
        Created memory created = _create(args);

        GnosisSafe demoSafe = _safeOwnedBy(address(zodiacHarness));
        MerkleGovModule gov =
            new MerkleGovModule(address(zodiacHarness), address(demoSafe), address(demoSafe), created.snapshot);
        SignerSyncZkModule signer = new SignerSyncZkModule(
            address(zodiacHarness),
            address(demoSafe),
            address(demoSafe),
            IZkVerifier(address(verifier)),
            IAttestationAccumulator(created.resolver),
            MerkleSnapshot(created.snapshot).paramsHash(),
            bytes32(uint256(1))
        );

        address[] memory initialSigners = new address[](1);
        initialSigners[0] = address(zodiacHarness);
        DeployZodiacSafes.SafeDeployment memory deployment = DeployZodiacSafes.SafeDeployment({
            safe: address(demoSafe),
            merkleGovModule: address(gov),
            signerSyncModule: address(signer),
            initialSigners: initialSigners,
            threshold: 1,
            modulesEnabled: true,
            fundingAmount: 0
        });

        zodiacHarness.handoff(address(zodiacHarness), deployment, TrustgraphsParamsController(created.controller));

        assertEq(TrustgraphsParamsController(created.controller).owner(), address(demoSafe));
        assertEq(signer.paramsAuthority(), address(demoSafe));
        assertEq(gov.owner(), address(demoSafe));
        assertEq(signer.owner(), address(demoSafe));
    }

    function _safeOwnedBy(address owner) internal returns (GnosisSafe safe) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            1,
            address(0),
            bytes(""),
            address(0),
            address(0),
            0,
            address(0)
        );
        safe = GnosisSafe(payable(safeFactory.createProxyWithNonce(address(safeSingleton), initializer, 12345)));
    }

    function _expectOwnerExecutionLocked(
        SafeExecutionGuard guard,
        address safe,
        address target,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) internal {
        vm.expectRevert(abi.encodeWithSelector(SafeExecutionGuard.OwnerExecutionLocked.selector, creator));
        vm.prank(creator);
        GnosisSafe(payable(safe))
            .execTransaction(
                target, value, data, operation, 0, 0, 0, address(0), payable(address(0)), _approvedSignature(creator)
            );
        assertTrue(guard.isSealed(), "guard unexpectedly unsealed");
    }

    function _approvedSignature(address signer) internal pure returns (bytes memory) {
        return abi.encodePacked(uint256(uint160(signer)), uint256(0), uint8(1));
    }
}
