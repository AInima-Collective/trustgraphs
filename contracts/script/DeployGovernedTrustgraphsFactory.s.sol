// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Common} from "script/Common.s.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";

contract DeployGovernedTrustgraphsFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public script_output_path = string.concat(root, "/.docker/governed_factory_deploy.json");
    string public signer_verifier_input_path = string.concat(root, "/.docker/zk_verifier_signer_deploy.json");

    function run(string calldata factoryAddr)
        public
        returns (address governedFactory, address safeSingleton, address safeFactory)
    {
        string memory signerVerifierJson = vm.readFile(signer_verifier_input_path);
        address signerVerifier = signerVerifierJson.readAddress(".zk_verifier");
        bytes32 signerProgramVKey = signerVerifierJson.readBytes32(".program_vkey");

        return _run(factoryAddr, signerVerifier, signerProgramVKey, "", "");
    }

    /// @notice Public-chain entry point. Reuses the canonical Safe singleton and proxy factory so
    ///         every Safe produced by the browser is visible to the Safe Transaction Service.
    ///         Empty Safe inputs retain the self-deploying local-development behaviour.
    function run(
        string calldata factoryAddr,
        string calldata signerVerifierAddr,
        bytes32 signerProgramVKey,
        string calldata safeSingletonAddr,
        string calldata safeFactoryAddr
    ) public returns (address governedFactory, address safeSingleton, address safeFactory) {
        require(signerProgramVKey != bytes32(0), "DeployGoverned: signer vkey is zero");
        address signerVerifier = vm.parseAddress(signerVerifierAddr);
        require(signerVerifier.code.length != 0, "DeployGoverned: signer verifier has no code");
        return _run(factoryAddr, signerVerifier, signerProgramVKey, safeSingletonAddr, safeFactoryAddr);
    }

    function _run(
        string calldata factoryAddr,
        address signerVerifier,
        bytes32 signerProgramVKey,
        string memory safeSingletonAddr,
        string memory safeFactoryAddr
    ) internal returns (address governedFactory, address safeSingleton, address safeFactory) {
        address baseFactory = vm.parseAddress(factoryAddr);
        require(baseFactory.code.length != 0, "DeployGoverned: base factory has no code");
        bool reuseSafe = bytes(safeSingletonAddr).length != 0 || bytes(safeFactoryAddr).length != 0;
        require(
            !reuseSafe || (bytes(safeSingletonAddr).length != 0 && bytes(safeFactoryAddr).length != 0),
            "DeployGoverned: both Safe addresses are required"
        );

        _startBroadcast();
        GnosisSafe singleton = reuseSafe ? GnosisSafe(payable(vm.parseAddress(safeSingletonAddr))) : new GnosisSafe();
        GnosisSafeProxyFactory proxyFactory =
            reuseSafe ? GnosisSafeProxyFactory(vm.parseAddress(safeFactoryAddr)) : new GnosisSafeProxyFactory();
        require(address(singleton).code.length != 0, "DeployGoverned: Safe singleton has no code");
        require(address(proxyFactory).code.length != 0, "DeployGoverned: Safe factory has no code");
        GovernedAuthorityDeployer authorityDeployer = new GovernedAuthorityDeployer();
        SignerSyncModuleDeployer signerSyncDeployer = new SignerSyncModuleDeployer();
        // Shared by all governed wrappers (weighted + compose read it from this artifact).
        MerkleGovModuleDeployer govModuleDeployer = new MerkleGovModuleDeployer();
        GovernedTrustgraphsFactory governed = new GovernedTrustgraphsFactory(
            TrustgraphsFactory(baseFactory),
            proxyFactory,
            address(singleton),
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            IZkVerifier(signerVerifier),
            signerProgramVKey
        );
        vm.stopBroadcast();

        governedFactory = address(governed);
        safeSingleton = address(singleton);
        safeFactory = address(proxyFactory);

        string memory json = "governedFactory";
        json.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        json.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));
        json.serialize("authority_deployer", Strings.toChecksumHexString(address(authorityDeployer)));
        json.serialize("signer_sync_deployer", Strings.toChecksumHexString(address(signerSyncDeployer)));
        json.serialize("signer_sync_verifier", Strings.toChecksumHexString(signerVerifier));
        json.serialize("signer_sync_program_vkey", vm.toString(signerProgramVKey));
        json.serialize("gov_module_deployer", Strings.toChecksumHexString(address(govModuleDeployer)));
        json.serialize("recovery_delay_seconds", governed.RECOVERY_DELAY());
        json = json.serialize("governed_factory", Strings.toChecksumHexString(governedFactory));
        vm.writeFile(script_output_path, json);
    }
}
