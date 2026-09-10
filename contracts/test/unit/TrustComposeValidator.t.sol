// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";

contract TrustComposeValidatorHarness {
    function hash(TrustComposeParamsCodec.Params calldata params) external pure returns (bytes32) {
        return TrustComposeParamsCodec.hash(params);
    }

    function validateCreation(TrustComposeParamsCodec.Params calldata params) external pure {
        TrustComposeParamsCodec.Params memory copy = params;
        TrustComposeValidator.validateCreation(copy);
    }

    function validate(TrustComposeParamsCodec.Params calldata params, bytes calldata manifest)
        external
        pure
        returns (TrustComposeValidator.Commitment memory)
    {
        TrustComposeParamsCodec.Params memory copy = params;
        return TrustComposeValidator.validateFinal(copy, manifest);
    }

    function validateManifest(bytes calldata manifest, uint64 chainId, uint64 maximumAge)
        external
        pure
        returns (TrustComposeValidator.Commitment memory)
    {
        return TrustComposeValidator.validatePolicyManifest(manifest, chainId, maximumAge);
    }

    function validateManifestMemory(bytes memory manifest, uint64 chainId, uint64 maximumAge)
        external
        pure
        returns (TrustComposeValidator.Commitment memory)
    {
        return TrustComposeValidator.validatePolicyManifestMemory(manifest, chainId, maximumAge);
    }

    function validateRotationView(
        TrustComposeParamsCodec.Params calldata next,
        TrustComposeParamsCodec.Params calldata initial
    ) external pure {
        TrustComposeParamsCodec.Params memory nextCopy = next;
        TrustComposeParamsCodec.Params memory initialCopy = initial;
        TrustComposeValidator.validateRotation(nextCopy, initialCopy);
    }
}

contract TrustComposeValidatorTest is Test {
    using stdJson for string;

    uint256 internal constant HEADER = 15;
    uint256 internal constant RECORD = 165;

    TrustComposeValidatorHarness internal harness;
    string internal json;
    bytes internal manifest;

    function setUp() public {
        harness = new TrustComposeValidatorHarness();
        json = vm.readFile("tests/golden/trust-compose.json");
        manifest = json.readBytes(".policyManifest.encoded");
    }

    function _uintString(string memory path) internal view returns (uint256) {
        return vm.parseUint(json.readString(path));
    }

    function _params() internal view returns (TrustComposeParamsCodec.Params memory p) {
        p = TrustComposeParamsCodec.Params({
            version: uint32(json.readUint(".params.version")),
            programId: json.readBytes32(".params.programId"),
            scopeHash: json.readBytes32(".params.scopeHash"),
            identityDomain: json.readBytes32(".params.identityDomain"),
            outputKind: json.readBytes32(".params.outputKind"),
            outputDomain: json.readBytes32(".params.outputDomain"),
            sourceCompatibilityClass: json.readBytes32(".params.sourceCompatibilityClass"),
            weightScale: uint64(_uintString(".params.weightScale")),
            outputPool: uint128(_uintString(".params.outputPool")),
            sourcePolicyRoot: json.readBytes32(".params.sourcePolicyRoot"),
            sourceCount: uint8(json.readUint(".params.sourceCount")),
            policyManifestSha256: json.readBytes32(".params.policyManifestSha256"),
            maxSources: uint8(json.readUint(".params.maxSources")),
            maxEntriesPerSource: uint32(json.readUint(".params.maxEntriesPerSource")),
            maxAggregateEntries: uint32(json.readUint(".params.maxAggregateEntries")),
            maxUnionAccounts: uint32(json.readUint(".params.maxUnionAccounts")),
            maxAggregateBlobBytes: uint32(json.readUint(".params.maxAggregateBlobBytes")),
            maxSourceAgeBlocks: uint64(_uintString(".params.maxSourceAgeBlocks")),
            accumulator: json.readAddress(".params.accumulator"),
            chainId: uint64(_uintString(".params.chainId"))
        });
    }

    function test_ClassConstantMatchesItsNormativePreimage() public pure {
        assertEq(TrustComposeValidator.SOURCE_COMPATIBILITY_CLASS, TrustComposeValidator.sourceCompatibilityClass());
        assertEq(
            TrustComposeValidator.SOURCE_COMPATIBILITY_CLASS,
            0x5426d501d31705b306bf65d6260a564441ff6b3b98a4375766c76348b7cca9e2
        );
    }

    function test_GoldenPolicyCommitmentAndParamsHash() public view {
        TrustComposeParamsCodec.Params memory params = _params();
        TrustComposeValidator.Commitment memory commitment = harness.validate(params, manifest);
        assertEq(commitment.sourcePolicyRoot, json.readBytes32(".policyManifest.root"));
        assertEq(commitment.sourceCount, 2);
        assertEq(commitment.manifestSha256, json.readBytes32(".policyManifest.sha256"));
        assertEq(commitment.chainId, 10);
        assertEq(harness.hash(params), json.readBytes32(".params.paramsHash"));

        TrustComposeValidator.Commitment memory memoryCommitment =
            harness.validateManifestMemory(manifest, params.chainId, params.maxSourceAgeBlocks);
        assertEq(memoryCommitment.sourcePolicyRoot, commitment.sourcePolicyRoot);
        assertEq(memoryCommitment.manifestSha256, commitment.manifestSha256);
    }

    function test_RevertMalformedPolicyHeaderLengthAndOrder() public {
        TrustComposeParamsCodec.Params memory params = _params();
        bytes memory malformed = new bytes(14);
        vm.expectPartialRevert(TrustComposeValidator.InvalidManifestLength.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[0] = bytes1(uint8(malformed[0]) ^ 1);
        vm.expectPartialRevert(TrustComposeValidator.InvalidManifestMagic.selector);
        harness.validate(params, malformed);

        // Any foreign manifest version word is a version error, not a guess from length.
        malformed = manifest;
        malformed[5] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(TrustComposeValidator.InvalidManifestVersion.selector, uint16(2)));
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[14] = 0x09;
        vm.expectRevert(abi.encodeWithSelector(TrustComposeValidator.InvalidSourceCount.selector, uint8(9)));
        harness.validate(params, malformed);

        malformed = manifest;
        for (uint256 i; i < 32; ++i) {
            malformed[HEADER + RECORD + i] = malformed[HEADER + i];
        }
        vm.expectPartialRevert(TrustComposeValidator.SourceIdsNotAscending.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[13] = bytes1(uint8(malformed[13]) ^ 1);
        vm.expectPartialRevert(TrustComposeValidator.InvalidManifestChain.selector);
        harness.validate(params, malformed);
    }

    function test_RevertDuplicateSnapshotProgramWeightAgeAndOptionalSource() public {
        TrustComposeParamsCodec.Params memory params = _params();
        bytes memory malformed = manifest;
        for (uint256 i; i < 20; ++i) {
            malformed[HEADER + RECORD + 32 + i] = malformed[HEADER + 32 + i];
        }
        vm.expectPartialRevert(TrustComposeValidator.DuplicateSnapshot.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[HEADER + 84] = bytes1(uint8(malformed[HEADER + 84]) ^ 1);
        vm.expectPartialRevert(TrustComposeValidator.UnadmittedSourceProgram.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        for (uint256 i; i < 8; ++i) {
            malformed[HEADER + 148 + i] = 0;
        }
        vm.expectPartialRevert(TrustComposeValidator.InvalidSourceWeight.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        _writeBigEndian(malformed, HEADER + 156, 500_001, 8);
        vm.expectPartialRevert(TrustComposeValidator.InvalidSourceAge.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[HEADER + 164] = 0;
        vm.expectPartialRevert(TrustComposeValidator.OptionalSourceUnsupported.selector);
        harness.validate(params, malformed);
    }

    function test_RevertCrossedAndUnknownProgramOutputDomainPairs() public {
        TrustComposeParamsCodec.Params memory params = _params();

        // The standard source borrows the weighted domain.
        bytes memory malformed = manifest;
        _writeBytes32(malformed, HEADER + 116, TrustComposeValidator.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN);
        vm.expectPartialRevert(TrustComposeValidator.WrongSourceOutputDomain.selector);
        harness.validate(params, malformed);

        // The weighted source borrows the standard domain.
        malformed = manifest;
        _writeBytes32(malformed, HEADER + RECORD + 116, TrustComposeValidator.TRUST_GRAPH_OUTPUT_DOMAIN);
        vm.expectPartialRevert(TrustComposeValidator.WrongSourceOutputDomain.selector);
        harness.validate(params, malformed);

        // An unknown program cannot enter by copying an allowed domain value.
        malformed = manifest;
        _writeBytes32(malformed, HEADER + 84, keccak256("contributions"));
        _writeBytes32(malformed, HEADER + 116, TrustComposeValidator.TRUST_GRAPH_OUTPUT_DOMAIN);
        vm.expectPartialRevert(TrustComposeValidator.UnadmittedSourceProgram.selector);
        harness.validate(params, malformed);

        // The composition program itself is never an admitted source.
        malformed = manifest;
        _writeBytes32(malformed, HEADER + 84, keccak256("trust-compose"));
        vm.expectPartialRevert(TrustComposeValidator.UnadmittedSourceProgram.selector);
        harness.validate(params, malformed);
    }

    function test_RevertParamsDomainsBoundsClassAndCommitmentDrift() public {
        TrustComposeParamsCodec.Params memory params = _params();
        params.version = 2;
        vm.expectPartialRevert(TrustComposeValidator.InvalidParamsVersion.selector);
        harness.validate(params, manifest);

        params = _params();
        params.programId = bytes32(0);
        vm.expectPartialRevert(TrustComposeValidator.InvalidProgramId.selector);
        harness.validate(params, manifest);

        params = _params();
        params.sourceCompatibilityClass = keccak256("some-other-class");
        vm.expectPartialRevert(TrustComposeValidator.InvalidCompatibilityClass.selector);
        harness.validate(params, manifest);

        params = _params();
        params.sourceCompatibilityClass = bytes32(0);
        vm.expectPartialRevert(TrustComposeValidator.InvalidCompatibilityClass.selector);
        harness.validate(params, manifest);

        params = _params();
        params.outputPool = params.maxSources - 1;
        vm.expectRevert(TrustComposeValidator.InvalidOutputPool.selector);
        harness.validate(params, manifest);

        // Creation has no derived sourceCount yet, so it must reserve enough pool for every
        // source a later policy rotation may admit.
        params = _params();
        params.sourcePolicyRoot = bytes32(0);
        params.sourceCount = 0;
        params.policyManifestSha256 = bytes32(0);
        params.accumulator = address(0);
        params.chainId = 0;
        params.outputPool = params.maxSources - 1;
        vm.expectRevert(TrustComposeValidator.InvalidOutputPool.selector);
        harness.validateCreation(params);

        params = _params();
        params.maxSources = 9;
        vm.expectRevert(TrustComposeValidator.InvalidBounds.selector);
        harness.validate(params, manifest);

        params = _params();
        params.sourcePolicyRoot = keccak256("wrong");
        vm.expectRevert(TrustComposeValidator.PolicyCommitmentMismatch.selector);
        harness.validate(params, manifest);
    }

    function test_RotationKeepsClassImmutableWhileWeightsMove() public view {
        TrustComposeParamsCodec.Params memory initial = _params();
        TrustComposeParamsCodec.Params memory next = _params();
        next.sourcePolicyRoot = json.readBytes32(".rotation.sourcePolicyRoot");
        next.policyManifestSha256 = json.readBytes32(".rotation.policyManifestSha256");
        harness.validateRotationView(next, initial);
        assertEq(harness.hash(next), json.readBytes32(".rotation.paramsHash"));
    }

    function test_RevertRotationChangingTheClass() public {
        TrustComposeParamsCodec.Params memory initial = _params();
        TrustComposeParamsCodec.Params memory next = _params();
        next.sourceCompatibilityClass = keccak256("widened-class");
        vm.expectPartialRevert(TrustComposeValidator.InvalidCompatibilityClass.selector);
        harness.validateRotationView(next, initial);
    }

    function _writeBytes32(bytes memory target, uint256 offset, bytes32 value) internal pure {
        for (uint256 i; i < 32; ++i) {
            target[offset + i] = value[i];
        }
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) internal pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
