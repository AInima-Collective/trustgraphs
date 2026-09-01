// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {TrustComposeParamsCodecV2} from "src/params/TrustComposeParamsCodecV2.sol";
import {TrustComposeValidatorV2} from "src/params/TrustComposeValidatorV2.sol";

contract TrustComposeValidatorV2Harness {
    function hash(TrustComposeParamsCodecV2.Params calldata params) external pure returns (bytes32) {
        return TrustComposeParamsCodecV2.hash(params);
    }

    function validateCreation(TrustComposeParamsCodecV2.Params calldata params) external pure {
        TrustComposeParamsCodecV2.Params memory copy = params;
        TrustComposeValidatorV2.validateCreation(copy);
    }

    function validate(TrustComposeParamsCodecV2.Params calldata params, bytes calldata manifest)
        external
        pure
        returns (TrustComposeValidatorV2.Commitment memory)
    {
        TrustComposeParamsCodecV2.Params memory copy = params;
        return TrustComposeValidatorV2.validateFinal(copy, manifest);
    }

    function validateManifest(bytes calldata manifest, uint64 chainId, uint64 maximumAge)
        external
        pure
        returns (TrustComposeValidatorV2.Commitment memory)
    {
        return TrustComposeValidatorV2.validatePolicyManifest(manifest, chainId, maximumAge);
    }

    function validateManifestMemory(bytes memory manifest, uint64 chainId, uint64 maximumAge)
        external
        pure
        returns (TrustComposeValidatorV2.Commitment memory)
    {
        return TrustComposeValidatorV2.validatePolicyManifestMemory(manifest, chainId, maximumAge);
    }

    function validateRotationView(
        TrustComposeParamsCodecV2.Params calldata next,
        TrustComposeParamsCodecV2.Params calldata initial
    ) external pure {
        TrustComposeParamsCodecV2.Params memory nextCopy = next;
        TrustComposeParamsCodecV2.Params memory initialCopy = initial;
        TrustComposeValidatorV2.validateRotation(nextCopy, initialCopy);
    }
}

contract TrustComposeValidatorV2Test is Test {
    using stdJson for string;

    uint256 internal constant HEADER = 15;
    uint256 internal constant RECORD = 165;

    TrustComposeValidatorV2Harness internal harness;
    string internal json;
    bytes internal manifest;

    function setUp() public {
        harness = new TrustComposeValidatorV2Harness();
        json = vm.readFile("tests/golden/trust-compose-v2.json");
        manifest = json.readBytes(".policyManifest.encoded");
    }

    function _uintString(string memory path) internal view returns (uint256) {
        return vm.parseUint(json.readString(path));
    }

    function _params() internal view returns (TrustComposeParamsCodecV2.Params memory p) {
        p = TrustComposeParamsCodecV2.Params({
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
        assertEq(TrustComposeValidatorV2.SOURCE_COMPATIBILITY_CLASS, TrustComposeValidatorV2.sourceCompatibilityClass());
        assertEq(
            TrustComposeValidatorV2.SOURCE_COMPATIBILITY_CLASS,
            0x5426d501d31705b306bf65d6260a564441ff6b3b98a4375766c76348b7cca9e2
        );
    }

    function test_GoldenPolicyCommitmentAndParamsHash() public view {
        TrustComposeParamsCodecV2.Params memory params = _params();
        TrustComposeValidatorV2.Commitment memory commitment = harness.validate(params, manifest);
        assertEq(commitment.sourcePolicyRoot, json.readBytes32(".policyManifest.root"));
        assertEq(commitment.sourceCount, 2);
        assertEq(commitment.manifestSha256, json.readBytes32(".policyManifest.sha256"));
        assertEq(commitment.chainId, 10);
        assertEq(harness.hash(params), json.readBytes32(".params.paramsHash"));

        TrustComposeValidatorV2.Commitment memory memoryCommitment =
            harness.validateManifestMemory(manifest, params.chainId, params.maxSourceAgeBlocks);
        assertEq(memoryCommitment.sourcePolicyRoot, commitment.sourcePolicyRoot);
        assertEq(memoryCommitment.manifestSha256, commitment.manifestSha256);
    }

    function test_RevertMalformedPolicyHeaderLengthAndOrder() public {
        TrustComposeParamsCodecV2.Params memory params = _params();
        bytes memory malformed = new bytes(14);
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidManifestLength.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[0] = bytes1(uint8(malformed[0]) ^ 1);
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidManifestMagic.selector);
        harness.validate(params, malformed);

        // A V1 policy manifest replayed under V2 is a version error, not a guess from length.
        malformed = manifest;
        malformed[5] = 0x01;
        vm.expectRevert(abi.encodeWithSelector(TrustComposeValidatorV2.InvalidManifestVersion.selector, uint16(1)));
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[14] = 0x09;
        vm.expectRevert(abi.encodeWithSelector(TrustComposeValidatorV2.InvalidSourceCount.selector, uint8(9)));
        harness.validate(params, malformed);

        malformed = manifest;
        for (uint256 i; i < 32; ++i) {
            malformed[HEADER + RECORD + i] = malformed[HEADER + i];
        }
        vm.expectPartialRevert(TrustComposeValidatorV2.SourceIdsNotAscending.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[13] = bytes1(uint8(malformed[13]) ^ 1);
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidManifestChain.selector);
        harness.validate(params, malformed);
    }

    function test_RevertDuplicateSnapshotProgramWeightAgeAndOptionalSource() public {
        TrustComposeParamsCodecV2.Params memory params = _params();
        bytes memory malformed = manifest;
        for (uint256 i; i < 20; ++i) {
            malformed[HEADER + RECORD + 32 + i] = malformed[HEADER + 32 + i];
        }
        vm.expectPartialRevert(TrustComposeValidatorV2.DuplicateSnapshot.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[HEADER + 84] = bytes1(uint8(malformed[HEADER + 84]) ^ 1);
        vm.expectPartialRevert(TrustComposeValidatorV2.UnadmittedSourceProgram.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        for (uint256 i; i < 8; ++i) {
            malformed[HEADER + 148 + i] = 0;
        }
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidSourceWeight.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        _writeBigEndian(malformed, HEADER + 156, 500_001, 8);
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidSourceAge.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[HEADER + 164] = 0;
        vm.expectPartialRevert(TrustComposeValidatorV2.OptionalSourceUnsupported.selector);
        harness.validate(params, malformed);
    }

    function test_RevertCrossedAndUnknownProgramOutputDomainPairs() public {
        TrustComposeParamsCodecV2.Params memory params = _params();

        // The standard source borrows the weighted domain.
        bytes memory malformed = manifest;
        _writeBytes32(malformed, HEADER + 116, TrustComposeValidatorV2.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN);
        vm.expectPartialRevert(TrustComposeValidatorV2.WrongSourceOutputDomain.selector);
        harness.validate(params, malformed);

        // The weighted source borrows the standard domain.
        malformed = manifest;
        _writeBytes32(malformed, HEADER + RECORD + 116, TrustComposeValidatorV2.TRUST_GRAPH_OUTPUT_DOMAIN);
        vm.expectPartialRevert(TrustComposeValidatorV2.WrongSourceOutputDomain.selector);
        harness.validate(params, malformed);

        // An unknown program cannot enter by copying an allowed domain value.
        malformed = manifest;
        _writeBytes32(malformed, HEADER + 84, keccak256("contributions"));
        _writeBytes32(malformed, HEADER + 116, TrustComposeValidatorV2.TRUST_GRAPH_OUTPUT_DOMAIN);
        vm.expectPartialRevert(TrustComposeValidatorV2.UnadmittedSourceProgram.selector);
        harness.validate(params, malformed);

        // The composition program itself is never an admitted source.
        malformed = manifest;
        _writeBytes32(malformed, HEADER + 84, keccak256("trust-compose"));
        vm.expectPartialRevert(TrustComposeValidatorV2.UnadmittedSourceProgram.selector);
        harness.validate(params, malformed);
    }

    function test_RevertParamsDomainsBoundsClassAndCommitmentDrift() public {
        TrustComposeParamsCodecV2.Params memory params = _params();
        params.version = 1;
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidParamsVersion.selector);
        harness.validate(params, manifest);

        params = _params();
        params.programId = bytes32(0);
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidProgramId.selector);
        harness.validate(params, manifest);

        params = _params();
        params.sourceCompatibilityClass = keccak256("some-other-class");
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidCompatibilityClass.selector);
        harness.validate(params, manifest);

        params = _params();
        params.sourceCompatibilityClass = bytes32(0);
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidCompatibilityClass.selector);
        harness.validate(params, manifest);

        params = _params();
        params.outputPool = params.maxSources - 1;
        vm.expectRevert(TrustComposeValidatorV2.InvalidOutputPool.selector);
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
        vm.expectRevert(TrustComposeValidatorV2.InvalidOutputPool.selector);
        harness.validateCreation(params);

        params = _params();
        params.maxSources = 9;
        vm.expectRevert(TrustComposeValidatorV2.InvalidBounds.selector);
        harness.validate(params, manifest);

        params = _params();
        params.sourcePolicyRoot = keccak256("wrong");
        vm.expectRevert(TrustComposeValidatorV2.PolicyCommitmentMismatch.selector);
        harness.validate(params, manifest);
    }

    function test_RotationKeepsClassImmutableWhileWeightsMove() public view {
        TrustComposeParamsCodecV2.Params memory initial = _params();
        TrustComposeParamsCodecV2.Params memory next = _params();
        next.sourcePolicyRoot = json.readBytes32(".rotation.sourcePolicyRoot");
        next.policyManifestSha256 = json.readBytes32(".rotation.policyManifestSha256");
        harness.validateRotationView(next, initial);
        assertEq(harness.hash(next), json.readBytes32(".rotation.paramsHash"));
    }

    function test_RevertRotationChangingTheClass() public {
        TrustComposeParamsCodecV2.Params memory initial = _params();
        TrustComposeParamsCodecV2.Params memory next = _params();
        next.sourceCompatibilityClass = keccak256("widened-class");
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidCompatibilityClass.selector);
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
