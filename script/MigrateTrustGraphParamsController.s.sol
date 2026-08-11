// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {console} from "forge-std/console.sol";

import {TrustGraphParamsController} from "contracts/factory/TrustGraphParamsController.sol";
import {TrustGraphParamsControllerDeployer} from "contracts/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

import {Common} from "script/Common.s.sol";
import {ParamsJson} from "script/lib/ParamsJson.sol";

/// @title MigrateTrustGraphParamsController
/// @notice Guarded grant-before-revoke ceremony for one legacy trust-graph instance.
/// @dev The broadcasting authority must be able to set the registry association and administer the
///      snapshot's OPERATIONAL_ROLE. For a Safe/timelock, use these calls as the ordered batch rather
///      than attempting to bypass that network's constitutional path.
contract MigrateTrustGraphParamsController is Common {
    function run(
        bytes32 instanceId,
        address snapshotAddress,
        address registryAddress,
        address controllerDeployerAddress,
        string calldata paramsPath,
        bytes32 schemaUid,
        address accumulator,
        uint64 chainId,
        address controllerOwner,
        address[] calldata legacyOperationalHolders
    ) external returns (address controllerAddress) {
        require(snapshotAddress != address(0), "migration: snapshot is zero");
        require(registryAddress != address(0), "migration: registry is zero");
        require(controllerDeployerAddress != address(0), "migration: deployer is zero");
        require(controllerOwner != address(0), "migration: owner is zero");
        require(legacyOperationalHolders.length != 0, "migration: enumerate legacy holders");

        MerkleSnapshot snapshot = MerkleSnapshot(snapshotAddress);
        InstanceRegistry registry = InstanceRegistry(registryAddress);
        IInstanceRegistry.Instance memory beforeRecord = registry.getInstance(instanceId);
        require(beforeRecord.snapshot == snapshotAddress, "migration: registry snapshot mismatch");

        ParamsCodec.Params memory params = ParamsJson.read(paramsPath, schemaUid, accumulator, chainId);
        bytes32 expectedHash = ParamsCodec.hash(params);
        require(snapshot.paramsHash() == expectedHash, "migration: tuple does not match snapshot");
        require(beforeRecord.paramsHash == expectedHash, "migration: tuple does not match registry");
        require(registry.paramsAuthority(instanceId) == address(0), "migration: authority already registered");

        vm.startBroadcast(_privateKey);

        TrustGraphParamsController controller = TrustGraphParamsControllerDeployer(controllerDeployerAddress)
            .deploy(instanceId, snapshotAddress, IInstanceRegistry(registryAddress), params, controllerOwner);
        controllerAddress = address(controller);

        // Association first, grant second, revoke last. At no point is the legacy path removed
        // before the replacement is both discoverable and live.
        registry.setParamsAuthority(instanceId, controllerAddress);
        bytes32 operationalRole = snapshot.OPERATIONAL_ROLE();
        snapshot.grantRole(operationalRole, controllerAddress);
        require(snapshot.hasRole(operationalRole, controllerAddress), "migration: controller grant failed");
        controller.publishInitialVersion();

        for (uint256 i = 0; i < legacyOperationalHolders.length; i++) {
            address holder = legacyOperationalHolders[i];
            require(holder != address(0), "migration: zero legacy holder");
            require(holder != controllerAddress, "migration: controller listed as legacy");
            if (snapshot.hasRole(operationalRole, holder)) {
                snapshot.revokeRole(operationalRole, holder);
            }
        }

        vm.stopBroadcast();

        // Post-conditions are deliberately repeated after broadcast so a partial ceremony is never
        // printed as complete.
        require(registry.paramsAuthority(instanceId) == controllerAddress, "migration: registry association failed");
        require(snapshot.hasRole(operationalRole, controllerAddress), "migration: controller role missing");
        for (uint256 i = 0; i < legacyOperationalHolders.length; i++) {
            require(
                !snapshot.hasRole(operationalRole, legacyOperationalHolders[i]),
                "migration: legacy operational holder remains"
            );
        }
        require(controller.owner() == controllerOwner, "migration: wrong controller owner");
        require(controller.currentParamsHash() == expectedHash, "migration: controller hash mismatch");
        require(snapshot.paramsHash() == expectedHash, "migration: snapshot hash changed");
        require(registry.getInstance(instanceId).paramsHash == expectedHash, "migration: registry hash changed");

        console.log("TrustGraphParamsController:", controllerAddress);
    }
}
