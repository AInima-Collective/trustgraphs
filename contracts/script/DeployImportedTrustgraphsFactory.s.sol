// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {
    ImportedTrustgraphsFactory,
    ImportedTrustgraphsBundleDeployer
} from "src/factory/ImportedTrustgraphsFactory.sol";
import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer,
    OnchainImportLaneDeployer
} from "src/factory/InstanceDeployers.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

/// @notice Additive deployment for #117. It is separate from DeployFactory so an existing release
///         can add the imported flavor without replacing or redeploying its canonical factory.
contract DeployImportedTrustgraphsFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public script_output_path = string.concat(root, "/.docker/imported_factory_deploy.json");

    function run(
        string calldata easAddr,
        string calldata verifierAddr,
        string calldata instanceRegistryAddr,
        uint64 epochFloor,
        string calldata vaultAddr
    ) public returns (address factory) {
        address eas = vm.parseAddress(easAddr);
        address verifier = vm.parseAddress(verifierAddr);
        address registryAddress = vm.parseAddress(instanceRegistryAddr);
        IProvingVault vault =
            bytes(vaultAddr).length == 0 ? IProvingVault(address(0)) : IProvingVault(vm.parseAddress(vaultAddr));
        require(eas.code.length != 0, "DeployImported: EAS has no code");
        require(verifier.code.length != 0, "DeployImported: verifier has no code");
        require(registryAddress.code.length != 0, "DeployImported: registry has no code");
        require(epochFloor != 0, "DeployImported: epoch floor is zero");

        _startBroadcast();
        MerkleSnapshotDeployer snapshotDeployer = new MerkleSnapshotDeployer();
        MerkleFundDistributorDeployer distributorDeployer = new MerkleFundDistributorDeployer();
        TrustgraphsParamsControllerDeployer paramsControllerDeployer = new TrustgraphsParamsControllerDeployer();
        OnchainImportLaneDeployer importLaneDeployer = new OnchainImportLaneDeployer();
        ImportedTrustgraphsBundleDeployer bundleDeployer = new ImportedTrustgraphsBundleDeployer(
            IEAS(eas),
            IZkVerifier(verifier),
            IInstanceRegistry(registryAddress),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            importLaneDeployer
        );
        ImportedTrustgraphsFactory imported =
            new ImportedTrustgraphsFactory(bundleDeployer, distributorDeployer, epochFloor, vault);
        factory = address(imported);

        if (vm.envOr("GRANT_REGISTRAR", true)) {
            InstanceRegistry registry = InstanceRegistry(registryAddress);
            registry.grantRole(registry.REGISTRAR_ROLE(), factory);
            require(registry.hasRole(registry.REGISTRAR_ROLE(), factory), "DeployImported: registrar grant failed");
            require(!registry.hasRole(registry.OPERATOR_ROLE(), factory), "DeployImported: factory has operator role");
        }
        vm.stopBroadcast();

        string memory json = "importedFactory";
        json.serialize("snapshot_deployer", Strings.toChecksumHexString(address(snapshotDeployer)));
        json.serialize("distributor_deployer", Strings.toChecksumHexString(address(distributorDeployer)));
        json.serialize("params_controller_deployer", Strings.toChecksumHexString(address(paramsControllerDeployer)));
        json.serialize("import_lane_deployer", Strings.toChecksumHexString(address(importLaneDeployer)));
        json.serialize("bundle_deployer", Strings.toChecksumHexString(address(bundleDeployer)));
        json = json.serialize("imported_factory", Strings.toChecksumHexString(factory));
        vm.writeFile(script_output_path, json);
    }
}
