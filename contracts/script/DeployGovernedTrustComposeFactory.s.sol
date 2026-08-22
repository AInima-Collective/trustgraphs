// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedTrustComposeFactory} from "src/factory/GovernedTrustComposeFactory.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";

/// @notice Deploys the governed wrapper for the trust-compose factory. Shares the Safe
///         singleton/proxy factory and all three helper deployers with
///         `GovernedTrustgraphsFactory` (read from `.docker/governed_factory_deploy.json`), so
///         every singleton keeps one address per chain and the indexer's
///         `signerSyncModuleDeployer` source needs no change.
contract DeployGovernedTrustComposeFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public governed_input_path = string.concat(root, "/.docker/governed_factory_deploy.json");
    string public script_output_path = string.concat(root, "/.docker/governed_compose_factory_deploy.json");

    function run(string calldata trustComposeFactoryAddr) public returns (address governedComposeFactory) {
        string memory governedJson = vm.readFile(governed_input_path);
        address safeSingleton = governedJson.readAddress(".safe_singleton");
        address safeFactory = governedJson.readAddress(".safe_factory");
        address authorityDeployer = governedJson.readAddress(".authority_deployer");
        address signerSyncDeployer = governedJson.readAddress(".signer_sync_deployer");
        address govModuleDeployer = governedJson.readAddress(".gov_module_deployer");

        vm.startBroadcast(_privateKey);
        GovernedTrustComposeFactory governed = new GovernedTrustComposeFactory(
            TrustComposeFactory(vm.parseAddress(trustComposeFactoryAddr)),
            GnosisSafeProxyFactory(safeFactory),
            safeSingleton,
            GovernedAuthorityDeployer(authorityDeployer),
            SignerSyncModuleDeployer(signerSyncDeployer),
            MerkleGovModuleDeployer(govModuleDeployer)
        );
        vm.stopBroadcast();

        governedComposeFactory = address(governed);

        string memory json = "governedComposeFactory";
        json.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        json.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));
        json.serialize("authority_deployer", Strings.toChecksumHexString(authorityDeployer));
        json.serialize("signer_sync_deployer", Strings.toChecksumHexString(signerSyncDeployer));
        json.serialize("gov_module_deployer", Strings.toChecksumHexString(govModuleDeployer));
        json.serialize("recovery_delay_seconds", governed.RECOVERY_DELAY());
        json = json.serialize("governed_compose_factory", Strings.toChecksumHexString(governedComposeFactory));
        vm.writeFile(script_output_path, json);
    }
}
