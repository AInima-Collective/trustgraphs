// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;
import {Test} from "forge-std/Test.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ContributionResolver} from "src/eas/resolvers/ContributionResolver.sol";

contract ContributionExpiryPoC is Test {
    function test_ExpiringContributionValuationEntersPermanentLog() public {
        SchemaRegistry registry = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(registry)));
        ContributionResolver resolver = new ContributionResolver(IEAS(address(eas)), address(this));
        bytes32 claimSchema = registry.register(
            "string title,bytes32 contentHash,string uri,address[] contributors,uint32[] shares", resolver, true
        );
        bytes32 responseSchema = registry.register("bytes32 claimUID,uint8 response", resolver, true);
        bytes32 valuationSchema = registry.register("bytes32 claimUID,uint8 score", resolver, true);
        resolver.setSchemas(claimSchema, responseSchema, valuationSchema);
        bytes memory data = abi.encode(bytes32(uint256(1)), uint8(100));
        uint64 expires = uint64(block.timestamp + 1 hours);
        uint256 createdAt = block.timestamp;
        bytes32 uid = eas.attest(
            AttestationRequest({
                schema: valuationSchema,
                data: AttestationRequestData({
                    recipient: address(0),
                    expirationTime: expires,
                    revocable: true,
                    refUID: bytes32(0),
                    data: data,
                    value: 0
                })
            })
        );
        assertEq(eas.getAttestation(uid).expirationTime, expires);
        bytes32 expectedLeaf =
            keccak256(abi.encode(uint8(4), address(this), address(0), uid, createdAt, keccak256(data)));
        bytes32 expectedAccumulator = keccak256(abi.encode(bytes32(0), expectedLeaf));
        assertEq(resolver.acc(), expectedAccumulator);
        vm.warp(uint256(expires) + 100);
        assertEq(resolver.acc(), expectedAccumulator);
        assertEq(resolver.leafCount(), 1);
        // Neither the committed leaf nor RawEdge carries expirationTime. Guest reconciliation
        // excludes explicit revoke kinds only (contributions-core/src/reconcile.rs:47-55).
    }
}
