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

        _startBroadcast();
        GnosisSafe singleton = new GnosisSafe();
        GnosisSafeProxyFactory proxyFactory = new GnosisSafeProxyFactory();
        GovernedAuthorityDeployer authorityDeployer = new GovernedAuthorityDeployer();
        SignerSyncModuleDeployer signerSyncDeployer = new SignerSyncModuleDeployer();
        // Shared by all governed wrappers (weighted + compose read it from this artifact).
        MerkleGovModuleDeployer govModuleDeployer = new MerkleGovModuleDeployer();
        GovernedTrustgraphsFactory governed = new GovernedTrustgraphsFactory(
            TrustgraphsFactory(vm.parseAddress(factoryAddr)),
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
