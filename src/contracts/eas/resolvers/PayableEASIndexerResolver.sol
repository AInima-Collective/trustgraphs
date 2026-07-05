// SPDX-License-Identifier: MIT

pragma solidity 0.8.27;

import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AttestationAttested, AttestationRevoked} from "../../../interfaces/IIndexedEvents.sol";

/// @title PayableEASIndexerResolver
/// @notice A schema resolver that automatically indexes attestations upon creation and enforces payment.
contract PayableEASIndexerResolver is SchemaResolver, Ownable {
    uint256 private _targetValue;

    /// @notice Emitted when the target value is updated.
    /// @param previousValue The previous target value.
    /// @param newValue The new target value.
    event TargetValueUpdated(uint256 previousValue, uint256 newValue);

    /// @notice Emitted when funds are withdrawn.
    /// @param recipient The address that received the funds.
    /// @param amount The amount withdrawn.
    event FundsWithdrawn(address indexed recipient, uint256 amount);

    /// @notice Creates a new PayableEASIndexerResolver instance.
    /// @param eas The EAS contract instance.
    /// @param targetValue The initial target value for the resolver.
    /// @param owner The owner of the contract.
    constructor(IEAS eas, uint256 targetValue, address owner) SchemaResolver(eas) Ownable(owner) {
        _targetValue = targetValue;
    }

    /// @notice Returns whether this resolver accepts payments.
    /// @return Always returns true as this resolver is payable.
    function isPayable() public pure override returns (bool) {
        return true;
    }

    /// @notice Returns the current target value.
    /// @return The target value required for attestations.
    function getTargetValue() external view returns (uint256) {
        return _targetValue;
    }

    /// @notice Updates the target value for attestations.
    /// @param newTargetValue The new target value.
    function setTargetValue(uint256 newTargetValue) external onlyOwner {
        uint256 previousValue = _targetValue;
        _targetValue = newTargetValue;
        emit TargetValueUpdated(previousValue, newTargetValue);
    }

    /// @notice Withdraws accumulated funds to the specified recipient.
    /// @param recipient The address to receive the withdrawn funds.
    function withdraw(address payable recipient) external onlyOwner {
        require(recipient != address(0), "Invalid recipient address");

        uint256 balance = address(this).balance;
        require(balance > 0, "No funds to withdraw");

        (bool success,) = recipient.call{value: balance}("");
        require(success, "Withdrawal failed");

        emit FundsWithdrawn(recipient, balance);
    }

    /// @notice Withdraws all accumulated funds to the owner.
    function withdrawToOwner() external onlyOwner {
        address payable recipient = payable(owner());
        require(recipient != address(0), "Invalid recipient address");

        uint256 balance = address(this).balance;
        require(balance > 0, "No funds to withdraw");

        (bool success,) = recipient.call{value: balance}("");
        require(success, "Withdrawal failed");

        emit FundsWithdrawn(recipient, balance);
    }

    /// @notice Returns the current balance of the contract.
    /// @return The ETH balance held by this contract.
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Indexes the attestation upon creation.
    /// @param attestation The new attestation.
    /// @param value The value sent with the transaction.
    /// @return Whether the attestation is valid and payment was successful.
    function onAttest(Attestation calldata attestation, uint256 value) internal override returns (bool) {
        // Emitted so off-chain indexers can consume attestation events generically.
        emit IEAS.Attested(attestation.recipient, attestation.attester, attestation.uid, attestation.schema);

        // Emit the attestation indexed event for off-chain indexers
        emit AttestationAttested(address(_eas), attestation.uid);

        return value == _targetValue;
    }

    /// @notice Handles attestation revocation.
    /// @param attestation The attestation being revoked.
    /// @return Whether the attestation can be revoked.
    function onRevoke(Attestation calldata attestation, uint256 /*value*/ ) internal override returns (bool) {
        // Emit the attestation revoked event for off-chain indexers
        emit AttestationRevoked(address(_eas), attestation.uid);
        return true;
    }
}
