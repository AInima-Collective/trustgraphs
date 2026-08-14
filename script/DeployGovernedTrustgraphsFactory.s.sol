// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedTrustgraphsFactory} from "contracts/factory/GovernedTrustgraphsFactory.sol";
import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {GovernedAuthorityDeployer} from "contracts/factory/InstanceDeployers.sol";

contract DeployGovernedTrustgraphsFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public script_output_path = string.concat(root, "/.docker/governed_factory_deploy.json");

    function run(string calldata factoryAddr)
        public
        returns (address governedFactory, address safeSingleton, address safeFactory)
    {
        vm.startBroadcast(_privateKey);
        GnosisSafe singleton = new GnosisSafe();
        GnosisSafeProxyFactory proxyFactory = new GnosisSafeProxyFactory();
        GovernedAuthorityDeployer authorityDeployer = new GovernedAuthorityDeployer();
        GovernedTrustgraphsFactory governed = new GovernedTrustgraphsFactory(
            TrustgraphsFactory(vm.parseAddress(factoryAddr)), proxyFactory, address(singleton), authorityDeployer
        );
        vm.stopBroadcast();

        governedFactory = address(governed);
        safeSingleton = address(singleton);
        safeFactory = address(proxyFactory);

        string memory json = "governedFactory";
        json.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        json.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));
        json.serialize("authority_deployer", Strings.toChecksumHexString(address(authorityDeployer)));
        json.serialize("recovery_delay_seconds", governed.RECOVERY_DELAY());
        json = json.serialize("governed_factory", Strings.toChecksumHexString(governedFactory));
        vm.writeFile(script_output_path, json);
    }
}
