// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "src/params/WeightedPriorValidator.sol";

contract WeightedPriorValidatorHarness {
    bytes32 public priorRoot;
    uint32 public priorCount;
    bytes32 public manifestSha256;
    uint64 public manifestChainId;

    function validate(bytes calldata manifest, uint64 expectedChain)
        external
        pure
        returns (WeightedPriorValidator.Commitment memory)
    {
        return WeightedPriorValidator.validateManifest(manifest, expectedChain);
    }

    function validateAndStore(bytes calldata manifest, uint64 expectedChain) external {
        WeightedPriorValidator.Commitment memory commitment =
            WeightedPriorValidator.validateManifest(manifest, expectedChain);
        priorRoot = commitment.priorRoot;
        priorCount = commitment.priorCount;
        manifestSha256 = commitment.manifestSha256;
        manifestChainId = commitment.chainId;
    }

    function hash(WeightedPriorParamsCodec.Params calldata params) external pure returns (bytes32) {
        return WeightedPriorParamsCodec.hash(params);
    }

    function validateCreation(WeightedPriorParamsCodec.Params calldata params) external pure {
        WeightedPriorParamsCodec.Params memory paramsMemory = params;
        WeightedPriorValidator.validateCreation(paramsMemory);
    }

    function validateFinal(WeightedPriorParamsCodec.Params calldata params, bytes calldata manifest) external pure {
        WeightedPriorParamsCodec.Params memory paramsMemory = params;
        WeightedPriorValidator.validateFinal(paramsMemory, manifest);
    }
}

contract WeightedPriorValidatorTest is Test {
    using stdJson for string;

    uint256 internal constant SCALE = 1e18;

    WeightedPriorValidatorHarness internal harness;
    string internal json;
    bytes internal goldenManifest;

    function setUp() public {
        harness = new WeightedPriorValidatorHarness();
        json = vm.readFile("tests/golden/weighted-prior.json");
        goldenManifest = json.readBytes(".prior.manifest");
    }

    function test_GoldenManifestCommitmentAndParamsHash() public view {
        WeightedPriorValidator.Commitment memory commitment = harness.validate(goldenManifest, 10);
        assertEq(commitment.priorRoot, json.readBytes32(".prior.root"));
        assertEq(commitment.priorCount, 3);
        assertEq(commitment.manifestSha256, json.readBytes32(".prior.manifestSha256"));
        assertEq(commitment.chainId, 10);

        WeightedPriorParamsCodec.Params memory params = WeightedPriorParamsCodec.Params({
            version: 1,
            dampingFp: uint64(json.readUint(".params.dampingFp")),
            toleranceFp: uint64(json.readUint(".params.toleranceFp")),
            maxIterations: uint32(json.readUint(".params.maxIterations")),
            minWeight: uint64(json.readUint(".params.minWeight")),
            maxWeight: uint64(json.readUint(".params.maxWeight")),
            priorRoot: commitment.priorRoot,
            priorCount: commitment.priorCount,
            manifestSha256: commitment.manifestSha256,
            schemaUid: json.readBytes32(".params.schemaUid"),
            weightFieldIndex: uint32(json.readUint(".params.weightFieldIndex")),
            accumulator: json.readAddress(".params.accumulator"),
            chainId: commitment.chainId
        });
        assertEq(harness.hash(params), json.readBytes32(".params.paramsHash"));
    }

    function test_RevertMalformedHeaderAndLength() public {
        bytes memory malformed = new bytes(17);
        vm.expectPartialRevert(WeightedPriorValidator.InvalidManifestLength.selector);
        harness.validate(malformed, 10);

        malformed = goldenManifest;
        malformed[0] ^= 0x01;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidManifestMagic.selector);
        harness.validate(malformed, 10);

        malformed = goldenManifest;
        malformed[5] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(WeightedPriorValidator.InvalidManifestVersion.selector, uint16(2)));
        harness.validate(malformed, 10);

        vm.expectRevert(
            abi.encodeWithSelector(WeightedPriorValidator.InvalidManifestChain.selector, uint64(10), uint64(1))
        );
        harness.validate(goldenManifest, 1);

        malformed = goldenManifest;
        _writeBigEndian(malformed, 14, 0, 4);
        vm.expectRevert(abi.encodeWithSelector(WeightedPriorValidator.InvalidPriorCount.selector, uint32(0)));
        harness.validate(malformed, 10);

        malformed = goldenManifest;
        _writeBigEndian(malformed, 14, 2049, 4);
        vm.expectRevert(abi.encodeWithSelector(WeightedPriorValidator.InvalidPriorCount.selector, uint32(2049)));
        harness.validate(malformed, 10);

        malformed = bytes.concat(goldenManifest, hex"00");
        vm.expectPartialRevert(WeightedPriorValidator.InvalidManifestLength.selector);
        harness.validate(malformed, 10);
    }

    function test_RevertNoncanonicalEntriesAndMass() public {
        bytes memory malformed = goldenManifest;
        for (uint256 i; i < 20; ++i) {
            malformed[18 + i] = 0;
        }
        vm.expectRevert(
            abi.encodeWithSelector(WeightedPriorValidator.InvalidPriorAccount.selector, uint32(0), address(0))
        );
        harness.validate(malformed, 10);

        malformed = goldenManifest;
        for (uint256 i; i < 20; ++i) {
            malformed[46 + i] = malformed[18 + i];
        }
        vm.expectPartialRevert(WeightedPriorValidator.PriorAccountsNotAscending.selector);
        harness.validate(malformed, 10);

        malformed = goldenManifest;
        for (uint256 i; i < 28; ++i) {
            bytes1 first = malformed[18 + i];
            malformed[18 + i] = malformed[46 + i];
            malformed[46 + i] = first;
        }
        vm.expectPartialRevert(WeightedPriorValidator.PriorAccountsNotAscending.selector);
        harness.validate(malformed, 10);

        malformed = goldenManifest;
        for (uint256 i; i < 8; ++i) {
            malformed[38 + i] = 0;
        }
        vm.expectRevert(abi.encodeWithSelector(WeightedPriorValidator.InvalidPriorWeight.selector, uint32(0)));
        harness.validate(malformed, 10);

        malformed = goldenManifest;
        malformed[45] ^= 0x01;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidPriorWeightSum.selector);
        harness.validate(malformed, 10);
    }

    function test_ParamsEnvelopeMatchesWeightedGuestAndCreationDerivationRules() public {
        WeightedPriorParamsCodec.Params memory params = _creationParams();
        harness.validateCreation(params);

        params.version = 2;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidParamsVersion.selector);
        harness.validateCreation(params);
        params = _creationParams();
        params.dampingFp = 0;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidDamping.selector);
        harness.validateCreation(params);
        params = _creationParams();
        params.toleranceFp = uint64(SCALE) + 1;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidTolerance.selector);
        harness.validateCreation(params);
        params = _creationParams();
        params.maxIterations = 41;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidIterations.selector);
        harness.validateCreation(params);
        params = _creationParams();
        params.maxWeight = 0;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidWeightBounds.selector);
        harness.validateCreation(params);
        params = _creationParams();
        params.weightFieldIndex = 0;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidWeightFieldIndex.selector);
        harness.validateCreation(params);

        params = _creationParams();
        params.priorCount = 1;
        vm.expectRevert(WeightedPriorValidator.DerivedFieldNotZero.selector);
        harness.validateCreation(params);

        WeightedPriorValidator.Commitment memory commitment = harness.validate(goldenManifest, 10);
        params = _creationParams();
        params.priorRoot = commitment.priorRoot;
        params.priorCount = commitment.priorCount;
        params.manifestSha256 = commitment.manifestSha256;
        params.schemaUid = bytes32(uint256(1));
        params.accumulator = address(1);
        params.chainId = 10;
        harness.validateFinal(params, goldenManifest);

        params.chainId = 0;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidParamsChain.selector);
        harness.validateFinal(params, goldenManifest);

        params.chainId = 10;
        params.priorRoot = keccak256("wrong root");
        vm.expectRevert(WeightedPriorValidator.PriorCommitmentMismatch.selector);
        harness.validateFinal(params, goldenManifest);
        params.priorRoot = commitment.priorRoot;
        params.manifestSha256 = keccak256("wrong digest");
        vm.expectRevert(WeightedPriorValidator.PriorCommitmentMismatch.selector);
        harness.validateFinal(params, goldenManifest);
        params.manifestSha256 = commitment.manifestSha256;
        params.priorCount = 2;
        vm.expectRevert(WeightedPriorValidator.PriorCommitmentMismatch.selector);
        harness.validateFinal(params, goldenManifest);
    }

    function testFuzz_ValidCanonicalManifest(uint8 rawCount, uint64 chainId) public view {
        uint256 count = bound(rawCount, 1, 64);
        chainId = uint64(bound(chainId, 1, type(uint64).max));
        bytes memory manifest = _manifest(count, chainId);
        WeightedPriorValidator.Commitment memory commitment = harness.validate(manifest, chainId);
        assertEq(commitment.priorCount, count);
        assertEq(commitment.manifestSha256, sha256(manifest));
        assertEq(commitment.chainId, chainId);
        assertTrue(commitment.priorRoot != bytes32(0));
    }

    function test_MaxManifestValidationGasEnvelope() public {
        bytes memory manifest = _manifest(2048, 10);
        bytes memory call = abi.encodeCall(harness.validateAndStore, (manifest, uint64(10)));

        uint256 beforeGas = gasleft();
        harness.validateAndStore(manifest, 10);
        uint256 executionGas = beforeGas - gasleft();
        uint256 totalL1Gas = executionGas + _calldataGas(call) + 21_000;

        emit log_named_uint("weighted max execution gas", executionGas);
        emit log_named_uint("weighted max calldata gas", _calldataGas(call));
        emit log_named_uint("weighted max total L1 gas", totalL1Gas);
        assertLt(executionGas, 5_000_000, "max validation/store execution gas");
        assertLt(totalL1Gas, 4_500_000, "max validation/store total L1 gas");
    }

    function _manifest(uint256 count, uint64 chainId) internal pure returns (bytes memory manifest) {
        manifest = new bytes(18 + count * 28);
        manifest[0] = 0x54;
        manifest[1] = 0x47;
        manifest[2] = 0x57;
        manifest[3] = 0x50;
        manifest[5] = 0x01;
        _writeBigEndian(manifest, 6, chainId, 8);
        _writeBigEndian(manifest, 14, count, 4);

        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint256 offset = 18 + i * 28;
            address account = address(uint160(i + 1));
            uint256 weight = base + (i < remainder ? 1 : 0);
            assembly ("memory-safe") {
                mstore(add(add(manifest, 32), offset), shl(96, account))
                mstore(add(add(add(manifest, 32), offset), 20), shl(192, weight))
            }
        }
    }

    function _creationParams() internal pure returns (WeightedPriorParamsCodec.Params memory params) {
        params.version = 1;
        params.dampingFp = 85e16;
        params.toleranceFp = 1e12;
        params.maxIterations = 40;
        params.maxWeight = 100;
        params.weightFieldIndex = 1;
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) internal pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 gasUnits) {
        for (uint256 i; i < data.length; ++i) {
            gasUnits += data[i] == 0 ? 4 : 16;
        }
    }
}
