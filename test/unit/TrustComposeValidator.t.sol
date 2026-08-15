// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {TrustComposeParamsCodec} from "contracts/params/TrustComposeParamsCodec.sol";
import {TrustComposeValidator} from "contracts/params/TrustComposeValidator.sol";

contract TrustComposeValidatorHarness {
    function hash(TrustComposeParamsCodec.Params calldata params) external pure returns (bytes32) {
        return TrustComposeParamsCodec.hash(params);
    }

    function validate(TrustComposeParamsCodec.Params calldata params, bytes calldata manifest)
        external
        pure
        returns (TrustComposeValidator.Commitment memory)
    {
        TrustComposeParamsCodec.Params memory copy = params;
        return TrustComposeValidator.validateFinal(copy, manifest);
    }

    function validateManifest(bytes calldata manifest, uint64 chainId, bytes32 programId, uint64 maximumAge)
        external
        pure
        returns (TrustComposeValidator.Commitment memory)
    {
        return TrustComposeValidator.validatePolicyManifest(manifest, chainId, programId, maximumAge);
    }

    function validateManifestMemory(bytes memory manifest, uint64 chainId, bytes32 programId, uint64 maximumAge)
        external
        pure
        returns (TrustComposeValidator.Commitment memory)
    {
        return TrustComposeValidator.validatePolicyManifestMemory(manifest, chainId, programId, maximumAge);
    }
}

contract TrustComposeValidatorTest is Test {
    using stdJson for string;

    TrustComposeValidatorHarness internal harness;
    string internal json;
    bytes internal manifest;

    function setUp() public {
        harness = new TrustComposeValidatorHarness();
        json = vm.readFile("test/golden/trust-compose.json");
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
            admittedProgramId: json.readBytes32(".params.admittedProgramId"),
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

    function test_GoldenPolicyCommitmentAndParamsHash() public view {
        TrustComposeParamsCodec.Params memory params = _params();
        TrustComposeValidator.Commitment memory commitment = harness.validate(params, manifest);
        assertEq(commitment.sourcePolicyRoot, json.readBytes32(".policyManifest.root"));
        assertEq(commitment.sourceCount, 3);
        assertEq(commitment.manifestSha256, json.readBytes32(".policyManifest.sha256"));
        assertEq(commitment.chainId, 10);
        assertEq(harness.hash(params), json.readBytes32(".params.paramsHash"));

        TrustComposeValidator.Commitment memory memoryCommitment = harness.validateManifestMemory(
            manifest, params.chainId, params.admittedProgramId, params.maxSourceAgeBlocks
        );
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
            malformed[15 + 133 + i] = malformed[15 + i];
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
            malformed[15 + 133 + 32 + i] = malformed[15 + 32 + i];
        }
        vm.expectPartialRevert(TrustComposeValidator.DuplicateSnapshot.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[15 + 84] = bytes1(uint8(malformed[15 + 84]) ^ 1);
        vm.expectPartialRevert(TrustComposeValidator.UnadmittedSourceProgram.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        for (uint256 i; i < 8; ++i) {
            malformed[15 + 116 + i] = 0;
        }
        vm.expectPartialRevert(TrustComposeValidator.InvalidSourceWeight.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        _writeBigEndian(malformed, 15 + 124, 500_001, 8);
        vm.expectPartialRevert(TrustComposeValidator.InvalidSourceAge.selector);
        harness.validate(params, malformed);

        malformed = manifest;
        malformed[15 + 132] = 0;
        vm.expectPartialRevert(TrustComposeValidator.OptionalSourceUnsupported.selector);
        harness.validate(params, malformed);
    }

    function test_RevertParamsDomainsBoundsCompositeAndCommitmentDrift() public {
        TrustComposeParamsCodec.Params memory params = _params();
        params.version = 2;
        vm.expectPartialRevert(TrustComposeValidator.InvalidParamsVersion.selector);
        harness.validate(params, manifest);

        params = _params();
        params.programId = bytes32(0);
        vm.expectPartialRevert(TrustComposeValidator.InvalidProgramId.selector);
        harness.validate(params, manifest);

        params = _params();
        params.admittedProgramId = params.programId;
        vm.expectPartialRevert(TrustComposeValidator.InvalidAdmittedProgram.selector);
        harness.validate(params, manifest);

        params = _params();
        params.maxSources = 9;
        vm.expectRevert(TrustComposeValidator.InvalidBounds.selector);
        harness.validate(params, manifest);

        params = _params();
        params.sourcePolicyRoot = keccak256("wrong");
        vm.expectRevert(TrustComposeValidator.PolicyCommitmentMismatch.selector);
        harness.validate(params, manifest);
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) internal pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
