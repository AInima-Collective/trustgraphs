// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";

contract NostrCaptureVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice Proves the capture boundary REJECTS an authenticated Nostr workspace outright: the
///         composition admits only the closed standard/weighted TrustGraph class, so a Nostr
///         source can neither enter a policy nor be relabelled as an address program.
contract NostrWorkspaceCompositionCaptureTest is Test {
    bytes32 internal constant NOSTR_PROGRAM = keccak256("nostr-workspace");
    bytes32 internal constant NOSTR_OUTPUT_DOMAIN = keccak256("trustgraphs.output.nostr-member.v1");
    bytes32 internal constant FAMILY = keccak256("nostr-workspace-member-v1");
    bytes32 internal constant ALLOCATION = keccak256("allocation");
    bytes32 internal constant NOSTR_VKEY = 0x00475027871d7e096ae46d3059e73769642091af658febfef05271be59e343e3;

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    NostrCaptureVerifier internal sourceVerifier;
    address[] internal adapters;
    bytes32[] internal roots;
    bytes32[] internal paramsHashes;

    function setUp() public {
        registry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(registry);
        sourceVerifier = new NostrCaptureVerifier(NOSTR_VKEY);
        _createNostrSource(0);
        _createNostrSource(1);
    }

    function test_NostrAdapterIsOutsideTheClosedAdmissionAndFailsClosed() public {
        CompositionSourceAccumulator accumulator = new CompositionSourceAccumulator(adapterFactory, address(this));
        NostrCaptureVerifier composeVerifier = new NostrCaptureVerifier(keccak256("capture-only compose verifier"));
        MerkleSnapshot snapshot = new MerkleSnapshot(
            composeVerifier, keccak256("capture-only compose params"), accumulator, address(this), address(this), ""
        );
        accumulator.bind(address(snapshot), address(this));

        // The adapter itself authenticates fine — the refusal is the composition's admission
        // class, not source provenance.
        CompositionSourceAdapter first = CompositionSourceAdapter(adapters[0]);
        assertEq(first.programId(), NOSTR_PROGRAM);
        assertEq(first.programVKey(), NOSTR_VKEY);
        assertEq(first.readLatest().paramsHash, paramsHashes[0]);
        assertEq(first.readLatest().outputRoot, roots[0]);
        assertNotEq(NOSTR_OUTPUT_DOMAIN, keccak256("trustgraphs.output.trust-compose-account.v1"));

        bytes memory policy = _policy(NOSTR_PROGRAM, NOSTR_OUTPUT_DOMAIN);
        vm.expectPartialRevert(TrustComposeValidator.UnadmittedSourceProgram.selector);
        accumulator.installPolicy(1, policy, adapters);
    }

    function test_ManifestCannotRelabelNostrAdapterAsAddressProgram() public {
        CompositionSourceAccumulator accumulator = new CompositionSourceAccumulator(adapterFactory, address(this));
        NostrCaptureVerifier composeVerifier = new NostrCaptureVerifier(keccak256("capture-only compose verifier"));
        MerkleSnapshot snapshot = new MerkleSnapshot(
            composeVerifier, keccak256("capture-only compose params"), accumulator, address(this), address(this), ""
        );
        accumulator.bind(address(snapshot), address(this));

        // Claiming the standard program (and its derived domain) for a Nostr adapter is a
        // policy/adapter identity mismatch before admission is even considered.
        bytes32 wrongProgram = keccak256("trust-graph");
        bytes memory relabeled =
            _policy(wrongProgram, keccak256("trustgraphs.output.trust-graph-account.v1"));
        vm.expectPartialRevert(CompositionSourceAccumulator.AdapterPolicyMismatch.selector);
        accumulator.installPolicy(1, relabeled, adapters);
    }

    function _createNostrSource(uint256 index) internal {
        MockAccumulator sourceAccumulator = new MockAccumulator();
        bytes32 paramsHash = keccak256(abi.encode(NOSTR_OUTPUT_DOMAIN, "nostr params", index));
        MerkleSnapshot sourceSnapshot =
            new MerkleSnapshot(sourceVerifier, paramsHash, sourceAccumulator, address(this), address(this), "");
        sourceSnapshot.enableStateProvenance();
        bytes32 instanceId = bytes32(index + 1);
        registry.registerWithParamsAuthority(
            instanceId,
            IInstanceRegistry.Instance({
                program: NOSTR_PROGRAM,
                snapshot: address(sourceSnapshot),
                verifier: address(sourceVerifier),
                registryOrAccumulator: address(sourceAccumulator),
                paramsHash: paramsHash
            }),
            address(this)
        );
        sourceAccumulator.setState(keccak256(abi.encode("nostr anchor", index)), uint64(index + 1));
        vm.roll(10 + index);
        uint256 checkpoint = sourceSnapshot.trigger();
        bytes32 root = keccak256(abi.encode("unified node+address root", index));
        sourceSnapshot.submitProof(
            checkpoint,
            root,
            sha256(abi.encode("bytes32 score blob", index)),
            string.concat("bafk-nostr-", vm.toString(index)),
            1_000 + index,
            bytes32(0),
            address(0),
            ""
        );
        CompositionSourceAdapter adapter = adapterFactory.create(
            registry,
            instanceId,
            bytes32(index + 1),
            FAMILY,
            ALLOCATION,
            keccak256(abi.encode("reviewed Nostr capture", index))
        );
        adapters.push(address(adapter));
        roots.push(root);
        paramsHashes.push(paramsHash);
    }

    function _policy(bytes32 program, bytes32 outputDomain) internal view returns (bytes memory manifest) {
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(2));
        for (uint256 i; i < 2; ++i) {
            CompositionSourceAdapter adapter = CompositionSourceAdapter(adapters[i]);
            manifest = bytes.concat(
                manifest,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    program,
                    outputDomain,
                    uint64(5e17),
                    uint64(500),
                    uint8(1)
                )
            );
        }
    }

    function _word(bytes memory data, uint256 offset) internal pure returns (bytes32 value) {
        assembly ("memory-safe") {
            value := mload(add(add(data, 32), offset))
        }
    }
}
