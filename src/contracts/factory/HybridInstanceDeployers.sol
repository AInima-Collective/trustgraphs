// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EasOffchainAnchorRegistry} from "contracts/registry/EasOffchainAnchorRegistry.sol";

/// @title EasOffchainAnchorRegistryDeployer
/// @notice Inert creation-code holder for the hybrid registry, preserving factory EIP-170 margin.
/// @dev Every authority is explicit. This permissionless helper receives no role and cannot bind or
///      mutate a registry after deployment.
contract EasOffchainAnchorRegistryDeployer {
    function deploy(
        IEAS eas,
        bytes32 schemaUid,
        uint64 maxTotalInputs,
        address admin,
        address binder,
        address[] calldata initialRelayers
    ) external returns (EasOffchainAnchorRegistry) {
        return new EasOffchainAnchorRegistry(eas, schemaUid, maxTotalInputs, admin, binder, initialRelayers);
    }
}
