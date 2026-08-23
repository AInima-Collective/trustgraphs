// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";

/// A registry the attacker deploys and fully controls. The adapter factory must reject it because
/// it is not the immutable canonical registry selected at factory deployment.
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
    AttackerRegistry internal canonicalRegistry;
    CompositionSourceAdapterFactory internal adapterFactory;
    CompositionSourceAccumulator internal accumulator;

    bytes32 internal constant ALLOCATION = keccak256("allocation");
    bytes32 internal constant ADMITTED = keccak256("trust-graph");

    function setUp() public {
        canonicalRegistry = new AttackerRegistry();
        adapterFactory = new CompositionSourceAdapterFactory(IInstanceRegistry(address(canonicalRegistry)));
        accumulator =
            new CompositionSourceAccumulator(ICompositionSourceAdapterFactory(address(adapterFactory)), address(this));
    }

    function _rogueSource(bytes32 sourceId)
        internal
        returns (AttackerRegistry rogueRegistry, bytes32 instanceId, address snapshot)
    {
        AttackerVerifier v = new AttackerVerifier();
        AttackerSnapshot s = new AttackerSnapshot(address(v), v.programVKey());
        rogueRegistry = new AttackerRegistry();
        instanceId = keccak256(abi.encode(sourceId, "rogue"));
        rogueRegistry.set(
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
        snapshot = address(s);
    }

    function test_rogueRegistryCannotYieldAuthenticatedAdapter() public {
        (AttackerRegistry rogue, bytes32 instanceId,) = _rogueSource(bytes32(uint256(1)));

        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAdapterFactory.ForeignRegistry.selector, address(canonicalRegistry), address(rogue)
            )
        );
        adapterFactory.create(
            IInstanceRegistry(address(rogue)),
            instanceId,
            bytes32(uint256(1)),
            keccak256("fam"),
            ALLOCATION,
            bytes32(uint256(7))
        );
    }

    /// A directly deployed lookalike can still read an attacker registry, but the accumulator's
    /// factory-authenticity gate rejects it because the pinned factory never recorded it.
    function test_accumulatorRejectsDirectAdapterOverRogueRegistry() public {
        (AttackerRegistry rogue1, bytes32 instanceId1, address snapshot1) = _rogueSource(bytes32(uint256(1)));
        (AttackerRegistry rogue2, bytes32 instanceId2, address snapshot2) = _rogueSource(bytes32(uint256(2)));
        CompositionSourceAdapter lookalike1 = new CompositionSourceAdapter(
            IInstanceRegistry(address(rogue1)),
            instanceId1,
            bytes32(uint256(1)),
            keccak256("famA"),
            ALLOCATION,
            bytes32(uint256(7))
        );
        CompositionSourceAdapter lookalike2 = new CompositionSourceAdapter(
            IInstanceRegistry(address(rogue2)),
            instanceId2,
            bytes32(uint256(2)),
            keccak256("famB"),
            ALLOCATION,
            bytes32(uint256(8))
        );

        bytes memory manifest = abi.encodePacked(
            bytes4(0x54474350), // "TGCP"
            uint16(1),
            uint64(block.chainid),
            uint8(2)
        );
        manifest = bytes.concat(
            manifest,
            abi.encodePacked(
                bytes32(uint256(1)), snapshot1, keccak256("famA"), ADMITTED, uint64(5e17), uint64(1000), uint8(1)
            ),
            abi.encodePacked(
                bytes32(uint256(2)), snapshot2, keccak256("famB"), ADMITTED, uint64(5e17), uint64(1000), uint8(1)
            )
        );

        address[] memory adapters = new address[](2);
        adapters[0] = address(lookalike1);
        adapters[1] = address(lookalike2);

        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAccumulator.UnauthenticatedAdapter.selector, uint8(0), address(lookalike1)
            )
        );
        accumulator.validatePolicy(manifest, adapters);
    }
}
