// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

// AUDIT POC (disposable) — zk-soundness pass. Measures the marginal gas an attacker pays per
// folded accumulator leaf, so the H-4 "permanent unprovability ceiling" can be priced instead of
// guessed. MAX_PRICED_INPUTS = InputCapacity.MAX_TOTAL_INPUTS = 200_000.

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {EMPTY_UID, NO_EXPIRATION_TIME} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";

contract AuditAttestGasCeilingTest is Test {
    EAS internal eas;
    EASIndexerResolver internal resolver;
    bytes32 internal schemaUid;

    function setUp() public {
        SchemaRegistry registry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(registry)));
        resolver = new EASIndexerResolver(IEAS(address(eas)));
        schemaUid = registry.register("string comment,uint256 confidence", resolver, true);
        resolver.bindSchema(schemaUid);
    }

    function _attest(address from, uint256 salt) internal returns (uint256 gasUsed) {
        vm.prank(from);
        uint256 before = gasleft();
        eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: address(uint160(0xB0B0000 + salt)),
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode("c", uint256(95)),
                    value: 0
                })
            })
        );
        gasUsed = before - gasleft();
    }

    function test_marginalGasPerFoldedLeaf() public {
        // Warm-up attestation: pays the one-time cold-slot costs on `acc` / `leafCount`.
        _attest(address(uint160(0xA11CE)), 0);
        uint256 total;
        uint256 n = 20;
        for (uint256 i = 1; i <= n; i++) {
            total += _attest(address(uint160(0xA11CE + i)), i);
        }
        uint256 marginal = total / n;
        assertEq(resolver.leafCount(), n + 1, "every attestation folded");
        console.log("marginal gas per folded leaf:", marginal);
        console.log("gas to reach MAX_PRICED_INPUTS (200000):", marginal * 200_000);
        // Sanity band so the number is asserted, not merely printed.
        assertGt(marginal, 50_000);
        assertLt(marginal, 500_000);
    }
}
