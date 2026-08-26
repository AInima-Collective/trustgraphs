// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedWeightedTrustgraphsFactory} from "src/factory/GovernedWeightedTrustgraphsFactory.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {WeightedTrustgraphsFactory} from "src/factory/WeightedTrustgraphsFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";

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
        return _deploy(
            weightedFactoryAddr,
            governedJson.readAddress(".safe_singleton"),
            governedJson.readAddress(".safe_factory"),
            governedJson.readAddress(".authority_deployer"),
            governedJson.readAddress(".signer_sync_deployer"),
            governedJson.readAddress(".signer_sync_verifier"),
            governedJson.readBytes32(".signer_sync_program_vkey"),
            governedJson.readAddress(".gov_module_deployer")
        );
    }

    /// @notice Public-chain continuation entry point. Reads the shared helpers from the already
    ///         deployed governed trust-graph factory instead of trusting a machine-local
    ///         `.docker` artifact that may belong to an Anvil run.
    function run(string calldata weightedFactoryAddr, string calldata governedFactoryAddr)
        public
        returns (address governedWeightedFactory)
    {
        GovernedTrustgraphsFactory source = GovernedTrustgraphsFactory(vm.parseAddress(governedFactoryAddr));
        return _deploy(
            weightedFactoryAddr,
            source.SAFE_SINGLETON(),
            address(source.SAFE_FACTORY()),
            address(source.AUTHORITY_DEPLOYER()),
            address(source.SIGNER_SYNC_DEPLOYER()),
            address(source.SIGNER_SYNC_VERIFIER()),
            source.SIGNER_SYNC_PROGRAM_VKEY(),
            address(source.GOV_MODULE_DEPLOYER())
        );
    }

    function _deploy(
        string calldata weightedFactoryAddr,
        address safeSingleton,
        address safeFactory,
        address authorityDeployer,
        address signerSyncDeployer,
        address signerSyncVerifier,
        bytes32 signerSyncProgramVKey,
        address govModuleDeployer
    ) internal returns (address governedWeightedFactory) {
        _startBroadcast();
        GovernedWeightedTrustgraphsFactory governed = new GovernedWeightedTrustgraphsFactory(
            WeightedTrustgraphsFactory(vm.parseAddress(weightedFactoryAddr)),
            GnosisSafeProxyFactory(safeFactory),
            safeSingleton,
            GovernedAuthorityDeployer(authorityDeployer),
            SignerSyncModuleDeployer(signerSyncDeployer),
            MerkleGovModuleDeployer(govModuleDeployer),
            IZkVerifier(signerSyncVerifier),
            signerSyncProgramVKey
        );
        vm.stopBroadcast();

        governedWeightedFactory = address(governed);

        string memory json = "governedWeightedFactory";
        json.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        json.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));
        json.serialize("authority_deployer", Strings.toChecksumHexString(authorityDeployer));
        json.serialize("signer_sync_deployer", Strings.toChecksumHexString(signerSyncDeployer));
        json.serialize("signer_sync_verifier", Strings.toChecksumHexString(signerSyncVerifier));
        json.serialize("signer_sync_program_vkey", vm.toString(signerSyncProgramVKey));
        json.serialize("gov_module_deployer", Strings.toChecksumHexString(govModuleDeployer));
        json.serialize("recovery_delay_seconds", governed.RECOVERY_DELAY());
        json = json.serialize("governed_weighted_factory", Strings.toChecksumHexString(governedWeightedFactory));
        vm.writeFile(script_output_path, json);
    }
}
