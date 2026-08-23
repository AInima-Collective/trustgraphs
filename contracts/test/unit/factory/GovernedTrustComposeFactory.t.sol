// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {MultiSend} from "@gnosis.pm/safe-contracts/libraries/MultiSend.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {GovernedTrustComposeFactory} from "src/factory/GovernedTrustComposeFactory.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {TrustComposeParamsController} from "src/factory/TrustComposeParamsController.sol";
import {
    CompositionSourceAccumulatorDeployer,
    TrustComposeParamsControllerDeployer
} from "src/factory/TrustComposeInstanceDeployers.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
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

import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../../mocks/MockEthUsdFeed.sol";

contract ComposeProgramVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

contract ComposeFactorySignerVerifier is IZkVerifier {
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

/// @notice The `GovernedTrustgraphsFactory` battery, mirrored onto the trust-compose wrapper.
///         The program-specific twist under test: trust-compose is FLAT-BANDED at 3 in the vault,
///         so the wrapper must derive the newborn band from `bandOf` — a copied "band 1" literal
///         would price against a band this program never uses.
contract GovernedTrustComposeFactoryTest is Test {
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    uint64 internal constant SCALE = 1e18;
    uint48 internal constant DELAY = 2 days;
    uint64 internal constant MAX_AGE = 500;
    uint64 internal constant EPOCH_FLOOR = 3;
    bytes32 internal constant SOURCE_PROGRAM = keccak256("trust-graph-weighted");
    bytes32 internal constant COMPOSE_VKEY = keccak256("composition vkey");
    bytes32 internal constant SOURCE_VKEY = keccak256("source vkey");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    address internal constant REGISTRY_ADMIN = address(0xBE7);

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    ComposeProgramVerifier internal sourceVerifier;
    ComposeProgramVerifier internal composeVerifier;
    TrustComposeFactory internal factory;
    ProvingVault internal vault;
    TestUSDC internal usdc;
    MockEthUsdFeed internal feed;

    GovernedTrustComposeFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GovernedAuthorityDeployer internal authorityDeployer;
    SignerSyncModuleDeployer internal signerSyncDeployer;
    MerkleGovModuleDeployer internal govModuleDeployer;

    MerkleSnapshot[] internal sourceSnapshots;
    MockAccumulator[] internal sourceAccumulators;
    address[] internal sourceAdapters;

    address internal creator = address(0xA11CE);
    uint256 internal baselineInstanceCount;

    function setUp() public {
        registry = new InstanceRegistry(REGISTRY_ADMIN);
        adapterFactory = new CompositionSourceAdapterFactory();
        sourceVerifier = new ComposeProgramVerifier(SOURCE_VKEY);
        composeVerifier = new ComposeProgramVerifier(COMPOSE_VKEY);
        usdc = new TestUSDC();
        feed = new MockEthUsdFeed();
        vault = new ProvingVault(
            IInstanceRegistry(address(registry)), usdc, feed, 1 hours, 100e8, 100_000e8, address(this), address(this)
        );
        factory = new TrustComposeFactory(
            composeVerifier,
            COMPOSE_VKEY,
            registry,
            adapterFactory,
            new MerkleSnapshotDeployer(),
            new MerkleFundDistributorDeployer(),
            new CompositionSourceAccumulatorDeployer(),
            new TrustComposeParamsControllerDeployer(),
            EPOCH_FLOOR,
            DELAY,
            vault
        );
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.startPrank(REGISTRY_ADMIN);
        registry.grantRole(registrarRole, address(factory));
        // Source registrations below go through the registry admin's own registrar grant.
        registry.grantRole(registrarRole, address(this));
        vm.stopPrank();

        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        authorityDeployer = new GovernedAuthorityDeployer();
        signerSyncDeployer = new SignerSyncModuleDeployer();
        govModuleDeployer = new MerkleGovModuleDeployer();
        governedFactory = new GovernedTrustComposeFactory(
            factory, safeFactory, address(safeSingleton), authorityDeployer, signerSyncDeployer, govModuleDeployer
        );

        _createSources(2);
        baselineInstanceCount = registry.instanceCount();
    }

    /*//////////////////////////////////////////////////////////////
                              THE BATTERY
    //////////////////////////////////////////////////////////////*/

    function test_CreateGovernedInstanceMakesSafeTheAuthorityFromGenesis() public {
        TrustComposeFactory.CreateArgs memory args = _args("member-owned composition");
        args.admin = address(0xBAD); // ignored: governed creation is never EOA-administered
        args.withDistributor = true;
        args.salt = bytes32(uint256(7));

        vm.recordLogs();
        vm.prank(creator);
        (bytes32 instanceId, address safe, address module, address snapshot) = _createGoverned(args, _unpaidPolicy());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (address eventAdmin, address distributor) = _decodeCreated(logs, instanceId);
        address controller = registry.paramsAuthority(instanceId);

        assertEq(factory.computeInstanceId(safe, args.name, args.salt), instanceId, "the Safe is the creator");
        assertEq(eventAdmin, safe, "the Safe must hold every instance authority");
        assertEq(registry.getInstance(instanceId).snapshot, snapshot, "wrapper discovered the wrong snapshot");
        assertEq(registry.getInstance(instanceId).program, keccak256("trust-compose"));

        assertEq(TrustComposeParamsController(controller).owner(), safe, "Safe must own the policy controller");
        assertEq(MerkleFundDistributor(payable(distributor)).owner(), safe, "Safe must own the shared fund");
        assertTrue(
            MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), safe),
            "Safe must hold constitutional authority"
        );
        assertTrue(MerkleSnapshot(snapshot).provenanceEnabled(), "compose provenance is mandatory");

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
        assertFalse(GnosisSafe(payable(safe)).isOwner(address(governedFactory)), "wrapper retained Safe ownership");

        GovernedTrustComposeFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        assertEq(authority.safe, safe, "authority Safe");
        assertEq(authority.governanceModule, module, "authority governance module");
        assertEq(authority.initialRecoveryProposer, creator, "authority recovery proposer");
        assertEq(authority.recoveryDelay, 14 days, "authority recovery delay");
        assertTrue(SafeExecutionGuard(authority.executionGuard).isSealed(), "owner route must be sealed");
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
        TrustComposeFactory.CreateArgs memory args = _args("inert governed composition");
        args.withDistributor = true;
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshotAddress) = _createGoverned(args, _unpaidPolicy());
        MerkleSnapshot snapshot = MerkleSnapshot(snapshotAddress);

        address[5] memory nobodies = [
            address(factory),
            address(governedFactory),
            address(govModuleDeployer),
            address(authorityDeployer),
            address(signerSyncDeployer)
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
        assertTrue(registry.hasRole(registry.REGISTRAR_ROLE(), address(factory)), "base factory keeps REGISTRAR");
        assertFalse(registry.hasRole(registry.REGISTRAR_ROLE(), address(governedFactory)), "no new grants");
        assertFalse(registry.hasRole(registry.OPERATOR_ROLE(), address(governedFactory)), "wrapper cannot rewrite");
    }

    function test_GovernedComposeContractsHaveExplicitEip170Headroom() public view {
        assertLt(address(governedFactory).code.length, 24_576);
        assertLt(address(govModuleDeployer).code.length, 24_576);
        assertGt(24_576 - address(governedFactory).code.length, 3_000, "wrapper runtime margin");
        assertGt(24_576 - address(govModuleDeployer).code.length, 3_000, "gov module deployer runtime margin");
    }

    function test_DiscoveryEventPrecedesEveryGovModuleLog() public {
        TrustComposeFactory.CreateArgs memory args = _args("ordered compose discovery");
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
                    && logs[i].topics[0] == GovernedTrustComposeFactory.GovernedInstanceCreated.selector
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
        bytes32 signerVKey = keccak256("compose factory signer guest");
        ComposeFactorySignerVerifier signerVerifier = new ComposeFactorySignerVerifier(signerVKey);
        GovernedTrustComposeFactory.SignerSyncConfig memory signerConfig = GovernedTrustComposeFactory.SignerSyncConfig({
            enabled: true,
            verifier: address(signerVerifier),
            programVKey: signerVKey,
            topN: 5,
            minThreshold: 2,
            targetThresholdBps: 5000
        });

        TrustComposeFactory.CreateArgs memory args = _args("compose signer sync");
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) =
            governedFactory.createGovernedInstance(args, _unpaidPolicy(), signerConfig);

        GovernedTrustComposeFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        SignerSyncZkModule signer = SignerSyncZkModule(authority.signerSyncModule);
        assertTrue(address(signer) != address(0), "signer module must be discoverable from authorityOf");
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(address(signer)), "signer module must be enabled");
        assertEq(signer.owner(), safe, "selection/verifier changes must be governed by the Safe");
        assertEq(address(signer.scoreSnapshot()), snapshot, "signer checkpoint source");
        assertEq(address(signer.accumulator()), address(MerkleSnapshot(snapshot).accumulator()), "signer accumulator");

        MerkleSnapshot scoreSnapshot = MerkleSnapshot(snapshot);
        vm.roll(uint256(scoreSnapshot.epochOriginBlock()) + EPOCH_FLOOR + 100);
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
        bytes32 activityAcc = keccak256("compose factory activity");
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

        vm.prank(address(0xBEEF));
        signer.submitSignerProof(checkpointId, 0, desired, 2, hex"1234");

        assertTrue(GnosisSafe(payable(safe)).isOwner(desired[0]));
        assertTrue(GnosisSafe(payable(safe)).isOwner(desired[1]));
        assertFalse(GnosisSafe(payable(safe)).isOwner(creator));
        assertEq(GnosisSafe(payable(safe)).getThreshold(), 2);
    }

    function test_OptionalSignerRejectsVerifierProgramMismatchAtomically() public {
        bytes32 verifierVKey = keccak256("deployed compose signer guest");
        bytes32 suppliedVKey = keccak256("different compose signer guest");
        ComposeFactorySignerVerifier signerVerifier = new ComposeFactorySignerVerifier(verifierVKey);
        GovernedTrustComposeFactory.SignerSyncConfig memory signerConfig = GovernedTrustComposeFactory.SignerSyncConfig({
            enabled: true,
            verifier: address(signerVerifier),
            programVKey: suppliedVKey,
            topN: 5,
            minThreshold: 2,
            targetThresholdBps: 5000
        });

        // Built BEFORE expectRevert: the args builder reads the adapters externally, and the
        // cheatcode would otherwise attach to that staticcall instead of the factory call.
        TrustComposeFactory.CreateArgs memory args = _args("mismatched compose signer");
        GovernedTrustComposeFactory.InitialPolicy memory policy = _unpaidPolicy();
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignerSyncModuleDeployer.SignerProgramVKeyMismatch.selector, suppliedVKey, verifierVKey
            )
        );
        governedFactory.createGovernedInstance(args, policy, signerConfig);
        assertEq(registry.instanceCount(), baselineInstanceCount, "invalid signer identity must roll back creation");
    }

    function test_OptionalSignerRejectsUnsafeSelectionAtomically() public {
        bytes32 signerVKey = keccak256("compose factory signer guest");
        ComposeFactorySignerVerifier signerVerifier = new ComposeFactorySignerVerifier(signerVKey);
        GovernedTrustComposeFactory.SignerSyncConfig memory signerConfig = GovernedTrustComposeFactory.SignerSyncConfig({
            enabled: true,
            verifier: address(signerVerifier),
            programVKey: signerVKey,
            topN: 65,
            minThreshold: 2,
            targetThresholdBps: 5000
        });

        TrustComposeFactory.CreateArgs memory args = _args("unsafe compose selection");
        GovernedTrustComposeFactory.InitialPolicy memory policy = _unpaidPolicy();
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignerSyncModuleDeployer.InvalidSignerSelection.selector, uint32(65), uint32(2), uint32(5000)
            )
        );
        governedFactory.createGovernedInstance(args, policy, signerConfig);
        assertEq(registry.instanceCount(), baselineInstanceCount, "invalid signer policy must roll back creation");
    }

    function test_CreatorCannotExecuteAnyOwnerTransactionAfterAtomicGraduation() public {
        TrustComposeFactory.CreateArgs memory args = _args("sealed compose owner route");
        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = _createGoverned(args, _unpaidPolicy());
        GovernedTrustComposeFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
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
        TrustComposeFactory.CreateArgs memory args = _args("compose delayed recovery");
        vm.prank(creator);
        (bytes32 instanceId,,, address snapshot) = _createGoverned(args, _unpaidPolicy());
        DelayedRecoveryModule recovery = DelayedRecoveryModule(governedFactory.authorityOf(instanceId).recoveryModule);

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
        TrustComposeFactory.CreateArgs memory args = _args("compose recovery veto");
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
        TrustComposeFactory.CreateArgs memory args = _args("compose recovery batch");
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

    function test_CreateGovernedInstanceForwardsPrepayAndInstallsPayablePolicyThroughSafe() public {
        TrustComposeFactory.CreateArgs memory args = _args("member funded composition");
        uint96 cap = 25e8;
        // Trust-compose is FLAT-BANDED: the vault answers 3 for a newborn instance, and the
        // wrapper must price against THAT band. This is the line a hardcoded literal breaks.
        assertEq(vault.bandOf(factory.PROGRAM(), 0, 0), 3, "compose is flat-banded at 3");
        vault.setFeePerRootUsd(factory.PROGRAM(), 3, 5e8);
        vm.deal(creator, 3 ether);

        vm.prank(creator);
        (bytes32 instanceId, address safe,,) = governedFactory.createGovernedInstance{value: 3 ether}(
            args,
            GovernedTrustComposeFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: cap}),
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
    }

    function test_CreateGovernedInstanceRejectsPrepayWithoutPolicy() public {
        TrustComposeFactory.CreateArgs memory args = _args("compose disabled prepay");
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(GovernedTrustComposeFactory.PrepayRequiresPolicy.selector);
        governedFactory.createGovernedInstance{value: 1 ether}(args, _unpaidPolicy(), _noSigner());
        assertEq(registry.instanceCount(), baselineInstanceCount, "invalid prepay must create nothing");
    }

    function test_CreateGovernedInstanceRejectsPolicyWithoutPrepay() public {
        TrustComposeFactory.CreateArgs memory args = _args("compose unfunded policy");
        vm.prank(creator);
        vm.expectRevert(GovernedTrustComposeFactory.PolicyRequiresPrepay.selector);
        governedFactory.createGovernedInstance(
            args,
            GovernedTrustComposeFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8}),
            _noSigner()
        );
        assertEq(registry.instanceCount(), baselineInstanceCount, "unfunded policy must create nothing");
    }

    function test_CreateGovernedInstanceRequiresAPricedInitialBand() public {
        TrustComposeFactory.CreateArgs memory args = _args("compose unpriced prepay");
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        // The error names band 3 — proof the wrapper asked the vault instead of assuming band 1.
        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustComposeFactory.InitialFeeUnpriced.selector, factory.PROGRAM(), uint8(3))
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustComposeFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8}),
            _noSigner()
        );
    }

    function test_CreateGovernedInstanceBoundsInitialPaidTerms() public {
        TrustComposeFactory.CreateArgs memory args = _args("compose unsafe policy");
        vault.setFeePerRootUsd(factory.PROGRAM(), 3, 5e8);
        vm.deal(creator, 2 ether);

        vm.startPrank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedTrustComposeFactory.InitialPaidIntervalTooShort.selector, EPOCH_FLOOR - 1, EPOCH_FLOOR
            )
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustComposeFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR - 1, maxPerRootUsd: 25e8}),
            _noSigner()
        );

        uint96 maximum = governedFactory.MAX_INITIAL_MAX_PER_ROOT_USD();
        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustComposeFactory.InitialCapTooHigh.selector, maximum + 1, maximum)
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustComposeFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: maximum + 1}),
            _noSigner()
        );

        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustComposeFactory.InitialCapBelowFee.selector, uint96(4e8), uint256(5e8))
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustComposeFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 4e8}),
            _noSigner()
        );
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _unpaidPolicy() internal pure returns (GovernedTrustComposeFactory.InitialPolicy memory) {
        return GovernedTrustComposeFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
    }

    function _noSigner() internal pure returns (GovernedTrustComposeFactory.SignerSyncConfig memory) {
        return GovernedTrustComposeFactory.SignerSyncConfig({
            enabled: false,
            verifier: address(0),
            programVKey: bytes32(0),
            topN: 0,
            minThreshold: 0,
            targetThresholdBps: 0
        });
    }

    function _createGoverned(
        TrustComposeFactory.CreateArgs memory args,
        GovernedTrustComposeFactory.InitialPolicy memory policy
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
                    || entry.topics[0] != TrustComposeFactory.TrustComposeInstanceCreated.selector
                    || entry.topics[1] != instanceId
            ) continue;
            admin = address(uint160(uint256(entry.topics[3])));
            (,,,, distributor,,,,,) = abi.decode(
                entry.data,
                (
                    string,
                    string,
                    address,
                    address,
                    address,
                    address,
                    uint64,
                    bytes32,
                    bytes32,
                    TrustComposeParamsCodec.Params
                )
            );
            return (admin, distributor);
        }
        revert("TrustComposeInstanceCreated was not emitted");
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

    function _createSources(uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            MockAccumulator sourceAccumulator = new MockAccumulator();
            MerkleSnapshot sourceSnapshot = new MerkleSnapshot(
                sourceVerifier,
                keccak256(abi.encode("source params", i)),
                sourceAccumulator,
                address(this),
                address(this)
            );
            sourceSnapshot.enableStateProvenance();
            bytes32 sourceInstanceId = bytes32(i + 1);
            registry.registerWithParamsAuthority(
                sourceInstanceId,
                IInstanceRegistry.Instance({
                    program: SOURCE_PROGRAM,
                    snapshot: address(sourceSnapshot),
                    verifier: address(sourceVerifier),
                    registryOrAccumulator: address(sourceAccumulator),
                    paramsHash: sourceSnapshot.paramsHash()
                }),
                address(this)
            );
            sourceAccumulator.setState(keccak256(abi.encode("acc", i)), uint64(i + 1));
            vm.roll(10);
            uint256 checkpoint = sourceSnapshot.trigger();
            sourceSnapshot.submitProof(
                checkpoint,
                keccak256(abi.encode("root", i)),
                sha256(abi.encode("blob", i)),
                string.concat("bafk-source-", vm.toString(i)),
                1_000 + i,
                bytes32(0),
                address(0),
                ""
            );
            CompositionSourceAdapter adapter = adapterFactory.create(
                registry,
                sourceInstanceId,
                bytes32(i + 1),
                FAMILY,
                OUTPUT_KIND,
                keccak256(abi.encode("deployment provenance", i))
            );
            sourceSnapshots.push(sourceSnapshot);
            sourceAccumulators.push(sourceAccumulator);
            sourceAdapters.push(address(adapter));
        }
    }

    function _args(string memory name) internal view returns (TrustComposeFactory.CreateArgs memory args) {
        args.name = name;
        args.metadataURI = "ipfs://governed-composition-metadata";
        args.params = _params(MAX_AGE);
        args.policyManifest = _policyManifest(2, MAX_AGE);
        args.sourceAdapters = _adapterSlice(2);
        args.metadataDigest = keccak256("review packet");
        args.epochLength = EPOCH_FLOOR;
    }

    function _params(uint64 maxAge) internal pure returns (TrustComposeParamsCodec.Params memory p) {
        p.version = 1;
        p.programId = keccak256("trust-compose");
        p.scopeHash = keccak256("governance-allocation");
        p.identityDomain = keccak256("eip155-address");
        p.outputKind = OUTPUT_KIND;
        p.outputDomain = keccak256("trustgraphs.output.trust-compose-account.v1");
        p.admittedProgramId = SOURCE_PROGRAM;
        p.weightScale = SCALE;
        p.outputPool = 1_000_000;
        p.maxSources = 8;
        p.maxEntriesPerSource = 4_096;
        p.maxAggregateEntries = 8_192;
        p.maxUnionAccounts = 8_192;
        p.maxAggregateBlobBytes = 1_048_576;
        p.maxSourceAgeBlocks = maxAge;
    }

    function _adapterSlice(uint256 count) internal view returns (address[] memory adapters) {
        adapters = new address[](count);
        for (uint256 i; i < count; ++i) {
            adapters[i] = sourceAdapters[i];
        }
    }

    function _policyManifest(uint256 count, uint64 maxAge) internal view returns (bytes memory manifest) {
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(count));
        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint64 weight = uint64(base + (i < remainder ? 1 : 0));
            CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[i]);
            manifest = bytes.concat(
                manifest,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    adapter.programId(),
                    weight,
                    maxAge,
                    uint8(1)
                )
            );
        }
    }
}
