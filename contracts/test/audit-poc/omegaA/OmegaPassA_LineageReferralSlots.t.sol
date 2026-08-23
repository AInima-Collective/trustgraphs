// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {GraphLineageRegistry} from "src/registry/GraphLineageRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IGraphLineageRegistry} from "interfaces/registry/IGraphLineageRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";

contract SlotController {
    address public owner;

    constructor(address o) {
        owner = o;
    }
}

contract SlotSnapshot {
    function getAcceptedCheckpoint(uint256)
        external
        pure
        returns (IMerkleSnapshot.MerkleState memory, IMerkleSnapshotProvenance.StateProvenance memory)
    {
        revert("unused");
    }
}

/// @notice PASS A PoC.
///
/// `GraphLineageRegistry._referralClaimKeys[issuerScope]` is push-only. A claim key is appended
/// the first time an (issuer, subject, scope, Referral) claim is made and is NEVER removed — not
/// on `revokeEndorsement`, not on expiry. The array is capped at `MAX_REFERRAL_SUBJECTS = 64`, so
/// once an issuer has referred 64 subjects in a scope it can never refer a 65th, even after every
/// one of the 64 has been revoked and every unit of the 1e18 referral budget is free again.
///
/// The counter that gates capacity is incremented on the forward path and decremented on none.
contract OmegaPassA_LineageReferralSlots is Test {
    bytes32 internal constant PROGRAM = keccak256("trust-graph");
    bytes32 internal constant PARAMS = keccak256("params-v1");
    bytes32 internal constant METHOD = keccak256("pagerank-v1");
    bytes32 internal constant SCOPE = keccak256("governance");
    bytes32 internal constant IDENTITY = keccak256("eip155-address");
    bytes32 internal constant POLICY = keccak256("atomic-only");

    InstanceRegistry internal instances;
    GraphLineageRegistry internal registry;
    SlotSnapshot internal snapshot;

    address internal issuerAuthority = makeAddr("issuer");
    bytes32 internal issuerLineage;
    bytes32[] internal subjectLineages;
    bytes32[] internal subjectConfigs;

    function setUp() public {
        vm.warp(1 days);
        instances = new InstanceRegistry(address(this));
        registry = new GraphLineageRegistry(instances);
        snapshot = new SlotSnapshot();

        issuerLineage = _makeLineage(0, issuerAuthority);
        for (uint256 i = 1; i <= 65; i++) {
            address a = address(uint160(0x1000 + i));
            bytes32 lineage = _makeLineage(i, a);
            subjectLineages.push(lineage);
            subjectConfigs.push(registry.getLineage(lineage).currentConfigurationId);
        }
    }

    function test_PassA_RevokedReferralsNeverFreeTheirSubjectSlot() public {
        bytes32[] memory ids = new bytes32[](64);

        // 64 tiny referrals: total weight 64 * 1e16 = 6.4e17, well under the 1e18 budget.
        for (uint64 i = 0; i < 64; i++) {
            vm.prank(issuerAuthority);
            ids[i] = registry.issueEndorsement(
                _input(subjectLineages[i], subjectConfigs[i], 1e16, i + 1)
            );
        }
        assertEq(registry.referralClaimKeys(issuerLineage, SCOPE).length, 64);

        // Revoke every one of them. The budget is now entirely free...
        for (uint256 i = 0; i < 64; i++) {
            vm.prank(issuerAuthority);
            registry.revokeEndorsement(ids[i], keccak256(abi.encode("revocation", i)));
        }
        (uint256 spent, uint256 unused) = registry.activeReferralSpend(issuerLineage, SCOPE);
        assertEq(spent, 0, "budget freed");
        assertEq(unused, registry.REFERRAL_BUDGET());

        // ...but the slot list is not, and it is the thing that gates a new subject.
        assertEq(registry.referralClaimKeys(issuerLineage, SCOPE).length, 64, "slots never released");
        vm.prank(issuerAuthority);
        vm.expectRevert(abi.encodeWithSelector(IGraphLineageRegistry.TooManyReferralSubjects.selector, 64));
        registry.issueEndorsement(_input(subjectLineages[64], subjectConfigs[64], 1e16, 65));
    }

    /*//////////////////////////////////////////////////////////////*/

    function _makeLineage(uint256 index, address authority) internal returns (bytes32 lineageId) {
        bytes32 instanceId = keccak256(abi.encode("instance", index));
        SlotController controller = new SlotController(authority);
        instances.registerWithParamsAuthority(
            instanceId,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: address(0xBEEF),
                registryOrAccumulator: address(0xACCA),
                paramsHash: PARAMS
            }),
            address(controller)
        );
        vm.prank(authority);
        (lineageId,) = registry.registerLineage(
            instanceId,
            keccak256(abi.encode("family", index)),
            METHOD,
            SCOPE,
            IDENTITY,
            POLICY,
            "graph",
            "ipfs://meta"
        );
    }

    function _input(bytes32 subject, bytes32 subjectConfig, uint256 weight, uint64 sequence)
        internal
        view
        returns (IGraphLineageRegistry.EndorsementInput memory)
    {
        return IGraphLineageRegistry.EndorsementInput({
            issuerLineageId: issuerLineage,
            subjectLineageId: subject,
            subjectConfigurationId: subjectConfig,
            scopeHash: SCOPE,
            kind: IGraphLineageRegistry.EndorsementKind.Referral,
            weight: weight,
            validFrom: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 30 days),
            evidenceURI: "https://evidence.example/claim.json",
            evidenceDigest: bytes32(0),
            sequence: sequence,
            supersedes: bytes32(0)
        });
    }
}
