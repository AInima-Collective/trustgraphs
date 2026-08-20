// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedWeightedTrustgraphsFactory} from "contracts/factory/GovernedWeightedTrustgraphsFactory.sol";
import {WeightedTrustgraphsFactory} from "contracts/factory/WeightedTrustgraphsFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "contracts/factory/InstanceDeployers.sol";

/// @notice Deploys the governed wrapper for the weighted factory. The Safe singleton/proxy
///         factory, authority deployer, signer-sync deployer, and gov-module deployer are NOT
///         redeployed: they are read from `.docker/governed_factory_deploy.json` and shared with
///         `GovernedTrustgraphsFactory`, so the indexer's `signerSyncModuleDeployer` source (and
///         every other singleton) keeps one address per chain.
contract DeployGovernedWeightedTrustgraphsFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public governed_input_path = string.concat(root, "/.docker/governed_factory_deploy.json");
    string public script_output_path = string.concat(root, "/.docker/governed_weighted_factory_deploy.json");

    function run(string calldata weightedFactoryAddr) public returns (address governedWeightedFactory) {
        string memory governedJson = vm.readFile(governed_input_path);
        address safeSingleton = governedJson.readAddress(".safe_singleton");
        address safeFactory = governedJson.readAddress(".safe_factory");
        address authorityDeployer = governedJson.readAddress(".authority_deployer");
        address signerSyncDeployer = governedJson.readAddress(".signer_sync_deployer");
        address govModuleDeployer = governedJson.readAddress(".gov_module_deployer");

        vm.startBroadcast(_privateKey);
        GovernedWeightedTrustgraphsFactory governed = new GovernedWeightedTrustgraphsFactory(
            WeightedTrustgraphsFactory(vm.parseAddress(weightedFactoryAddr)),
            GnosisSafeProxyFactory(safeFactory),
            safeSingleton,
            GovernedAuthorityDeployer(authorityDeployer),
            SignerSyncModuleDeployer(signerSyncDeployer),
            MerkleGovModuleDeployer(govModuleDeployer)
        );
        vm.stopBroadcast();

        governedWeightedFactory = address(governed);

        string memory json = "governedWeightedFactory";
        json.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        json.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));
        json.serialize("authority_deployer", Strings.toChecksumHexString(authorityDeployer));
        json.serialize("signer_sync_deployer", Strings.toChecksumHexString(signerSyncDeployer));
        json.serialize("gov_module_deployer", Strings.toChecksumHexString(govModuleDeployer));
        json.serialize("recovery_delay_seconds", governed.RECOVERY_DELAY());
        json = json.serialize("governed_weighted_factory", Strings.toChecksumHexString(governedWeightedFactory));
        vm.writeFile(script_output_path, json);
    }
}
