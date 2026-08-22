// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EMPTY_UID, NO_EXPIRATION_TIME} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/// @title SeedGraph
/// @notice Seeds a demo-sized vouching graph (21 edges over 14 accounts) into one factory instance,
///         so the app shows a network with structure instead of the 3-edge `E2eAttest` ring.
///
/// @dev Usage — pass the instance's OWN schema uid (a foreign schema reverts `ForeignSchema`) and
///      the trusted seed from its on-chain params:
///
///          forge script contracts/script/SeedGraph.s.sol:SeedGraph \
///            --sig 'run(address,bytes32,address)' <eas> <schemaUid> <trustedSeed> \
///            --rpc-url http://127.0.0.1:8545 --broadcast
///
///      The topology is deliberate, and it is what makes the score list interesting:
///        * the trusted seed vouches IN, so the graph is rooted — without that, PageRank finds every
///          node unreachable and the whole list collapses to the teleport floor;
///        * three rings at increasing distance from the seed, so `trust_decay` is visible;
///        * four recipient-only accounts that never send a transaction, to show that being scored
///          costs a member nothing;
///        * a three-account sybil ring that vouches for itself at maximum confidence and is
///          unreachable from the seed, so it lands at the bottom of the list.
///
///      Anvil's well-known mnemonic — PUBLIC test keys, zero value. Local use only. Accounts 0-9 are
///      the funded ones and can attest; 10-13 are recipients only, and need no balance.
contract SeedGraph is Script {
    string constant MNEMONIC = "test test test test test test test test test test test junk";

    uint32 constant ATTESTERS = 10;
    uint32 constant NODES = 14;

    /// @notice Vouching edges as indices into the ordered node list (`n[0]` is the trusted seed).
    /// @dev from, to, confidence (0-100 — the schema's `confidence` field, clamped to
    ///      `max_weight_fp` and used as the relative edge weight).
    function _edges() internal pure returns (uint8[3][21] memory e, string[21] memory comments) {
        e = [
            // the seed roots the network
            [uint8(0), 1, 95],
            [uint8(0), 2, 85],
            [uint8(0), 3, 70],
            [uint8(1), 0, 90],
            // core ring
            [uint8(1), 2, 80],
            [uint8(1), 4, 75],
            [uint8(1), 10, 60],
            [uint8(2), 3, 65],
            [uint8(2), 5, 55],
            [uint8(2), 11, 50],
            [uint8(3), 4, 60],
            [uint8(3), 12, 45],
            [uint8(4), 5, 50],
            [uint8(4), 1, 70],
            // periphery, further from the seed
            [uint8(5), 6, 40],
            [uint8(6), 13, 35],
            [uint8(6), 5, 45],
            // sybil ring: maximum confidence, no path from the seed
            [uint8(7), 8, 100],
            [uint8(8), 7, 100],
            [uint8(7), 9, 100],
            [uint8(9), 7, 100]
        ];
        comments = [
            "founding member",
            "long-time collaborator",
            "new here, doing good work",
            "started this network",
            "ships every week",
            "reviews carefully",
            "wrote most of the docs",
            "solid engineer",
            "shows up when it matters",
            "organizes the meetups",
            "good judgement under pressure",
            "occasional contributor",
            "we pair on hard problems",
            "carried the last release",
            "newcomer, promising",
            "small fixes, steady",
            "mentored me",
            "trust me",
            "trust me too",
            "one of us",
            "all of us"
        ];
    }

    function run(address easAddr, bytes32 schema, address trustedSeed) external {
        IEAS eas = IEAS(easAddr);

        // Order the accounts so index 0 is the instance's trusted seed; the rest keep anvil order.
        uint256[] memory keys = new uint256[](ATTESTERS);
        address[] memory nodes = new address[](NODES);
        uint32 seedIdx = ATTESTERS;
        for (uint32 i = 0; i < ATTESTERS; i++) {
            if (vm.addr(vm.deriveKey(MNEMONIC, i)) == trustedSeed) seedIdx = i;
        }
        require(seedIdx < ATTESTERS, "trustedSeed is not one of anvil accounts 0-9");

        keys[0] = vm.deriveKey(MNEMONIC, seedIdx);
        nodes[0] = trustedSeed;
        uint32 slot = 1;
        for (uint32 i = 0; i < ATTESTERS; i++) {
            if (i == seedIdx) continue;
            keys[slot] = vm.deriveKey(MNEMONIC, i);
            nodes[slot] = vm.addr(keys[slot]);
            slot++;
        }
        // Recipient-only members: they are scored without ever sending a transaction.
        for (uint32 i = 0; i < NODES - ATTESTERS; i++) {
            nodes[ATTESTERS + i] = vm.addr(vm.deriveKey(MNEMONIC, ATTESTERS + i));
        }

        (uint8[3][21] memory edges, string[21] memory comments) = _edges();
        for (uint256 i = 0; i < edges.length; i++) {
            _attest(eas, keys[edges[i][0]], schema, nodes[edges[i][1]], comments[i], edges[i][2]);
        }

        console.log("seeded", edges.length, "vouches over", NODES);
        console.log("  trusted seed:  ", nodes[0]);
        console.log("  sybil ring:    ", nodes[7]);
        console.log("                 ", nodes[8]);
        console.log("                 ", nodes[9]);
    }

    function _attest(IEAS eas, uint256 pk, bytes32 schema, address recipient, string memory comment, uint256 confidence)
        internal
        returns (bytes32 uid)
    {
        vm.startBroadcast(pk);
        uid = eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode(comment, confidence),
                    value: 0
                })
            })
        );
        vm.stopBroadcast();
    }
}
