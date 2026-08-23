// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData,
    MultiAttestationRequest
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";

/// Adjudication-tier verification of C5 (bindSchema) and C16 (ingress cost).
contract VerifyEasIngress is Test {
    string internal constant VOUCH = "string comment,uint256 confidence";

    EAS internal eas;
    SchemaRegistry internal reg;
    SchemaRegistrar internal registrar;

    function setUp() public {
        reg = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(reg)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(reg)));
    }

    function _attest(address from, bytes32 schema, address to, bytes memory data)
        internal
        returns (bytes32 uid, uint256 gasUsed)
    {
        vm.prank(from);
        uint256 g0 = gasleft();
        uid = eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: to,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: data,
                    value: 0
                })
            })
        );
        gasUsed = g0 - gasleft();
    }

    // -----------------------------------------------------------------------
    // C5 regression — no foreign leaf can enter before bindSchema.
    // While the resolver is unbound (`boundSchema == 0`) every attestation must
    // revert, including one against an attacker-registered schema.
    // -----------------------------------------------------------------------
    function test_C5_UnboundResolverRejectsForeignLeafAndHonestBindStaysClean() public {
        address deployer = address(0xD1);
        address attacker = address(0xBAD);

        // deploy tx (script tx #1)
        vm.prank(deployer);
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));

        // script tx #2: the honest schema is registered
        bytes32 honest = registrar.register(VOUCH, ISchemaResolver(address(resolver)), true);

        // --- attacker window (open until script tx #6, `--slow` => several blocks) -----------
        // A DIFFERENT schema string, same resolver -> a DIFFERENT uid. No front-run of
        // bindSchema; the attacker never touches bindSchema at all.
        vm.prank(attacker);
        bytes32 foreign = reg.register("uint256 poison", ISchemaResolver(address(resolver)), true);
        assertTrue(foreign != honest, "distinct schema uid");
        vm.expectRevert(EASIndexerResolver.SchemaNotBound.selector);
        _attest(attacker, foreign, address(0xF00D), abi.encode(uint256(1)));
        assertEq(resolver.leafCount(), 0, "unbound resolver folded a foreign edge");
        assertEq(resolver.acc(), bytes32(0), "unbound resolver accumulator was poisoned");

        // script tx #6: the honest bind succeeds with a clean accumulator.
        vm.prank(deployer);
        resolver.bindSchema(honest);
        assertEq(resolver.boundSchema(), honest);

        _attest(address(0xA11CE), honest, address(0xBEEF), abi.encode("hi", uint256(50)));
        assertEq(resolver.leafCount(), 1);
        console2.log("unbound foreign leaf rejected; honest schema starts from a clean accumulator");
    }

    /// Sanity: after binding, the same foreign schema is rejected. The guard works; it just
    /// starts too late.
    function test_C5_AfterBindTheSameForeignAttestationIsRejected() public {
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 honest = registrar.register(VOUCH, ISchemaResolver(address(resolver)), true);
        resolver.bindSchema(honest);
        bytes32 foreign = reg.register("uint256 poison", ISchemaResolver(address(resolver)), true);
        vm.expectRevert();
        _attest(address(0xBAD), foreign, address(0xF00D), abi.encode(uint256(1)));
        assertEq(resolver.leafCount(), 0);
    }

    /// The cost of the grief itself.
    function test_C5_BindSchemaGriefGas() public {
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        vm.prank(address(0xBAD));
        uint256 g0 = gasleft();
        resolver.bindSchema(bytes32(uint256(0xDEAD)));
        console2.log("bindSchema grief execution gas:", g0 - gasleft());
    }

    // -----------------------------------------------------------------------
    // C16 — the cheapest per-leaf ingress an attacker can buy.
    // -----------------------------------------------------------------------
    function test_C16_CheapestGasPerFoldedLeaf() public {
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 s = registrar.register(VOUCH, ISchemaResolver(address(resolver)), true);
        resolver.bindSchema(s);

        address att = address(0xA11CE);
        // warm the accumulator slots
        (bytes32 warm,) = _attest(att, s, address(0xB0B), abi.encode("", uint256(0)));
        vm.prank(att);
        eas.revoke(RevocationRequest({schema: s, data: RevocationRequestData({uid: warm, value: 0})}));

        // measure a steady-state attest + revoke pair against the SAME recipient (warm) and the
        // smallest well-formed payload the schema accepts.
        bytes memory minimal = abi.encode("", uint256(0));
        uint256 attestGas;
        uint256 revokeGas;
        uint256 n = 10;
        for (uint256 i = 0; i < n; i++) {
            (bytes32 uid, uint256 ga) = _attest(att, s, address(0xB0B), minimal);
            attestGas += ga;
            vm.prank(att);
            uint256 g0 = gasleft();
            eas.revoke(RevocationRequest({schema: s, data: RevocationRequestData({uid: uid, value: 0})}));
            revokeGas += g0 - gasleft();
        }
        uint256 a = attestGas / n;
        uint256 r = revokeGas / n;
        console2.log("avg attest execution gas :", a);
        console2.log("avg revoke execution gas :", r);
        console2.log("leaves per pair          : 2");
        // add the 21k intrinsic + ~4-500 bytes calldata for each of the two txs
        uint256 perPairTx = a + r + 2 * 21_000 + (260 * 16) + (100 * 16);
        console2.log("full tx gas per 2 leaves :", perPairTx);
        console2.log("gas per leaf (tx-level)  :", perPairTx / 2);
        console2.log("gas to fill 200,000      :", (perPairTx / 2) * 200_000);
        assertEq(resolver.leafCount(), 2 * (n + 1), "every attest and revoke folded");
    }

    /// Multi-attest amortises the intrinsic cost: how many leaves fit in one 30M-gas block?
    function test_C16_LeavesPerBlockViaMultiAttest() public {
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 s = registrar.register(VOUCH, ISchemaResolver(address(resolver)), true);
        resolver.bindSchema(s);

        uint256 n = 50;
        AttestationRequestData[] memory data = new AttestationRequestData[](n);
        for (uint256 i = 0; i < n; i++) {
            data[i] = AttestationRequestData({
                recipient: address(uint160(0xB0B0000 + i)),
                expirationTime: NO_EXPIRATION_TIME,
                revocable: true,
                refUID: EMPTY_UID,
                data: abi.encode("", uint256(0)),
                value: 0
            });
        }
        MultiAttestationRequest[] memory reqs = new MultiAttestationRequest[](1);
        reqs[0] = MultiAttestationRequest({schema: s, data: data});

        uint256 g0 = gasleft();
        eas.multiAttest(reqs);
        uint256 used = g0 - gasleft();
        assertEq(resolver.leafCount(), n);
        console2.log("multiAttest execution gas for 50 leaves:", used);
        console2.log("amortised execution gas per leaf       :", used / n);
        console2.log("leaves per 30M-gas block (approx)      :", 30_000_000 / (used / n));
        console2.log("gas to fill 200,000 leaves             :", (used / n) * 200_000);
    }
}
