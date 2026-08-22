// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {MultiSend} from "@gnosis.pm/safe-contracts/libraries/MultiSend.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {GovernedWeightedTrustgraphsFactory} from "src/factory/GovernedWeightedTrustgraphsFactory.sol";
import {WeightedPriorParamsController} from "src/factory/WeightedPriorParamsController.sol";
import {WeightedPriorParamsControllerDeployer} from "src/factory/WeightedInstanceDeployers.sol";
import {WeightedTrustgraphsFactory} from "src/factory/WeightedTrustgraphsFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {ProvingVault} from "src/vault/ProvingVault.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";
import {SafeExecutionGuard} from "src/zodiac/SafeExecutionGuard.sol";
import {SignerSyncZkModule} from "src/zodiac/SignerSyncZkModule.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";
import {MockEthUsdFeed} from "../../mocks/MockEthUsdFeed.sol";

contract WeightedFactorySignerVerifier is IZkVerifier {
    bytes32 public immutable programVKey;
    bytes32 public expectedDigest;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function setExpectedDigest(bytes32 digest) external {
        expectedDigest = digest;
    }

    function verify(bytes calldata, bytes32 digest) external view {
        require(expectedDigest == bytes32(0) || digest == expectedDigest, "signer verifier: digest mismatch");
    }
}

/// @notice The `GovernedTrustgraphsFactory` battery, mirrored onto the weighted wrapper: the Safe
///         is the creator/admin/authority from genesis, the sealed guard + delayed recovery hold,
///         the vault prices the program through `bandOf` (never a literal), and the module's
///         snapshot-binding announcement follows the wrapper's discovery event.
contract GovernedWeightedTrustgraphsFactoryTest is Test {
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    uint256 internal constant SCALE = 1e18;
    uint64 internal constant EPOCH_FLOOR = 5;
    uint48 internal constant ACTIVATION_DELAY = 2 days;
    address internal constant REGISTRY_ADMIN = address(0xBE7);

    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    SchemaRegistrar internal schemaRegistrar;
    MockZkVerifier internal verifier;
    InstanceRegistry internal registry;
    MerkleSnapshotDeployer internal snapshotDeployer;
    MerkleFundDistributorDeployer internal distributorDeployer;
    WeightedPriorParamsControllerDeployer internal controllerDeployer;
    WeightedTrustgraphsFactory internal factory;
    ProvingVault internal vault;
    TestUSDC internal usdc;
    MockEthUsdFeed internal feed;

    GovernedWeightedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GovernedAuthorityDeployer internal authorityDeployer;
    SignerSyncModuleDeployer internal signerSyncDeployer;
    MerkleGovModuleDeployer internal govModuleDeployer;

    address internal creator = address(0xA11CE);

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        schemaRegistrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        verifier = new MockZkVerifier();
        registry = new InstanceRegistry(REGISTRY_ADMIN);
        snapshotDeployer = new MerkleSnapshotDeployer();
        distributorDeployer = new MerkleFundDistributorDeployer();
        controllerDeployer = new WeightedPriorParamsControllerDeployer();
        usdc = new TestUSDC();
        feed = new MockEthUsdFeed();
        vault = new ProvingVault(
            IInstanceRegistry(address(registry)), usdc, feed, 1 hours, 100e8, 100_000e8, address(this), address(this)
        );
        factory = new WeightedTrustgraphsFactory(
            IEAS(address(eas)),
            schemaRegistrar,
            IZkVerifier(address(verifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            controllerDeployer,
            EPOCH_FLOOR,
            ACTIVATION_DELAY,
            vault
        );
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.prank(REGISTRY_ADMIN);
        registry.grantRole(registrarRole, address(factory));

        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        authorityDeployer = new GovernedAuthorityDeployer();
        signerSyncDeployer = new SignerSyncModuleDeployer();
        govModuleDeployer = new MerkleGovModuleDeployer();
        governedFactory = new GovernedWeightedTrustgraphsFactory(
            factory, safeFactory, address(safeSingleton), authorityDeployer, signerSyncDeployer, govModuleDeployer
        );
    }

    /*//////////////////////////////////////////////////////////////
                              THE BATTERY
    //////////////////////////////////////////////////////////////*/

    function test_CreateGovernedInstanceMakesSafeTheAuthorityFromGenesis() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("member-owned weighted", 3);
        args.admin = address(0xBAD); // ignored: governed creation is never EOA-administered
        args.withDistributor = true;
        args.salt = bytes32(uint256(7));

        vm.recordLogs();
        vm.prank(creator);
        (bytes32 instanceId, address safe, address module, address snapshot) = _createGoverned(args, _unpaidPolicy());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (address eventAdmin, address distributor) = _decodeCreated(logs, instanceId);
        address controller = _decodeController(logs, instanceId);

        assertEq(factory.computeInstanceId(safe, args.name, args.salt), instanceId, "the Safe is the creator");
        assertEq(eventAdmin, safe, "the Safe must hold every instance authority");
        assertEq(registry.getInstance(instanceId).snapshot, snapshot, "wrapper discovered the wrong snapshot");
        assertEq(registry.getInstance(instanceId).program, keccak256("trust-graph-weighted"));

        assertEq(WeightedPriorParamsController(controller).owner(), safe, "Safe must own the prior controller");
        assertEq(MerkleFundDistributor(payable(distributor)).owner(), safe, "Safe must own the shared fund");
        assertTrue(
            MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), safe),
            "Safe must hold constitutional authority"
        );
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

        GovernedWeightedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
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

    function test_FactoryWrapperAndDeployersAreInertAfterCreation() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("inert governed weighted", 2);
        args.withDistributor = true;
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshotAddress) = _createGoverned(args, _unpaidPolicy());
        MerkleSnapshot snapshot = MerkleSnapshot(snapshotAddress);

        address[6] memory nobodies = [
            address(factory),
            address(governedFactory),
            address(snapshotDeployer),
            address(controllerDeployer),
            address(govModuleDeployer),
            address(authorityDeployer)
        ];
        for (uint256 i = 0; i < nobodies.length; i++) {
            assertFalse(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), nobodies[i]), "holds constitutional");
            assertFalse(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), nobodies[i]), "holds operational");
            assertFalse(snapshot.hasRole(snapshot.DEFAULT_ADMIN_ROLE(), nobodies[i]), "holds default admin");
        }
        assertTrue(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), safe), "Safe holds constitutional");
        assertTrue(
            snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), registry.paramsAuthority(instanceId)),
            "controller holds operational"
        );
        // The base factory keeps its ONLY privilege (append rows); the wrapper has none at all.
        assertTrue(registry.hasRole(registry.REGISTRAR_ROLE(), address(factory)), "base factory keeps REGISTRAR");
        assertFalse(registry.hasRole(registry.REGISTRAR_ROLE(), address(governedFactory)), "no new grants");
        assertFalse(registry.hasRole(registry.OPERATOR_ROLE(), address(governedFactory)), "wrapper cannot rewrite");
    }

    function test_GovernedWeightedContractsHaveExplicitEip170Headroom() public view {
        assertLt(address(governedFactory).code.length, 24_576);
        assertLt(address(govModuleDeployer).code.length, 24_576);
        assertGt(24_576 - address(governedFactory).code.length, 3_000, "wrapper runtime margin");
        assertGt(24_576 - address(govModuleDeployer).code.length, 3_000, "gov module deployer runtime margin");
    }

    function test_DiscoveryEventPrecedesEveryGovModuleLog() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("ordered weighted discovery", 2);
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
                    && logs[i].topics[0] == GovernedWeightedTrustgraphsFactory.GovernedInstanceCreated.selector
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
        assertLt(discoveryIndex, bindingIndex, "discovery must precede the binding announcement");
    }

    function test_CreateDiscoverAndApplyOptionalSignerSyncWithoutConfigEdit() public {
        bytes32 signerVKey = keccak256("weighted factory signer guest");
        WeightedFactorySignerVerifier signerVerifier = new WeightedFactorySignerVerifier(signerVKey);
        GovernedWeightedTrustgraphsFactory.SignerSyncConfig memory signerConfig =
        GovernedWeightedTrustgraphsFactory.SignerSyncConfig({
            enabled: true,
            verifier: address(signerVerifier),
            programVKey: signerVKey,
            topN: 5,
            minThreshold: 1,
            targetThresholdBps: 5000
        });

        WeightedTrustgraphsFactory.CreateArgs memory args = _args("weighted signer sync", 2);
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) =
            governedFactory.createGovernedInstance(args, _unpaidPolicy(), signerConfig);

        GovernedWeightedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        SignerSyncZkModule signer = SignerSyncZkModule(authority.signerSyncModule);
        assertTrue(address(signer) != address(0), "signer module must be discoverable from authorityOf");
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(address(signer)), "signer module must be enabled");
        assertEq(signer.owner(), safe, "selection/verifier changes must be governed by the Safe");
        assertEq(address(signer.scoreSnapshot()), snapshot, "signer checkpoint source");
        assertEq(address(signer.accumulator()), address(MerkleSnapshot(snapshot).accumulator()), "signer accumulator");

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
        signerVerifier.setExpectedDigest(
            keccak256(
                abi.encode(
                    checkpoint.acc,
                    checkpoint.leafCount,
                    scoreSnapshot.checkpointParamsHash(checkpointId),
                    signer.selectionParamsHash(),
                    signerSetRoot,
                    uint256(2),
                    keccak256(abi.encode(address(signer), block.chainid))
                )
            )
        );

        vm.prank(address(0xBEEF));
        signer.submitSignerProof(checkpointId, desired, 2, hex"1234");

        assertTrue(GnosisSafe(payable(safe)).isOwner(desired[0]));
        assertTrue(GnosisSafe(payable(safe)).isOwner(desired[1]));
        assertFalse(GnosisSafe(payable(safe)).isOwner(creator));
        assertEq(GnosisSafe(payable(safe)).getThreshold(), 2);
    }

    function test_OptionalSignerRejectsVerifierProgramMismatchAtomically() public {
        bytes32 verifierVKey = keccak256("deployed weighted signer guest");
        bytes32 suppliedVKey = keccak256("different weighted signer guest");
        WeightedFactorySignerVerifier signerVerifier = new WeightedFactorySignerVerifier(verifierVKey);
        GovernedWeightedTrustgraphsFactory.SignerSyncConfig memory signerConfig =
        GovernedWeightedTrustgraphsFactory.SignerSyncConfig({
            enabled: true,
            verifier: address(signerVerifier),
            programVKey: suppliedVKey,
            topN: 5,
            minThreshold: 1,
            targetThresholdBps: 5000
        });

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignerSyncModuleDeployer.SignerProgramVKeyMismatch.selector, suppliedVKey, verifierVKey
            )
        );
        governedFactory.createGovernedInstance(_args("mismatched weighted signer", 2), _unpaidPolicy(), signerConfig);
        assertEq(registry.instanceCount(), 0, "invalid signer identity must roll back base creation");
    }

    function test_OptionalSignerRejectsUnsafeSelectionAtomically() public {
        bytes32 signerVKey = keccak256("weighted factory signer guest");
        WeightedFactorySignerVerifier signerVerifier = new WeightedFactorySignerVerifier(signerVKey);
        GovernedWeightedTrustgraphsFactory.SignerSyncConfig memory signerConfig =
        GovernedWeightedTrustgraphsFactory.SignerSyncConfig({
            enabled: true,
            verifier: address(signerVerifier),
            programVKey: signerVKey,
            topN: 65,
            minThreshold: 1,
            targetThresholdBps: 5000
        });

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignerSyncModuleDeployer.InvalidSignerSelection.selector, uint32(65), uint32(1), uint32(5000)
            )
        );
        governedFactory.createGovernedInstance(_args("unsafe weighted selection", 2), _unpaidPolicy(), signerConfig);
        assertEq(registry.instanceCount(), 0, "invalid signer policy must roll back base creation");
    }

    function test_CreatorCannotExecuteAnyOwnerTransactionAfterAtomicGraduation() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("sealed weighted owner route", 2);
        args.withDistributor = true;

        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = _createGoverned(args, _unpaidPolicy());
        GovernedWeightedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
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
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("weighted delayed recovery", 2);
        vm.prank(creator);
        (bytes32 instanceId,,, address snapshot) = _createGoverned(args, _unpaidPolicy());
        DelayedRecoveryModule recovery =
            DelayedRecoveryModule(governedFactory.authorityOf(instanceId).recoveryModule);

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
        vm.prank(address(0xE7EC));
        recovery.execute(0, snapshot, 0, data, Enum.Operation.Call);

        assertEq(MerkleSnapshot(snapshot).epochLength(), nextEpochLength, "delayed Safe action did not execute");
        assertEq(recovery.readyAt(actionId), 0, "executed recovery remained queued");
    }

    function test_RecoveryActionsCanBeCancelledByProposerOrSafe() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("weighted recovery veto", 2);
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = _createGoverned(args, _unpaidPolicy());
        DelayedRecoveryModule recovery =
            DelayedRecoveryModule(governedFactory.authorityOf(instanceId).recoveryModule);
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
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("weighted recovery batch", 2);
        vm.prank(creator);
        (bytes32 instanceId,,, address snapshot) = _createGoverned(args, _unpaidPolicy());
        DelayedRecoveryModule recovery =
            DelayedRecoveryModule(governedFactory.authorityOf(instanceId).recoveryModule);

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

    function test_CreateGovernedInstanceForwardsPrepayAndInstallsPayablePolicyThroughSafe() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("member funded weighted", 2);
        uint96 cap = 25e8;
        // Band asked of the vault, not assumed: a newborn weighted instance is sized band 1.
        assertEq(vault.bandOf(factory.PROGRAM(), 0, 0), 1, "weighted must be priced by size");
        vault.setFeePerRootUsd(factory.PROGRAM(), 1, 5e8);
        vm.deal(creator, 3 ether);

        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = governedFactory.createGovernedInstance{value: 3 ether}(
            args,
            GovernedWeightedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: cap}),
            _noSigner()
        );

        IProvingVault.Account memory account = vault.accountOf(instanceId);
        assertEq(account.ethBalance, 3 ether, "the instance tank must receive the full prepay");
        IProvingVault.Policy memory policy = vault.policyOf(instanceId);
        assertEq(policy.minPaidIntervalBlocks, EPOCH_FLOOR, "paid cadence must be installed atomically");
        assertEq(policy.maxPerRootUsd, cap, "per-root cap must be installed atomically");
        assertEq(address(vault).balance, 3 ether, "the vault holds the prepay");
        assertEq(safe.balance, 0, "the bootstrap Safe must retain nothing");
        assertEq(address(governedFactory).balance, 0, "the wrapper must retain nothing");

        MerkleSnapshot snapshotContract = MerkleSnapshot(snapshot);
        vm.roll(uint256(snapshotContract.epochOriginBlock()) + EPOCH_FLOOR);
        snapshotContract.trigger();
        IProvingVault.Quote memory quote = vault.quote(instanceId, 0);
        assertTrue(quote.eligible, "the first valid checkpoint must be payable");
    }

    function test_CreateGovernedInstanceRejectsPrepayWithoutPolicy() public {
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(GovernedWeightedTrustgraphsFactory.PrepayRequiresPolicy.selector);
        governedFactory.createGovernedInstance{value: 1 ether}(
            _args("weighted disabled prepay", 2), _unpaidPolicy(), _noSigner()
        );
        assertEq(registry.instanceCount(), 0, "invalid prepay must create nothing");
    }

    function test_CreateGovernedInstanceRejectsPolicyWithoutPrepay() public {
        vm.prank(creator);
        vm.expectRevert(GovernedWeightedTrustgraphsFactory.PolicyRequiresPrepay.selector);
        governedFactory.createGovernedInstance(
            _args("weighted unfunded policy", 2),
            GovernedWeightedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8}),
            _noSigner()
        );
        assertEq(registry.instanceCount(), 0, "unfunded policy must create nothing");
    }

    function test_CreateGovernedInstanceRequiresAPricedInitialBand() public {
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedWeightedTrustgraphsFactory.InitialFeeUnpriced.selector, factory.PROGRAM(), uint8(1)
            )
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            _args("weighted unpriced prepay", 2),
            GovernedWeightedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8}),
            _noSigner()
        );
    }

    function test_CreateGovernedInstanceBoundsInitialPaidTerms() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("weighted unsafe policy", 2);
        vault.setFeePerRootUsd(factory.PROGRAM(), 1, 5e8);
        vm.deal(creator, 2 ether);

        vm.startPrank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedWeightedTrustgraphsFactory.InitialPaidIntervalTooShort.selector, EPOCH_FLOOR - 1, EPOCH_FLOOR
            )
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedWeightedTrustgraphsFactory.InitialPolicy({
                minPaidIntervalBlocks: EPOCH_FLOOR - 1,
                maxPerRootUsd: 25e8
            }),
            _noSigner()
        );

        uint96 maximum = governedFactory.MAX_INITIAL_MAX_PER_ROOT_USD();
        vm.expectRevert(
            abi.encodeWithSelector(GovernedWeightedTrustgraphsFactory.InitialCapTooHigh.selector, maximum + 1, maximum)
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedWeightedTrustgraphsFactory.InitialPolicy({
                minPaidIntervalBlocks: EPOCH_FLOOR,
                maxPerRootUsd: maximum + 1
            }),
            _noSigner()
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedWeightedTrustgraphsFactory.InitialCapBelowFee.selector, uint96(4e8), uint256(5e8)
            )
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedWeightedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 4e8}),
            _noSigner()
        );
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _unpaidPolicy() internal pure returns (GovernedWeightedTrustgraphsFactory.InitialPolicy memory) {
        return GovernedWeightedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
    }

    function _noSigner() internal pure returns (GovernedWeightedTrustgraphsFactory.SignerSyncConfig memory) {
        return GovernedWeightedTrustgraphsFactory.SignerSyncConfig({
            enabled: false,
            verifier: address(0),
            programVKey: bytes32(0),
            topN: 0,
            minThreshold: 0,
            targetThresholdBps: 0
        });
    }

    function _createGoverned(
        WeightedTrustgraphsFactory.CreateArgs memory args,
        GovernedWeightedTrustgraphsFactory.InitialPolicy memory policy
    ) internal returns (bytes32, address, address, address) {
        return governedFactory.createGovernedInstance(args, policy, _noSigner());
    }

    function _decodeCreated(Vm.Log[] memory logs, bytes32 instanceId)
        internal
        view
        returns (address admin, address distributor)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != address(factory) || entry.topics.length != 4
                    || entry.topics[0] != WeightedTrustgraphsFactory.WeightedInstanceCreated.selector
                    || entry.topics[1] != instanceId
            ) continue;
            admin = address(uint160(uint256(entry.topics[3])));
            (,,,,, distributor,,,,) = abi.decode(
                entry.data,
                (
                    string,
                    string,
                    address,
                    bytes32,
                    address,
                    address,
                    address,
                    uint64,
                    bytes32,
                    WeightedPriorParamsCodec.Params
                )
            );
            return (admin, distributor);
        }
        revert("WeightedInstanceCreated was not emitted");
    }

    function _decodeController(Vm.Log[] memory logs, bytes32 instanceId) internal view returns (address) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(factory) && logs[i].topics.length == 3
                    && logs[i].topics[0] == WeightedTrustgraphsFactory.WeightedParamsControllerCreated.selector
                    && logs[i].topics[1] == instanceId
            ) {
                return address(uint160(uint256(logs[i].topics[2])));
            }
        }
        revert("WeightedParamsControllerCreated was not emitted");
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

    function _args(string memory name, uint256 count)
        internal
        view
        returns (WeightedTrustgraphsFactory.CreateArgs memory args)
    {
        args.name = name;
        args.metadataURI = "ipfs://weighted-governed-metadata";
        args.params.version = 1;
        args.params.dampingFp = 85e16;
        args.params.toleranceFp = 1e12;
        args.params.maxIterations = 40;
        args.params.minWeight = 0;
        args.params.maxWeight = 100;
        args.params.weightFieldIndex = 1;
        args.manifest = _manifest(count, uint64(block.chainid));
        args.epochLength = EPOCH_FLOOR;
    }

    function _manifest(uint256 count, uint64 chainId) internal pure returns (bytes memory manifest) {
        manifest = new bytes(18 + count * 28);
        manifest[0] = 0x54;
        manifest[1] = 0x47;
        manifest[2] = 0x57;
        manifest[3] = 0x50;
        manifest[5] = 0x01;
        _writeBigEndian(manifest, 6, chainId, 8);
        _writeBigEndian(manifest, 14, count, 4);

        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint256 offset = 18 + i * 28;
            address account = address(uint160(i + 1));
            uint256 weight = base + (i < remainder ? 1 : 0);
            assembly ("memory-safe") {
                mstore(add(add(manifest, 32), offset), shl(96, account))
                mstore(add(add(add(manifest, 32), offset), 20), shl(192, weight))
            }
        }
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) internal pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
