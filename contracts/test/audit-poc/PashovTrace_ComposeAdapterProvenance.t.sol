// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";

contract PocVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 k) {
        programVKey = k;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice Audit PoC (execution-trace pass).
///
/// `CompositionSourceAdapter`'s header claims: "Instances are created only by
/// `CompositionSourceAdapterFactory`; the composition accumulator checks that append-only registry
/// so an ABI-compatible lookalike is rejected."
///
/// Regression: the shared adapter factory now pins the canonical directory immutably and refuses
/// to mint from any other registry before it can write the global `isAdapter` ledger.
contract PashovTrace_ComposeAdapterProvenance is Test {
    bytes32 internal constant SOURCE_PROGRAM = keccak256("trust-graph-weighted");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    bytes32 internal constant SOURCE_VKEY = keccak256("source vkey");

    InstanceRegistry internal canonicalRegistry;
    InstanceRegistry internal rogueRegistry; // deployed and admin'd by the attacker
    CompositionSourceAdapterFactory internal adapterFactory;
    PocVerifier internal verifier;

    address internal attacker = address(0xBAD);

    function setUp() public {
        canonicalRegistry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(canonicalRegistry);
        verifier = new PocVerifier(SOURCE_VKEY);
    }

    /// Stand up a real MerkleSnapshot with one accepted, provenance-recorded root.
    function _source(address owner_, bytes32 root, uint256 total)
        internal
        returns (MerkleSnapshot snapshot, MockAccumulator acc)
    {
        acc = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, keccak256("source params"), acc, address(this), address(this), "");
        snapshot.enableStateProvenance();
        acc.setState(keccak256(abi.encode("acc", root)), 7);
        vm.roll(block.number + 10);
        uint256 cp = snapshot.trigger();
        snapshot.submitProof(cp, root, sha256("blob"), "bafk-source", total, bytes32(0), owner_, "");
    }

    function _register(InstanceRegistry reg, bytes32 id, address snapshot, address acc) internal {
        reg.registerWithParamsAuthority(
            id,
            IInstanceRegistry.Instance({
                program: SOURCE_PROGRAM,
                snapshot: snapshot,
                verifier: address(verifier),
                registryOrAccumulator: acc,
                paramsHash: MerkleSnapshot(snapshot).paramsHash()
            }),
            address(this)
        );
    }

    function test_LookalikeAdapterOverARogueRegistryIsRejectedBeforeAuthentication() public {
        // --- the honest source, listed in the canonical directory -----------------------------
        (MerkleSnapshot honest, MockAccumulator honestAcc) = _source(address(0), keccak256("honest-root"), 1_000);
        bytes32 honestId = keccak256("honest");
        _register(canonicalRegistry, honestId, address(honest), address(honestAcc));
        CompositionSourceAdapter honestAdapter = adapterFactory.create(
            canonicalRegistry, honestId, bytes32(uint256(1)), FAMILY, OUTPUT_KIND, keccak256("provenance-1")
        );

        // --- the attacker's source, listed only in a registry the attacker deployed ----------
        vm.prank(attacker);
        rogueRegistry = new InstanceRegistry(attacker);
        (MerkleSnapshot rogue, MockAccumulator rogueAcc) = _source(attacker, keccak256("rogue-root"), 999_999);
        bytes32 rogueId = keccak256("rogue");
        // Evaluate external-call arguments before `prank`; otherwise `rogue.paramsHash()` consumes
        // the one-shot prank and the registry call is sent by this test contract.
        bytes32 rogueParamsHash = rogue.paramsHash();
        vm.prank(attacker);
        rogueRegistry.registerWithParamsAuthority(
            rogueId,
            IInstanceRegistry.Instance({
                program: SOURCE_PROGRAM,
                snapshot: address(rogue),
                verifier: address(verifier),
                registryOrAccumulator: address(rogueAcc),
                paramsHash: rogueParamsHash
            }),
            attacker
        );

        // Permissionless creation remains available, but the source registry is no longer a trust
        // choice the caller can make.
        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAdapterFactory.ForeignRegistry.selector,
                address(canonicalRegistry),
                address(rogueRegistry)
            )
        );
        vm.prank(attacker);
        adapterFactory.create(
            rogueRegistry, rogueId, bytes32(uint256(2)), FAMILY, OUTPUT_KIND, keccak256("provenance-2")
        );

        assertTrue(adapterFactory.isAdapter(address(honestAdapter)), "honest adapter authenticated");
        assertEq(address(adapterFactory.registry()), address(canonicalRegistry));
    }
}
