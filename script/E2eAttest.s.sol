// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {
    EMPTY_UID,
    NO_EXPIRATION_TIME
} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/// @title E2eAttest
/// @notice Creates a small vouching ring (3 attests from 3 accounts) + 1 revoke, so the accumulator
///         folds 4 edges (3 attest, 1 revoke). Uses anvil's well-known public test keys — LOCAL ONLY.
contract E2eAttest is Script {
    // Anvil default mnemonic ("test test ... junk") — PUBLIC test keys, zero value. Local use only.
    uint256 constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant K1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant K2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    function run(address easAddr, bytes32 schema) external {
        IEAS eas = IEAS(easAddr);
        address a0 = vm.addr(K0);
        address a1 = vm.addr(K1);
        address a2 = vm.addr(K2);

        bytes32 uid0 = _attest(eas, K0, schema, a1, "a0 -> a1", 50);
        _attest(eas, K1, schema, a2, "a1 -> a2", 75);
        _attest(eas, K2, schema, a0, "a2 -> a0", 90);

        // Revoke the first attestation (its attester, a0, revokes it) -> a kind=1 fold.
        vm.startBroadcast(K0);
        eas.revoke(RevocationRequest({schema: schema, data: RevocationRequestData({uid: uid0, value: 0})}));
        vm.stopBroadcast();

        console.log("attested 3, revoked 1 -> expected checkpoint leafCount = 4");
    }

    function _attest(
        IEAS eas,
        uint256 pk,
        bytes32 schema,
        address recipient,
        string memory comment,
        uint256 confidence
    ) internal returns (bytes32 uid) {
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
