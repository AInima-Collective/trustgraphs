// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {
    IEAS,
    AttestationRequestData,
    MultiAttestationRequest,
    MultiRevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";

/// The attacker's OPTIMAL lane-1 ingress cost: batch attest + batch revoke, empty payload.
contract VerifyIngressCost is Test {
    EAS internal eas;
    SchemaRegistry internal reg;
    EASIndexerResolver internal resolver;
    bytes32 internal s;

    function setUp() public {
        reg = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(reg)));
        SchemaRegistrar registrar = new SchemaRegistrar(ISchemaRegistry(address(reg)));
        resolver = new EASIndexerResolver(IEAS(address(eas)));
        s = registrar.register("string comment,uint256 confidence", ISchemaResolver(address(resolver)), true);
        resolver.bindSchema(s);
    }

    function test_OptimalBatchedLeafCost() public {
        uint256 n = 100;
        AttestationRequestData[] memory data = new AttestationRequestData[](n);
        for (uint256 i = 0; i < n; i++) {
            data[i] = AttestationRequestData({
                recipient: address(uint160(0xB0B0000 + i)),
                expirationTime: NO_EXPIRATION_TIME,
                revocable: true,
                refUID: EMPTY_UID,
                // EAS does NOT type-check `data` against the schema string: empty bytes are accepted.
                data: "",
                value: 0
            });
        }
        MultiAttestationRequest[] memory areqs = new MultiAttestationRequest[](1);
        areqs[0] = MultiAttestationRequest({schema: s, data: data});

        uint256 g0 = gasleft();
        bytes32[] memory uids = eas.multiAttest(areqs);
        uint256 attestGas = g0 - gasleft();

        RevocationRequestData[] memory rdata = new RevocationRequestData[](n);
        for (uint256 i = 0; i < n; i++) {
            rdata[i] = RevocationRequestData({uid: uids[i], value: 0});
        }
        MultiRevocationRequest[] memory rreqs = new MultiRevocationRequest[](1);
        rreqs[0] = MultiRevocationRequest({schema: s, data: rdata});

        g0 = gasleft();
        eas.multiRevoke(rreqs);
        uint256 revokeGas = g0 - gasleft();

        assertEq(resolver.leafCount(), 2 * n, "2 leaves per attestation");

        // Calldata: multiAttest ~ (4 + 5 heads + n*(6 words + dyn)) ; measured empirically below.
        // Use a conservative 20 words (640B) of calldata per attestation and 1 word per revoke uid.
        uint256 calldataGas = n * (20 * 32 * 16) + n * (32 * 16);
        uint256 total = attestGas + revokeGas + 2 * 21_000 + calldataGas;
        uint256 leaves = 2 * n;

        console2.log("multiAttest exec gas  (n=100):", attestGas);
        console2.log("multiRevoke exec gas  (n=100):", revokeGas);
        console2.log("assumed calldata gas         :", calldataGas);
        console2.log("total gas for 200 leaves     :", total);
        console2.log("GAS PER LEAF                 :", total / leaves);
        console2.log("GAS TO FILL 200,000 LEAVES   :", (total / leaves) * 200_000);
        console2.log("blocks at 30M gas            :", ((total / leaves) * 200_000) / 30_000_000);
        // ETH at 1 gwei / 5 gwei / 30 gwei, in milli-ETH
        uint256 g = (total / leaves) * 200_000;
        console2.log("ETH at  1 gwei (milli-ETH)   :", g / 1e6);
        console2.log("ETH at  5 gwei (milli-ETH)   :", (g * 5) / 1e6);
        console2.log("ETH at 30 gwei (milli-ETH)   :", (g * 30) / 1e6);
    }
}
