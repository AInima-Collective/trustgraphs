// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/// @notice Emitted when an attestation is attested.
/// @param eas The EAS contract instance.
/// @param uid The UID of the attested attestation.
event AttestationAttested(address indexed eas, bytes32 indexed uid);

/// @notice Emitted when an attestation is revoked.
/// @param eas The EAS contract instance.
/// @param uid The UID of the revoked attestation.
event AttestationRevoked(address indexed eas, bytes32 indexed uid);
