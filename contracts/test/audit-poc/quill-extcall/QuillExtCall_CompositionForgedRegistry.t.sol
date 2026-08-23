// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {
    CompositionSourceAccumulatorDeployer,
    TrustComposeParamsControllerDeployer
} from "src/factory/TrustComposeInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
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
    uint48 internal constant DELAY = 2 days;
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

    address internal attacker = address(0xBADBEEF);

    function setUp() public {
        realRegistry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(realRegistry);
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

    /// The factory authenticates only adapters minted from the canonical registry it pinned at
    /// deployment, so attacker-authored registry/snapshot/verifier contracts cannot enter the
    /// shared authenticity ledger.
    function test_ForgedRegistryCannotYieldAFactoryBlessedAdapter() public {
        vm.startPrank(attacker);
        ForgedSnapshot forged = new ForgedSnapshot(address(forgedSourceVerifier), keccak256("forged root"), 1_000_000);
        bytes32 sourceInstanceId = bytes32(uint256(1));
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

        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAdapterFactory.ForeignRegistry.selector, address(realRegistry), address(forgedRegistry)
            )
        );
        adapterFactory.create(
            IInstanceRegistry(address(forgedRegistry)),
            sourceInstanceId,
            bytes32(uint256(1)),
            FAMILY,
            OUTPUT_KIND,
            keccak256("deployment provenance")
        );
        vm.stopPrank();
        assertFalse(realRegistry.isRegistered(sourceInstanceId), "forged row never entered the canonical registry");
    }
}
