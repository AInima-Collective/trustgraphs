// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";

/// @dev Thin external wrapper so library reverts surface as call reverts.
contract ComposeValidatorHarness {
    function validateCreation(TrustComposeParamsCodec.Params calldata p) external pure {
        TrustComposeParamsCodec.Params memory copy = p;
        TrustComposeValidator.validateCreation(copy);
    }

    function validateFinal(TrustComposeParamsCodec.Params calldata p, bytes calldata manifest)
        external
        pure
        returns (TrustComposeValidator.Commitment memory)
    {
        TrustComposeParamsCodec.Params memory copy = p;
        return TrustComposeValidator.validateFinal(copy, manifest);
    }

    function validateRotation(
        TrustComposeParamsCodec.Params calldata next,
        TrustComposeParamsCodec.Params calldata initial
    ) external pure {
        TrustComposeParamsCodec.Params memory a = next;
        TrustComposeParamsCodec.Params memory b = initial;
        TrustComposeValidator.validateRotation(a, b);
    }
}

/// @title PashovMath_ComposeOutputPool
/// @notice `TrustComposeValidator` only rejects `outputPool == 0`. The composition guest
///         (`composition-core::compute`) allocates the pool across the 2..8 required sources with
///         exact Hamilton apportionment and ERRORS (`RequiredSourceReceivedZero`) the moment any
///         REQUIRED source's quota rounds to zero. Every `outputPool < sourceCount` therefore
///         creates an instance that can never be proven, and `outputPool` is a rotation identity
///         field, so the mistake is unrecoverable.
contract PashovMath_ComposeOutputPoolTest is Test {
    using stdJson for string;

    ComposeValidatorHarness internal harness;
    string internal json;
    bytes internal manifest;

    function setUp() public {
        harness = new ComposeValidatorHarness();
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

    /// @dev Byte-for-byte port of `composition-core::hamilton::apportion` (the guest's allocator):
    ///      floor(pool * w_i / denominator), then the `residual` largest remainders get +1,
    ///      ties broken by ascending key. Returns the per-source quota.
    function _hamilton(uint128 pool, uint64[] memory weights, uint128 denominator)
        internal
        pure
        returns (uint256[] memory quotas)
    {
        uint256 n = weights.length;
        quotas = new uint256[](n);
        uint256[] memory rem = new uint256[](n);
        uint256 allocated;
        for (uint256 i; i < n; ++i) {
            uint256 num = uint256(pool) * weights[i];
            quotas[i] = num / denominator;
            rem[i] = num % denominator;
            allocated += quotas[i];
        }
        uint256 residual = uint256(pool) - allocated;
        // Award the `residual` largest remainders; ties keep the lowest index, which is the
        // guest's ascending-key tie-break (the manifest is ascending by sourceId).
        for (uint256 seat; seat < residual; ++seat) {
            uint256 best = _argmax(rem);
            quotas[best] += 1;
            rem[best] = 0;
        }
    }

    function _argmax(uint256[] memory v) internal pure returns (uint256 best) {
        for (uint256 i = 1; i < v.length; ++i) {
            if (v[i] > v[best]) best = i;
        }
    }

    /// The golden 3-source policy weights (they sum to exactly WEIGHT_SCALE = 1e18).
    function _goldenWeights() internal pure returns (uint64[] memory w) {
        w = new uint64[](3);
        w[0] = 333_000_000_000_000_000;
        w[1] = 333_000_000_000_000_000;
        w[2] = 334_000_000_000_000_000;
    }

    function test_GoldenWeightsSumToScale() public pure {
        uint64[] memory w = _goldenWeights();
        assertEq(uint256(w[0]) + w[1] + w[2], uint256(TrustComposeValidator.WEIGHT_SCALE));
    }

    /// The validator reserves pool headroom for every source a future policy may admit.
    function test_ValidatorRejectsOutputPoolBelowMaximumSourceCount() public {
        TrustComposeParamsCodec.Params memory p = _params();
        assertEq(p.sourceCount, 3, "golden policy has 3 required sources");

        // 1 unit of pool, 3 required sources: the guest cannot allocate this policy.
        p.outputPool = 1;
        vm.expectRevert(TrustComposeValidator.InvalidOutputPool.selector);
        harness.validateFinal(p, manifest);

        // Creation has not derived sourceCount yet. Checking maxSources here also prevents a
        // later source-count rotation from bricking an initially valid instance.
        TrustComposeParamsCodec.Params memory creation = p;
        creation.sourcePolicyRoot = bytes32(0);
        creation.sourceCount = 0;
        creation.policyManifestSha256 = bytes32(0);
        creation.accumulator = address(0);
        creation.chainId = 0;
        vm.expectRevert(TrustComposeValidator.InvalidOutputPool.selector);
        harness.validateCreation(creation);

        creation.outputPool = creation.maxSources;
        harness.validateCreation(creation);
    }

    /// The guest's own allocator gives two of the three REQUIRED sources a zero quota,
    /// which `composition-core::compute` turns into `RequiredSourceReceivedZero`.
    function test_GuestAllocatorGivesRequiredSourcesZero() public pure {
        uint64[] memory w = _goldenWeights();
        uint128 scale = uint128(TrustComposeValidator.WEIGHT_SCALE);

        uint256[] memory q1 = _hamilton(1, w, scale);
        assertEq(q1[0], 0, "source 0 receives nothing");
        assertEq(q1[1], 0, "source 1 receives nothing");
        assertEq(q1[2], 1, "the whole pool lands on one source");
        assertEq(q1[0] + q1[1] + q1[2], 1, "Hamilton still conserves the pool");

        // pool == 2 is still fatal: one required source is starved.
        uint256[] memory q2 = _hamilton(2, w, scale);
        assertEq(q2[0] + q2[1] + q2[2], 2);
        uint256 zeros;
        for (uint256 i; i < 3; ++i) {
            if (q2[i] == 0) zeros++;
        }
        assertEq(zeros, 1, "pool == 2 starves exactly one of three required sources");

        // pool == sourceCount is the first value that works for these weights.
        uint256[] memory q3 = _hamilton(3, w, scale);
        assertEq(q3[0], 1);
        assertEq(q3[1], 1);
        assertEq(q3[2], 1);
    }

    /// A skewed-but-legal policy pushes the unprovable range far higher than `sourceCount`:
    /// weight == 1 is accepted by `validatePolicyManifest` (only `weight == 0` reverts), and a
    /// source with weight 1 needs `outputPool >= 1e18` before its floor is nonzero.
    function test_SkewedWeightsMakeLargePoolsUnprovable() public pure {
        uint64[] memory w = new uint64[](3);
        w[0] = 1;
        w[1] = 1;
        w[2] = uint64(TrustComposeValidator.WEIGHT_SCALE) - 2;
        assertEq(uint256(w[0]) + w[1] + w[2], uint256(TrustComposeValidator.WEIGHT_SCALE));

        // A very ordinary pool (1e12 units) still starves both low-weight sources.
        uint256[] memory q = _hamilton(1e12, w, uint128(TrustComposeValidator.WEIGHT_SCALE));
        assertEq(q[0] + q[1] + q[2], 1e12, "pool conserved");
        assertEq(q[0], 0, "weight-1 source starved");
        assertEq(q[1] + q[2], 1e12);
        // exactly one of the two weight-1 sources can win the single residual seat
        assertEq(q[1], 0, "second weight-1 source starved too");
    }

    /// And the mistake is unrecoverable: `outputPool` is a rotation identity field.
    function test_OutputPoolCannotBeRotated() public {
        // NOTE: `memory a = memory b` ALIASES in Solidity, so both structs are rebuilt from JSON.
        TrustComposeParamsCodec.Params memory initial = _params();
        initial.outputPool = 1;
        TrustComposeParamsCodec.Params memory next = _params();
        next.outputPool = 1_000_000;
        vm.expectRevert(TrustComposeValidator.IdentityFieldChanged.selector);
        harness.validateRotation(next, initial);
    }
}
