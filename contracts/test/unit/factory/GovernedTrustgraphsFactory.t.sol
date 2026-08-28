// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {MultiSend} from "@gnosis.pm/safe-contracts/libraries/MultiSend.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Vm} from "forge-std/Vm.sol";

import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsController} from "src/factory/TrustgraphsParamsController.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {EasOffchainAnchorRegistry} from "src/registry/EasOffchainAnchorRegistry.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";
import {SafeExecutionGuard} from "src/zodiac/SafeExecutionGuard.sol";
import {
    SignerSyncZkModule,
    ISignerSyncCheckpointSource,
    ISignerActivitySource
} from "src/zodiac/SignerSyncZkModule.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {DeployZodiacSafes} from "script/DeployZodiacSafes.s.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract FactorySignerVerifier is IZkVerifier {
    bytes32 public immutable programVKey;
    bytes32 public expectedDigest;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function setExpectedDigest(bytes32 digest) external {
        expectedDigest = digest;
    }

    function verify(bytes calldata, bytes32 digest) external view {
        require(expectedDigest == bytes32(0) || digest == expectedDigest, "FactorySignerVerifier: digest mismatch");
    }
}

contract DeployZodiacSafesHarness is DeployZodiacSafes {
    function handoff(address deployer, SafeDeployment memory deployment, TrustgraphsParamsController controller)
        external
    {
        _handoffScoringAuthority(deployer, deployment, controller);
    }
}

contract GovernedTrustgraphsFactoryTest is TrustgraphsFactoryBase {
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant SIGNER_VKEY = keccak256("factory signer guest");

    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GovernedAuthorityDeployer internal authorityDeployer;
    SignerSyncModuleDeployer internal signerSyncDeployer;
    MerkleGovModuleDeployer internal govModuleDeployer;
    FactorySignerVerifier internal signerVerifier;
    DeployZodiacSafesHarness internal zodiacHarness;

    address internal creator = address(0xA11CE);

    function _unpaidPolicy() internal pure returns (GovernedTrustgraphsFactory.InitialPolicy memory) {
        return GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
    }

    function _noSigner() internal pure returns (GovernedTrustgraphsFactory.SignerSyncConfig memory) {
        return
            GovernedTrustgraphsFactory.SignerSyncConfig({
                enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0
            });
    }

    function _createGoverned(
        TrustgraphsFactory.CreateArgs memory args,
        GovernedTrustgraphsFactory.InitialPolicy memory policy
    ) internal returns (bytes32, address, address, address) {
        return governedFactory.createGovernedInstance(args, policy, _noSigner());
    }

    function setUp() public override {
        super.setUp();
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        authorityDeployer = new GovernedAuthorityDeployer();
        signerSyncDeployer = new SignerSyncModuleDeployer();
        govModuleDeployer = new MerkleGovModuleDeployer();
        signerVerifier = new FactorySignerVerifier(SIGNER_VKEY);
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            signerVerifier,
            SIGNER_VKEY
        );
        zodiacHarness = new DeployZodiacSafesHarness();
    }

    function test_CreateGovernedInstanceMakesSafeTheAuthorityFromGenesis() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-owned");
        args.admin = address(0xBAD); // ignored: governed creation is never EOA-administered
        args.withDistributor = true;
        args.salt = bytes32(uint256(7));

        vm.recordLogs();
        vm.prank(creator);
        (bytes32 instanceId, address safe, address module, address snapshot) = _createGoverned(args, _unpaidPolicy());
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
        assertEq(MerkleSnapshot(snapshot).metadataURI(), args.metadataURI, "Safe-owned snapshot lost metadata");
        assertTrue(
            MerkleSnapshot(snapshot).provenanceEnabled(),
            "governed mints must open the composition-source window: the sealed Safe can never open it later"
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

    function test_CreateGovernedHybridMakesSafeTheStrictLaneAdmin() public {
        TrustgraphsFactory.CreateArgs memory args = _args("governed-hybrid");
        TrustgraphsFactory.OffchainEasConfig memory offchain = _governedOffchainConfig();

        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) =
            governedFactory.createGovernedHybridInstance(args, offchain, _unpaidPolicy(), _noSigner());

        EasOffchainAnchorRegistry anchors =
            EasOffchainAnchorRegistry(address(MerkleSnapshot(snapshot).anchorRegistry()));
        assertTrue(address(anchors) != address(0));
        assertEq(address(anchors.snapshot()), snapshot);
        assertTrue(anchors.hasRole(anchors.DEFAULT_ADMIN_ROLE(), safe), "Safe controls relayer policy");
        assertFalse(anchors.hasRole(anchors.DEFAULT_ADMIN_ROLE(), address(governedFactory)));
        assertEq(governedFactory.authorityOf(instanceId).safe, safe);
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(governedFactory.authorityOf(instanceId).governanceModule));
    }

    function test_GovernedHybridAndSignerSyncAreRejectedAtomically() public {
        GovernedTrustgraphsFactory.SignerSyncConfig memory signer = _noSigner();
        signer.enabled = true;
        vm.expectRevert(GovernedTrustgraphsFactory.HybridSignerSyncUnsupported.selector);
        governedFactory.createGovernedHybridInstance(
            _args("hybrid-signer"), _governedOffchainConfig(), _unpaidPolicy(), signer
        );
        assertEq(registry.instanceCount(), 0);
    }

    function test_SignerSyncDeployerRejectsAnyHybridScoreSnapshot() public {
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = governedFactory.createGovernedHybridInstance(
            _args("hybrid-defense"), _governedOffchainConfig(), _unpaidPolicy(), _noSigner()
        );
        address anchorRegistry = address(MerkleSnapshot(snapshot).anchorRegistry());
        IAttestationAccumulator accumulator = IAttestationAccumulator(address(MerkleSnapshot(snapshot).accumulator()));
        bytes32 paramsHash = MerkleSnapshot(snapshot).paramsHash();
        address activitySource = governedFactory.authorityOf(instanceId).governanceModule;
        vm.expectRevert(
            abi.encodeWithSelector(SignerSyncModuleDeployer.HybridScoreSnapshotUnsupported.selector, anchorRegistry)
        );
        signerSyncDeployer.deploy(
            instanceId,
            safe,
            IZkVerifier(address(verifier)),
            accumulator,
            ISignerSyncCheckpointSource(snapshot),
            ISignerActivitySource(activitySource),
            paramsHash,
            bytes32(uint256(1)),
            2,
            2,
            10_000,
            151_200,
            2
        );
    }

    function _governedOffchainConfig() internal pure returns (TrustgraphsFactory.OffchainEasConfig memory config) {
        config.maxTotalInputs = 200_000;
        config.initialRelayers = new address[](2);
        config.initialRelayers[0] = address(0x111);
        config.initialRelayers[1] = address(0x222);
    }

    function test_CreateDiscoverAndApplyOptionalSignerSyncWithoutConfigEdit() public {
        GovernedTrustgraphsFactory.SignerSyncConfig memory signerConfig = GovernedTrustgraphsFactory.SignerSyncConfig({
            enabled: true, topN: 5, minThreshold: 2, targetThresholdBps: 5000
        });

        TrustgraphsFactory.CreateArgs memory args = _args("self-serve-signer-sync");
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) =
            governedFactory.createGovernedInstance(args, _unpaidPolicy(), signerConfig);

        GovernedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        SignerSyncZkModule signer = SignerSyncZkModule(authority.signerSyncModule);
        assertEq(address(governedFactory.SIGNER_SYNC_VERIFIER()), address(signerVerifier));
        assertEq(governedFactory.SIGNER_SYNC_PROGRAM_VKEY(), SIGNER_VKEY);
        assertTrue(
            GnosisSafe(payable(safe)).isModuleEnabled(authority.governanceModule),
            "governance module must remain discoverable and enabled"
        );
        assertTrue(address(signer) != address(0), "signer module must be discoverable from authorityOf");
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(address(signer)), "signer module must be enabled");
        assertEq(signer.owner(), safe, "selection/verifier changes must be governed by the Safe");
        assertEq(signer.paramsAuthority(), safe, "scoring mirror must be governed by the Safe");
        assertEq(address(signer.scoreSnapshot()), snapshot, "signer checkpoint source");
        assertEq(address(signer.accumulator()), address(MerkleSnapshot(snapshot).accumulator()), "signer accumulator");
        assertEq(address(signer.zkVerifier()), address(signerVerifier), "dedicated signer verifier");
        assertEq(
            signer.selectionParamsHash(),
            keccak256(abi.encode(uint32(5), uint32(2), uint32(5000), uint64(151_200), uint32(2)))
        );

        (address[] memory modules, address next) = GnosisSafe(payable(safe)).getModulesPaginated(address(0x1), 10);
        assertEq(modules.length, 3, "gov, recovery and signer are the only enabled modules");
        assertEq(next, address(0x1));

        MerkleSnapshot scoreSnapshot = MerkleSnapshot(snapshot);
        vm.roll(uint256(scoreSnapshot.epochOriginBlock()) + EPOCH_FLOOR);
        uint256 checkpointId = scoreSnapshot.trigger();
        IAttestationAccumulator.Checkpoint memory checkpoint = scoreSnapshot.accumulator().getCheckpoint(checkpointId);

        address[] memory desired = new address[](2);
        desired[0] = address(0xB0B);
        desired[1] = address(0xCAFE);
        bytes32 firstLeaf = keccak256(abi.encode(desired[0]));
        bytes32 secondLeaf = keccak256(abi.encode(desired[1]));
        bytes32 signerSetRoot = firstLeaf < secondLeaf
            ? keccak256(abi.encode(firstLeaf, secondLeaf))
            : keccak256(abi.encode(secondLeaf, firstLeaf));
        bytes32 activityAcc = keccak256("factory activity");
        uint64 activityBlock = uint64(block.number);
        vm.mockCall(
            authority.governanceModule,
            abi.encodeWithSelector(bytes4(keccak256("activityAccumulator()"))),
            abi.encode(activityAcc)
        );
        vm.mockCall(
            authority.governanceModule,
            abi.encodeWithSelector(bytes4(keccak256("activityCount()"))),
            abi.encode(uint64(2))
        );
        vm.mockCall(
            authority.governanceModule,
            abi.encodeWithSelector(MerkleGovModule.getActivityCheckpoint.selector, uint256(0)),
            abi.encode(MerkleGovModule.ActivityCheckpoint(activityAcc, 2, activityBlock))
        );
        signerVerifier.setExpectedDigest(
            keccak256(
                abi.encode(
                    checkpoint.acc,
                    checkpoint.leafCount,
                    scoreSnapshot.checkpointParamsHash(checkpointId),
                    signer.selectionParamsHash(),
                    activityAcc,
                    uint64(2),
                    activityBlock,
                    false,
                    keccak256(abi.encode(creator)),
                    uint256(1),
                    signerSetRoot,
                    uint256(2),
                    keccak256(abi.encode(address(signer), block.chainid))
                )
            )
        );

        address relayer = address(0xBEEF);
        vm.prank(relayer);
        signer.submitSignerProof(checkpointId, 0, desired, 2, hex"1234");

        assertTrue(GnosisSafe(payable(safe)).isOwner(desired[0]));
        assertTrue(GnosisSafe(payable(safe)).isOwner(desired[1]));
        assertFalse(GnosisSafe(payable(safe)).isOwner(creator));
        assertEq(GnosisSafe(payable(safe)).getThreshold(), 2);
        assertEq(signer.lastAppliedCheckpoint(), checkpointId);
    }

    function test_ConstructorRejectsSignerVerifierProgramMismatch() public {
        bytes32 verifierVKey = keccak256("deployed signer guest");
        bytes32 suppliedVKey = keccak256("different signer guest");
        FactorySignerVerifier mismatchedVerifier = new FactorySignerVerifier(verifierVKey);

        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedTrustgraphsFactory.SignerSyncProgramVKeyMismatch.selector, suppliedVKey, verifierVKey
            )
        );
        new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            mismatchedVerifier,
            suppliedVKey
        );
    }

    function test_OptionalSignerRejectsUnsafeSelectionAtomically() public {
        GovernedTrustgraphsFactory.SignerSyncConfig memory signerConfig = GovernedTrustgraphsFactory.SignerSyncConfig({
            enabled: true, topN: 65, minThreshold: 2, targetThresholdBps: 5000
        });

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignerSyncModuleDeployer.InvalidSignerSelection.selector, uint32(65), uint32(2), uint32(5000)
            )
        );
        governedFactory.createGovernedInstance(_args("unsafe-signer-selection"), _unpaidPolicy(), signerConfig);
        assertEq(registry.instanceCount(), 0, "invalid signer policy must roll back base creation");
    }

    function test_CreatorCannotExecuteAnyOwnerTransactionAfterAtomicGraduation() public {
        TrustgraphsFactory.CreateArgs memory args = _args("sealed-owner-route");
        args.withDistributor = true;

        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = _createGoverned(args, _unpaidPolicy());
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
        (bytes32 instanceId,,, address snapshot) = _createGoverned(args, _unpaidPolicy());
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
        (bytes32 instanceId, address safe,, address snapshot) = _createGoverned(args, _unpaidPolicy());
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
        (bytes32 instanceId,,, address snapshot) = _createGoverned(args, _unpaidPolicy());
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
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: cap}),
            _noSigner()
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
        governedFactory.createGovernedInstance{value: 1 ether}(args, _unpaidPolicy(), _noSigner());
        assertEq(registry.instanceCount(), 0, "invalid prepay must create nothing");
    }

    function test_CreateGovernedInstanceRejectsPolicyWithoutPrepay() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unfunded-policy");

        vm.prank(creator);
        vm.expectRevert(GovernedTrustgraphsFactory.PolicyRequiresPrepay.selector);
        governedFactory.createGovernedInstance(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8}),
            _noSigner()
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
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8}),
            _noSigner()
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
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR - 1, maxPerRootUsd: 25e8}),
            _noSigner()
        );

        uint96 maximum = governedFactory.MAX_INITIAL_MAX_PER_ROOT_USD();
        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialCapTooHigh.selector, maximum + 1, maximum)
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: maximum + 1}),
            _noSigner()
        );

        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialCapBelowFee.selector, uint96(4e8), uint256(5e8))
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 4e8}),
            _noSigner()
        );
        vm.stopPrank();
    }

    function test_GovernedContractsHaveExplicitEip170Headroom() public view {
        assertLt(address(governedFactory).code.length, 24_576);
        assertLt(address(govModuleDeployer).code.length, 24_576);
        assertLt(address(authorityDeployer).code.length, 24_576);
        assertLt(address(signerSyncDeployer).code.length, 24_576);
        assertGt(24_576 - address(governedFactory).code.length, 3_000, "governed factory runtime margin");
        assertGt(24_576 - address(govModuleDeployer).code.length, 3_000, "gov module deployer runtime margin");
    }

    function test_DiscoveryEventPrecedesEveryGovModuleLog() public {
        TrustgraphsFactory.CreateArgs memory args = _args("ordered-discovery");
        vm.recordLogs();
        vm.prank(creator);
        (,, address module,) = _createGoverned(args, _unpaidPolicy());
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // OwnershipTransferred (Ownable's constructor log) is the ONE module log allowed before
        // discovery: no indexer handler subscribes to it. Every handler-consumed module event —
        // the snapshot-binding announcement above all — must follow GovernedInstanceCreated.
        bytes32 ownership = keccak256("OwnershipTransferred(address,address)");
        uint256 discoveryIndex = type(uint256).max;
        uint256 bindingIndex = type(uint256).max;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(governedFactory)
                    && logs[i].topics[0] == GovernedTrustgraphsFactory.GovernedInstanceCreated.selector
            ) discoveryIndex = i;
            if (logs[i].emitter != module) continue;
            if (logs[i].topics[0] == MerkleGovModule.MerkleSnapshotContractUpdated.selector) {
                assertEq(bindingIndex, type(uint256).max, "the binding is announced exactly once");
                bindingIndex = i;
            } else if (discoveryIndex == type(uint256).max) {
                assertEq(logs[i].topics[0], ownership, "pre-discovery module logs must be unconsumed ones only");
            }
        }
        assertTrue(discoveryIndex != type(uint256).max, "GovernedInstanceCreated must be emitted");
        assertTrue(bindingIndex != type(uint256).max, "the snapshot binding must be announced");
        assertLt(
            discoveryIndex, bindingIndex, "an indexer must learn the module exists before its binding announcement"
        );
        assertTrue(MerkleGovModule(module).initialBindingPublished(), "one-shot publisher consumed");
        vm.expectRevert(MerkleGovModule.AlreadyInitialized.selector);
        MerkleGovModule(module).publishInitialSnapshotBinding();
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
            ISignerSyncCheckpointSource(created.snapshot),
            ISignerActivitySource(address(gov)),
            MerkleSnapshot(created.snapshot).paramsHash(),
            5,
            2,
            5_000,
            151_200,
            2
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
