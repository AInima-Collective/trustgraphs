// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedImportedTrustgraphsFactory} from "src/factory/GovernedImportedTrustgraphsFactory.sol";
import {ImportedTrustgraphsFactory} from "src/factory/ImportedTrustgraphsFactory.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";

/// @notice Reuses the release's canonical Safe singleton and authority/module deployers.
contract DeployGovernedImportedTrustgraphsFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public script_output_path = string.concat(root, "/.docker/governed_imported_factory_deploy.json");

    function run(string calldata importedFactoryAddr, string calldata governedFactoryAddr)
        public
        returns (address governedImportedFactory)
    {
        address importedFactory = vm.parseAddress(importedFactoryAddr);
        GovernedTrustgraphsFactory governed = GovernedTrustgraphsFactory(vm.parseAddress(governedFactoryAddr));
        require(importedFactory.code.length != 0, "DeployGovernedImported: imported factory has no code");
        require(address(governed).code.length != 0, "DeployGovernedImported: governed factory has no code");

        _startBroadcast();
        GovernedImportedTrustgraphsFactory wrapper = new GovernedImportedTrustgraphsFactory(
            ImportedTrustgraphsFactory(importedFactory),
            governed.SAFE_FACTORY(),
            governed.SAFE_SINGLETON(),
            governed.AUTHORITY_DEPLOYER(),
            governed.SIGNER_SYNC_DEPLOYER(),
            governed.GOV_MODULE_DEPLOYER(),
            governed.PARENT_AUTHORITY_DEPLOYER(),
            governed.SUBNETWORK_REGISTRY(),
            governed.SIGNER_SYNC_VERIFIER(),
            governed.SIGNER_SYNC_PROGRAM_VKEY()
        );
        vm.stopBroadcast();
        governedImportedFactory = address(wrapper);

        string memory json = "governedImportedFactory";
        json = json.serialize("governed_imported_factory", Strings.toChecksumHexString(governedImportedFactory));
        vm.writeFile(script_output_path, json);
    }
}
