// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {GraphLineageRegistry} from "src/registry/GraphLineageRegistry.sol";
import {IGraphLineageRegistry} from "interfaces/registry/IGraphLineageRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

contract QuillOwnedController2 {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

/// @notice Regression for the documented lifetime referral-subject invariant.
///
/// `_referralClaimKeys[issuerScope]` is the append-only lifetime set used to keep all referral
/// history scans bounded. `REFERRAL_BUDGET` is a separate bound over referral heads that can become
/// active; revoke and expiry free spend but intentionally do not admit a 65th distinct subject.
contract QuillStateInv_LineageReferralSubjectCap is Test {
    InstanceRegistry internal registry;
    GraphLineageRegistry internal lineage;
    QuillOwnedController2 internal controller;

    address internal registryAdmin = address(0xBEEF);
    address internal authority = address(0xCAFE);
    bytes32 internal constant SCOPE = keccak256("scope");

    bytes32[] internal lineages;

    function setUp() public {
        registry = new InstanceRegistry(registryAdmin);
        lineage = new GraphLineageRegistry(IInstanceRegistry(address(registry)));
        controller = new QuillOwnedController2(authority);

        // 1 issuer + 65 subjects.
        for (uint256 i; i < 66; ++i) {
            bytes32 instanceId = keccak256(abi.encode("quill.instance", i));
            vm.prank(registryAdmin);
            registry.registerWithParamsAuthority(
                instanceId,
                IInstanceRegistry.Instance({
                    program: keccak256("trust-graph"),
                    snapshot: address(uint160(0x1000 + i)),
                    verifier: address(0x9999),
                    registryOrAccumulator: address(uint160(0x2000 + i)),
                    paramsHash: keccak256(abi.encode("params", i))
                }),
                address(controller)
            );
            vm.prank(authority);
            (bytes32 lineageId,) = lineage.registerLineage(
                instanceId,
                keccak256("family"),
                keccak256("method"),
                SCOPE,
                keccak256("eip155-address"),
                bytes32(0),
                "Graph",
                "ipfs://g"
            );
            lineages.push(lineageId);
        }
    }

    function test_RevokedSubjectsStillConsumeTheLifetimeSubjectCap() public {
        bytes32 issuer = lineages[0];
        uint256 cap = lineage.MAX_REFERRAL_SUBJECTS();
        assertEq(cap, 64);

        uint256 weight = 1e18 / cap; // 64 x 1.5625e16 == 1e18 exactly
        bytes32[] memory ids = new bytes32[](cap);

        for (uint256 i; i < cap; ++i) {
            IGraphLineageRegistry.EndorsementInput memory input = IGraphLineageRegistry.EndorsementInput({
                issuerLineageId: issuer,
                subjectLineageId: lineages[i + 1],
                subjectConfigurationId: lineage.getLineage(lineages[i + 1]).currentConfigurationId,
                scopeHash: SCOPE,
                kind: IGraphLineageRegistry.EndorsementKind.Referral,
                weight: weight,
                validFrom: uint48(block.timestamp),
                validUntil: uint48(block.timestamp + 30 days),
                evidenceURI: "ipfs://e",
                evidenceDigest: keccak256("e"),
                sequence: uint64(i + 1),
                supersedes: bytes32(0)
            });
            vm.prank(authority);
            ids[i] = lineage.issueEndorsement(input);
        }

        (uint256 spent,) = lineage.activeReferralSpend(issuer, SCOPE);
        assertEq(spent, 1e18, "budget fully committed");
        assertEq(lineage.referralClaimKeys(issuer, SCOPE).length, cap);

        // The issuer changes its mind about every one of them, freeing the active budget.
        for (uint256 i; i < cap; ++i) {
            vm.prank(authority);
            lineage.revokeEndorsement(ids[i], keccak256(abi.encode("revocation", i)));
        }

        (uint256 spentAfter, uint256 unused) = lineage.activeReferralSpend(issuer, SCOPE);
        assertEq(spentAfter, 0, "no active referral spend remains");
        assertEq(unused, 1e18, "the whole referral budget is free");

        // The append-only lifetime bound remains full, so a 65th distinct subject is refused.
        assertEq(lineage.referralClaimKeys(issuer, SCOPE).length, cap, "lifetime history is retained");

        IGraphLineageRegistry.EndorsementInput memory next = IGraphLineageRegistry.EndorsementInput({
            issuerLineageId: issuer,
            subjectLineageId: lineages[65],
            subjectConfigurationId: lineage.getLineage(lineages[65]).currentConfigurationId,
            scopeHash: SCOPE,
            kind: IGraphLineageRegistry.EndorsementKind.Referral,
            weight: 1e18,
            validFrom: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 30 days),
            evidenceURI: "ipfs://e",
            evidenceDigest: keccak256("e"),
            sequence: uint64(cap + 1),
            supersedes: bytes32(0)
        });
        vm.prank(authority);
        vm.expectRevert(abi.encodeWithSelector(IGraphLineageRegistry.TooManyReferralSubjects.selector, cap));
        lineage.issueEndorsement(next);
    }
}
