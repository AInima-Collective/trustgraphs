// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedTrustComposeFactory} from "src/factory/GovernedTrustComposeFactory.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
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
        return _deploy(
            trustComposeFactoryAddr,
            governedJson.readAddress(".safe_singleton"),
            governedJson.readAddress(".safe_factory"),
            governedJson.readAddress(".authority_deployer"),
            governedJson.readAddress(".signer_sync_deployer"),
            governedJson.readAddress(".signer_sync_verifier"),
            governedJson.readBytes32(".signer_sync_program_vkey"),
            governedJson.readAddress(".gov_module_deployer")
        );
    }

    /// @notice Public-chain continuation entry point. The live governed trust-graph factory is
    ///         the authority for the shared Safe/helper addresses; local scratch JSON is not.
    function run(string calldata trustComposeFactoryAddr, string calldata governedFactoryAddr)
        public
        returns (address governedComposeFactory)
    {
        GovernedTrustgraphsFactory source = GovernedTrustgraphsFactory(vm.parseAddress(governedFactoryAddr));
        return _deploy(
            trustComposeFactoryAddr,
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
        string calldata trustComposeFactoryAddr,
        address safeSingleton,
        address safeFactory,
        address authorityDeployer,
        address signerSyncDeployer,
        address signerSyncVerifier,
        bytes32 signerSyncProgramVKey,
        address govModuleDeployer
    ) internal returns (address governedComposeFactory) {
        _startBroadcast();
        GovernedTrustComposeFactory governed = new GovernedTrustComposeFactory(
            TrustComposeFactory(vm.parseAddress(trustComposeFactoryAddr)),
            GnosisSafeProxyFactory(safeFactory),
            safeSingleton,
            GovernedAuthorityDeployer(authorityDeployer),
            SignerSyncModuleDeployer(signerSyncDeployer),
            MerkleGovModuleDeployer(govModuleDeployer),
            IZkVerifier(signerSyncVerifier),
            signerSyncProgramVKey
        );
        vm.stopBroadcast();

        governedComposeFactory = address(governed);

        string memory json = "governedComposeFactory";
        json.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        json.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));
        json.serialize("authority_deployer", Strings.toChecksumHexString(authorityDeployer));
        json.serialize("signer_sync_deployer", Strings.toChecksumHexString(signerSyncDeployer));
        json.serialize("signer_sync_verifier", Strings.toChecksumHexString(signerSyncVerifier));
        json.serialize("signer_sync_program_vkey", vm.toString(signerSyncProgramVKey));
        json.serialize("gov_module_deployer", Strings.toChecksumHexString(govModuleDeployer));
        json.serialize("recovery_delay_seconds", governed.RECOVERY_DELAY());
        json = json.serialize("governed_compose_factory", Strings.toChecksumHexString(governedComposeFactory));
        vm.writeFile(script_output_path, json);
    }
}
