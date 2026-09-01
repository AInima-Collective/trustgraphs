// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {GovernedTrustComposeFactory} from "src/factory/GovernedTrustComposeFactory.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
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
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

import {MockAccumulator} from "../../mocks/MockAccumulator.sol";

contract ComposeProgramVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice The governed wrapper over the composition factory. This suite proves it wires a MIXED
///         standard+weighted composition to a Safe authority from genesis.
contract GovernedTrustComposeFactoryTest is Test {
    uint64 internal constant SCALE = 1e18;
    uint48 internal constant DELAY = 2 days;
    uint64 internal constant MAX_AGE = 500;
    uint64 internal constant EPOCH_FLOOR = 3;
    bytes32 internal constant COMPOSE_VKEY = keccak256("composition vkey");
    bytes32 internal constant SOURCE_VKEY = keccak256("source vkey");
    bytes32 internal constant SIGNER_VKEY = keccak256("compose factory signer guest");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    address internal constant REGISTRY_ADMIN = address(0xBE7);

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    ComposeProgramVerifier internal sourceVerifier;
    ComposeProgramVerifier internal composeVerifier;
    ComposeProgramVerifier internal signerVerifier;
    TrustComposeFactory internal factory;
    GovernedTrustComposeFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    MerkleGovModuleDeployer internal govModuleDeployer;

    MerkleSnapshot[] internal sourceSnapshots;
    MockAccumulator[] internal sourceAccumulators;
    address[] internal sourceAdapters;

    address internal creator = address(0xA11CE);

    function setUp() public {
        registry = new InstanceRegistry(REGISTRY_ADMIN);
        adapterFactory = new CompositionSourceAdapterFactory(registry);
        sourceVerifier = new ComposeProgramVerifier(SOURCE_VKEY);
        composeVerifier = new ComposeProgramVerifier(COMPOSE_VKEY);
        signerVerifier = new ComposeProgramVerifier(SIGNER_VKEY);
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
            IProvingVault(address(0))
        );
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.startPrank(REGISTRY_ADMIN);
        registry.grantRole(registrarRole, address(factory));
        registry.grantRole(registrarRole, address(this));
        vm.stopPrank();

        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        govModuleDeployer = new MerkleGovModuleDeployer();
        governedFactory = new GovernedTrustComposeFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            govModuleDeployer,
            signerVerifier,
            SIGNER_VKEY
        );

        _createSources(2);
    }

    function test_CreateGovernedMixedInstanceMakesSafeTheAuthorityFromGenesis() public {
        TrustComposeFactory.CreateArgs memory args = _args("member-owned mixed composition");
        args.admin = address(0xBAD); // ignored: governed creation is never EOA-administered
        args.withDistributor = true;
        args.salt = bytes32(uint256(7));

        vm.recordLogs();
        vm.prank(creator);
        (bytes32 instanceId, address safe, address module, address snapshot) = governedFactory.createGovernedInstance(
            args,
            GovernedFactoryBase.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}),
            GovernedFactoryBase.SignerSyncConfig({enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0})
        );
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
        assertEq(gov.merkleSnapshotContract(), snapshot, "module must vote from this network");
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(module), "governance module must be enabled");

        address[] memory owners = GnosisSafe(payable(safe)).getOwners();
        assertEq(owners.length, 1, "bootstrap owner must be removed");
        assertEq(owners[0], creator, "creator must remain the visible Safe owner");
        assertFalse(GnosisSafe(payable(safe)).isOwner(address(governedFactory)), "wrapper retained Safe ownership");
    }

    function test_GovernedComposeV2ContractsHaveExplicitEip170Headroom() public view {
        assertLt(address(governedFactory).code.length, 24_576);
        assertGt(24_576 - address(governedFactory).code.length, 3_000, "wrapper runtime margin");
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

    function _createSources(uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            bytes32 program = i % 2 == 0
                ? TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID
                : TrustComposeValidator.WEIGHTED_TRUST_GRAPH_PROGRAM_ID;
            MockAccumulator sourceAccumulator = new MockAccumulator();
            MerkleSnapshot sourceSnapshot = new MerkleSnapshot(
                sourceVerifier,
                keccak256(abi.encode("source params", i)),
                sourceAccumulator,
                address(this),
                address(this),
                ""
            );
            sourceSnapshot.enableStateProvenance();
            bytes32 sourceInstanceId = bytes32(i + 1);
            registry.registerWithParamsAuthority(
                sourceInstanceId,
                IInstanceRegistry.Instance({
                    program: program,
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
        p.sourceCompatibilityClass = TrustComposeValidator.SOURCE_COMPATIBILITY_CLASS;
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
                    TrustComposeValidator.admittedSourceOutputDomain(adapter.programId()),
                    weight,
                    maxAge,
                    uint8(1)
                )
            );
        }
    }
}
