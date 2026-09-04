// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EMPTY_UID, NO_EXPIRATION_TIME} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import {Common} from "script/Common.s.sol";
import {console} from "forge-std/console.sol";

/// @title EASAttest
/// @notice Foundry script for making direct EAS attestations with optional payment
/// @dev Provides methods to attest directly to EAS contracts with or without ETH payment.
///      This script is designed to work with the Taskfile.yml forge tasks and can be used
///      for both standalone attestations and integration with payment-enabled resolvers.
///
/// @custom:usage Via Taskfile (recommended):
///      task forge:trigger-statement-attestation INPUT="Hello World"
///
/// @custom:usage Direct forge script execution:
///      forge script contracts/script/EASAttest.s.sol:EASAttest \
///        --sig "attestWithMilliEth(string,string,string,string,uint256)" \
///        "0xEAS_CONTRACT_ADDRESS" \
///        "0xSCHEMA_UID" \
///        "0xRECIPIENT_ADDRESS" \
///        "Hello World" \
///        1 \
///        --rpc-url http://localhost:8545 --broadcast
contract EASAttest is Common {
    /// @notice Create a vouching attestation
    /// @param easAddr The EAS contract address (hex string with 0x prefix)
    /// @param vouchingSchema The vouching schema UID (hex string with 0x prefix, 32 bytes)
    /// @param recipient The recipient address (hex string with 0x prefix)
    /// @param comment The comment string
    /// @param confidence The confidence level (0-100)
    function vouch(
        string calldata easAddr,
        string calldata vouchingSchema,
        string calldata recipient,
        string calldata comment,
        uint256 confidence
    ) public {
        _startBroadcast();
        address attester = vm.addr(_privateKey);

        IEAS eas = IEAS(vm.parseAddress(easAddr));
        bytes32 vouchingSchemaUID = vm.parseBytes32(vouchingSchema);
        address recipientAddr = vm.parseAddress(recipient);
        bytes memory data = abi.encode(comment, confidence);

        console.log("Making vouching attestation:");
        console.log("  EAS Address:", easAddr);
        console.log("  Vouching Schema:", vouchingSchema);
        console.log("  Attester:", attester);
        console.log("  Recipient:", recipient);
        console.log("  Comment:", comment);
        console.log("  Confidence:", confidence);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipientAddr,
            expirationTime: NO_EXPIRATION_TIME,
            revocable: true,
            refUID: EMPTY_UID,
            data: data,
            value: 0
        });

        AttestationRequest memory request = AttestationRequest({schema: vouchingSchemaUID, data: requestData});

        bytes32 attestationUID = eas.attest(request);

        console.log("Vouching attestation created with UID:", vm.toString(attestationUID));

        vm.stopBroadcast();
    }

    /// @notice Make a direct attestation to EAS without payment
    /// @param easAddr The EAS contract address (hex string with 0x prefix)
    /// @param schema The schema UID (hex string with 0x prefix, 32 bytes)
    /// @param recipient The recipient address (hex string with 0x prefix, use 0x0 for no specific recipient)
    /// @param data The attestation data string (will be encoded as bytes)
    /// @dev Creates a revocable attestation with no expiration time and no payment.
    ///      Uses the private key from FUNDED_KEY environment variable for signing.
    function attest(string calldata easAddr, string calldata schema, string calldata recipient, string calldata data)
        public
    {
        _startBroadcast();

        IEAS eas = IEAS(vm.parseAddress(easAddr));
        bytes32 schemaUID = vm.parseBytes32(schema);
        address recipientAddr = vm.parseAddress(recipient);

        console.log("Making direct EAS attestation:");
        console.log("  EAS Address:", easAddr);
        console.log("  Schema:", schema);
        console.log("  Recipient:", recipient);
        console.log("  Data:", data);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipientAddr,
            expirationTime: NO_EXPIRATION_TIME,
            revocable: true,
            refUID: EMPTY_UID,
            data: bytes(data),
            value: 0
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest(request);

        console.log("Attestation created with UID:", vm.toString(attestationUID));

        vm.stopBroadcast();
    }

    /// @notice Make a direct attestation to EAS with ETH payment
    /// @param easAddr The EAS contract address (hex string with 0x prefix)
    /// @param schema The schema UID (hex string with 0x prefix, 32 bytes)
    /// @param recipient The recipient address (hex string with 0x prefix)
    /// @param data The attestation data string (will be encoded as bytes)
    /// @param value The ETH value to send (in wei)
    /// @dev Creates a revocable attestation with no expiration time and specified payment.
    ///      The payment is sent along with the attestation transaction and can be used
    ///      by payment-enabled resolvers.
    ///      Uses the private key from FUNDED_KEY environment variable for signing.
    function attestWithPayment(
        string calldata easAddr,
        string calldata schema,
        string calldata recipient,
        string calldata data,
        uint256 value
    ) public {
        _startBroadcast();

        IEAS eas = IEAS(vm.parseAddress(easAddr));
        bytes32 schemaUID = vm.parseBytes32(schema);
        address recipientAddr = vm.parseAddress(recipient);

        console.log("Making direct EAS attestation with payment:");
        console.log("  EAS Address:", easAddr);
        console.log("  Schema:", schema);
        console.log("  Recipient:", recipient);
        console.log("  Data:", data);
        console.log("  Payment (wei):", value);
        console.log("  Payment (ETH):", value / 1e18);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipientAddr,
            expirationTime: NO_EXPIRATION_TIME,
            revocable: true,
            refUID: EMPTY_UID,
            data: bytes(data),
            value: value
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest{value: value}(request);

        console.log("Attestation created with UID:", vm.toString(attestationUID));
        console.log("Payment of", value, "wei sent with attestation");

        vm.stopBroadcast();
    }

    /// @notice Make an attestation with payment using milliether amount (convenience method)
    /// @param easAddr The EAS contract address (hex string with 0x prefix)
    /// @param schema The schema UID (hex string with 0x prefix, 32 bytes)
    /// @param recipient The recipient address (hex string with 0x prefix)
    /// @param data The attestation data string (will be encoded as bytes)
    /// @param milliEthAmount The amount in milliether (1 = 0.001 ETH, 5 = 0.005 ETH)
    /// @dev Convenience wrapper around attestWithPayment that converts milliether to wei.
    ///      Commonly used amounts: 1 = 0.001 ETH, 10 = 0.01 ETH, 100 = 0.1 ETH.
    ///      This method is used by the forge:trigger-statement-attestation task with 1 milliETH.
    function attestWithMilliEth(
        string calldata easAddr,
        string calldata schema,
        string calldata recipient,
        string calldata data,
        uint256 milliEthAmount
    ) public {
        uint256 weiAmount = milliEthAmount * 1e15; // 1 milliether = 1e15 wei
        attestWithPayment(easAddr, schema, recipient, data, weiAmount);
    }
}
