// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {Common} from "script/Common.s.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @notice Completes the dev seed's distributor only after its Zodiac Safe exists.
/// @dev The base instance is initially controlled by the deployer so the rest of the dev bootstrap
///      can run. This script temporarily grants the new Safe constitutional authority, uses the
///      factory's guarded attachment path, restores the prior role set, and records both addresses
///      in the derived network artifact. The distributor remains Safe-owned permanently.
contract AttachDevDistributor is Common {
    using stdJson for string;

    function run(
        string calldata factoryAddr,
        string calldata snapshotAddr,
        string calldata safeAddr,
        string calldata networkArtifactPath
    ) public returns (address distributor) {
        TrustgraphsFactory factory = TrustgraphsFactory(vm.parseAddress(factoryAddr));
        MerkleSnapshot snapshot = MerkleSnapshot(vm.parseAddress(snapshotAddr));
        address safe = vm.parseAddress(safeAddr);
        require(address(factory) != address(0), "AttachDevDistributor: factory is zero");
        require(address(snapshot) != address(0), "AttachDevDistributor: snapshot is zero");
        require(safe != address(0), "AttachDevDistributor: Safe is zero");

        bytes32 instanceId = _findInstanceIdBySnapshot(factory.INSTANCE_REGISTRY(), address(snapshot));
        distributor = factory.distributorOf(instanceId);

        if (distributor == address(0)) {
            bytes32 role = snapshot.CONSTITUTIONAL_ROLE();
            bool safeAlreadyHeldRole = snapshot.hasRole(role, safe);

            _startBroadcast();
            if (!safeAlreadyHeldRole) snapshot.grantRole(role, safe);
            distributor = factory.attachDistributor(instanceId, safe, address(0));
            if (!safeAlreadyHeldRole) snapshot.revokeRole(role, safe);
            vm.stopBroadcast();
        }

        if (bytes(networkArtifactPath).length != 0) {
            string memory artifact = string.concat(vm.projectRoot(), "/", networkArtifactPath);
            vm.writeJson(Strings.toChecksumHexString(distributor), artifact, ".contracts.fund_distributor");
            vm.writeJson(Strings.toChecksumHexString(safe), artifact, ".contracts.governance_safe");
        }
    }

    function _findInstanceIdBySnapshot(IInstanceRegistry registry, address snapshot) internal view returns (bytes32) {
        bytes32[] memory ids = registry.getInstanceIds();
        for (uint256 i; i < ids.length; ++i) {
            if (registry.getInstance(ids[i]).snapshot == snapshot) return ids[i];
        }
        revert("AttachDevDistributor: snapshot is not a registered instance");
    }
}
