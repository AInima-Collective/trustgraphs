// SPDX-License-Identifier: MIT

pragma solidity 0.8.27;

import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AttestationAttested, AttestationRevoked} from "../../../interfaces/IIndexedEvents.sol";

/// @title AttesterEASIndexerResolver
/// @notice A schema resolver that automatically indexes attestations and checks whether the attestation is from a specific attester.
contract AttesterEASIndexerResolver is SchemaResolver, Ownable {
    address private _targetAttester;

    /// @notice Emitted when the target attester is updated.
    /// @param oldAttester The previous target attester address.
    /// @param newAttester The new target attester address.
    event TargetAttesterUpdated(address indexed oldAttester, address indexed newAttester);

    /// @notice Creates a new AttesterEASIndexerResolver instance.
    /// @param eas The EAS contract instance.
    /// @param targetAttester The address of the target attester.
    /// @param owner The address that will own this contract.
    constructor(IEAS eas, address targetAttester, address owner) SchemaResolver(eas) Ownable(owner) {
        _targetAttester = targetAttester;
    }

    /// @notice Updates the target attester address.
    /// @param newTargetAttester The new target attester address.
    function setTargetAttester(address newTargetAttester) external onlyOwner {
        address oldAttester = _targetAttester;
        _targetAttester = newTargetAttester;
        emit TargetAttesterUpdated(oldAttester, newTargetAttester);
    }

    /// @notice Returns the current target attester address.
    /// @return The target attester address.
    function getTargetAttester() external view returns (address) {
        return _targetAttester;
    }

    /// @notice Indexes the attestation upon creation.
    /// @param attestation The new attestation.
    /// @return Whether the attestation is valid and was successfully indexed.
    function onAttest(
        Attestation calldata attestation,
        uint256 /*value*/
    )
        internal
        override
        returns (bool)
    {
        // Emitted so off-chain indexers can consume attestation events generically.
        emit IEAS.Attested(attestation.recipient, attestation.attester, attestation.uid, attestation.schema);

        // Emit the attestation indexed event for off-chain indexers
        emit AttestationAttested(address(_eas), attestation.uid);

        return attestation.attester == _targetAttester;
    }

    /// @notice Handles attestation revocation.
    /// @return Whether the attestation can be revoked.
    function onRevoke(
        Attestation calldata attestation,
        uint256 /*value*/
    )
        internal
        override
        returns (bool)
    {
        // Emit the attestation revoked event for off-chain indexers
        emit AttestationRevoked(address(_eas), attestation.uid);
        return true;
    }
}
