// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {GovernedWeightedTrustgraphsFactory} from "src/factory/GovernedWeightedTrustgraphsFactory.sol";
import {GovernedTrustComposeFactory} from "src/factory/GovernedTrustComposeFactory.sol";
import {WeightedTrustgraphsFactory} from "src/factory/WeightedTrustgraphsFactory.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";

/// @notice Deploys the governed wrapper for one program factory. The Safe singleton/proxy
///         factory, authority deployer, signer-sync deployer, and gov-module deployer are NOT
///         redeployed: they are read from `.docker/governed_factory_deploy.json` (or from the
///         already-deployed governed trust-graph factory on a public chain) and shared with
///         `GovernedTrustgraphsFactory`, so the indexer's `signerSyncModuleDeployer` source (and
///         every other singleton) keeps one address per chain. The two concrete scripts below
///         differ only in the wrapper they construct and the artifact they write.
abstract contract DeployGovernedWrapper is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public governed_input_path = string.concat(root, "/.docker/governed_factory_deploy.json");

    /// @dev `.docker/<file>` this script writes and the JSON key naming the new wrapper.
    function _artifact() internal pure virtual returns (string memory file, string memory key);
    /// @dev Construct the concrete wrapper around `baseFactory`.
    function _newWrapper(
        address baseFactory,
        GnosisSafeProxyFactory safeFactory,
        address safeSingleton,
        GovernedAuthorityDeployer authorityDeployer,
        SignerSyncModuleDeployer signerSyncDeployer,
        MerkleGovModuleDeployer govModuleDeployer,
        IZkVerifier signerSyncVerifier,
        bytes32 signerSyncProgramVKey
    ) internal virtual returns (GovernedFactoryBase);

    function run(string calldata baseFactoryAddr) public returns (address governedFactory) {
        string memory governedJson = vm.readFile(governed_input_path);
        return _deploy(
            baseFactoryAddr,
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
    ///         the authority for the shared Safe/helper addresses, not a machine-local `.docker`
    ///         artifact that may belong to an Anvil run.
    function run(string calldata baseFactoryAddr, string calldata governedFactoryAddr)
        public
        returns (address governedFactory)
    {
        GovernedTrustgraphsFactory source = GovernedTrustgraphsFactory(vm.parseAddress(governedFactoryAddr));
        return _deploy(
            baseFactoryAddr,
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
        string calldata baseFactoryAddr,
        address safeSingleton,
        address safeFactory,
        address authorityDeployer,
        address signerSyncDeployer,
        address signerSyncVerifier,
        bytes32 signerSyncProgramVKey,
        address govModuleDeployer
    ) internal returns (address governedFactory) {
        _startBroadcast();
        GovernedFactoryBase governed = _newWrapper(
            vm.parseAddress(baseFactoryAddr),
            GnosisSafeProxyFactory(safeFactory),
            safeSingleton,
            GovernedAuthorityDeployer(authorityDeployer),
            SignerSyncModuleDeployer(signerSyncDeployer),
            MerkleGovModuleDeployer(govModuleDeployer),
            IZkVerifier(signerSyncVerifier),
            signerSyncProgramVKey
        );
        vm.stopBroadcast();

        governedFactory = address(governed);
        (string memory file, string memory key) = _artifact();

        string memory json = key;
        json.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        json.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));
        json.serialize("authority_deployer", Strings.toChecksumHexString(authorityDeployer));
        json.serialize("signer_sync_deployer", Strings.toChecksumHexString(signerSyncDeployer));
        json.serialize("signer_sync_verifier", Strings.toChecksumHexString(signerSyncVerifier));
        json.serialize("signer_sync_program_vkey", vm.toString(signerSyncProgramVKey));
        json.serialize("gov_module_deployer", Strings.toChecksumHexString(govModuleDeployer));
        json.serialize("recovery_delay_seconds", governed.RECOVERY_DELAY());
        json = json.serialize(key, Strings.toChecksumHexString(governedFactory));
        vm.writeFile(string.concat(root, "/.docker/", file), json);
    }
}

contract DeployGovernedWeightedTrustgraphsFactory is DeployGovernedWrapper {
    function _artifact() internal pure override returns (string memory, string memory) {
        return ("governed_weighted_factory_deploy.json", "governed_weighted_factory");
    }

    function _newWrapper(
        address baseFactory,
        GnosisSafeProxyFactory safeFactory,
        address safeSingleton,
        GovernedAuthorityDeployer authorityDeployer,
        SignerSyncModuleDeployer signerSyncDeployer,
        MerkleGovModuleDeployer govModuleDeployer,
        IZkVerifier signerSyncVerifier,
        bytes32 signerSyncProgramVKey
    ) internal override returns (GovernedFactoryBase) {
        return new GovernedWeightedTrustgraphsFactory(
            WeightedTrustgraphsFactory(baseFactory),
            safeFactory,
            safeSingleton,
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            signerSyncVerifier,
            signerSyncProgramVKey
        );
    }
}

contract DeployGovernedTrustComposeFactory is DeployGovernedWrapper {
    function _artifact() internal pure override returns (string memory, string memory) {
        return ("governed_compose_factory_deploy.json", "governed_compose_factory");
    }

    function _newWrapper(
        address baseFactory,
        GnosisSafeProxyFactory safeFactory,
        address safeSingleton,
        GovernedAuthorityDeployer authorityDeployer,
        SignerSyncModuleDeployer signerSyncDeployer,
        MerkleGovModuleDeployer govModuleDeployer,
        IZkVerifier signerSyncVerifier,
        bytes32 signerSyncProgramVKey
    ) internal override returns (GovernedFactoryBase) {
        return new GovernedTrustComposeFactory(
            TrustComposeFactory(baseFactory),
            safeFactory,
            safeSingleton,
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            signerSyncVerifier,
            signerSyncProgramVKey
        );
    }
}
