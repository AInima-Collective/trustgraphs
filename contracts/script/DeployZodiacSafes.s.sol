// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {Common} from "script/Common.s.sol";

// Safe contracts
import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

// Our modules
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {
    SignerSyncZkModule,
    ISignerSyncCheckpointSource,
    ISignerActivitySource
} from "src/zodiac/SignerSyncZkModule.sol";
import {TrustgraphsParamsController} from "src/factory/TrustgraphsParamsController.sol";

// MerkleSnapshot + verifier interfaces
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

/// @dev Deployment script for a Zodiac-enabled Safe wired to the MerkleGovModule (governance) and
///      the SignerSyncZkModule (ZK-proven owner rotation). Both consume the ZK-proven MerkleSnapshot
///      state (see ZK_ARCHITECTURE.md and SIGNER_SYNC_ZK_PLAN.md).
///
///      The signer module uses the production five-field selection/liveness defaults. Governed
///      factory instances carry the same complete tuple in their creation receipt.
contract DeployZodiacSafes is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public script_output_path = string.concat(root, "/.docker/zodiac_safes_deploy.json");

    struct SafeDeployment {
        address safe;
        address merkleGovModule;
        address signerSyncModule;
        address[] initialSigners;
        uint256 threshold;
        bool modulesEnabled;
        uint256 fundingAmount;
    }

    /**
     * @dev Deploys a Safe with the MerkleGovModule + SignerSyncZkModule and auto-enables them.
     * @param merkleSnapshotAddr The address of the MerkleSnapshot contract.
     * @param signerVerifierAddr The SP1JournalVerifier bound to the SIGNER guest's vkey (NOT the
     *        root verifier — the signer proof is a different program). Pass address(0) only for a
     *        mock-verifier local run.
     */
    function run(string calldata merkleSnapshotAddr, string calldata signerVerifierAddr) public {
        _run(merkleSnapshotAddr, signerVerifierAddr, address(0));
    }

    /// @notice Deploy governance and complete the typed scoring-authority handoff in the same
    ///         broadcast. Dev/factory instances use this overload; legacy snapshots without a
    ///         typed controller retain the two-argument overload above.
    function run(
        string calldata merkleSnapshotAddr,
        string calldata signerVerifierAddr,
        string calldata paramsControllerAddr
    ) public {
        _run(merkleSnapshotAddr, signerVerifierAddr, vm.parseAddress(paramsControllerAddr));
    }

    function _run(string calldata merkleSnapshotAddr, string calldata signerVerifierAddr, address paramsController)
        internal
    {
        address deployer = vm.addr(_privateKey);

        _startBroadcast();

        // Parse MerkleSnapshot address
        MerkleSnapshot merkleSnapshot = MerkleSnapshot(vm.parseAddress(merkleSnapshotAddr));
        address signerVerifier = vm.parseAddress(signerVerifierAddr);

        // Deploy Safe singleton and factory (if needed)
        GnosisSafe safeSingleton = new GnosisSafe();
        GnosisSafeProxyFactory safeFactory = new GnosisSafeProxyFactory();

        // Deploy the Safe with the MerkleGovModule + SignerSyncZkModule
        SafeDeployment memory safe =
            deployZodiacSafeWithMerkle(safeSingleton, safeFactory, deployer, merkleSnapshot, signerVerifier, "Safe1");

        if (paramsController != address(0)) {
            _handoffScoringAuthority(deployer, safe, TrustgraphsParamsController(paramsController));
        }

        vm.stopBroadcast();

        // Write deployment results to JSON
        writeDeploymentResults(safe, address(safeSingleton), address(safeFactory));
    }

    /// @dev The Safe is the execution identity targets observe. Hand both typed scoring seams and
    ///      both modules' governance knobs to it before the deployment can be reported successful.
    function _handoffScoringAuthority(
        address deployer,
        SafeDeployment memory deployment,
        TrustgraphsParamsController controller
    ) internal {
        GnosisSafe safe = GnosisSafe(payable(deployment.safe));
        MerkleGovModule govModule = MerkleGovModule(deployment.merkleGovModule);
        SignerSyncZkModule signerModule = SignerSyncZkModule(deployment.signerSyncModule);

        require(controller.owner() == deployer, "DeployZodiacSafes: deployer is not controller owner");
        controller.transferOwnership(deployment.safe);
        _execSafe(safe, address(controller), abi.encodeWithSignature("acceptOwnership()"), deployer);

        // Configuration of both enabled modules is itself a DAO action after bootstrap.
        govModule.transferOwnership(deployment.safe);
        signerModule.transferOwnership(deployment.safe);

        require(controller.owner() == deployment.safe, "DeployZodiacSafes: controller handoff failed");
        require(govModule.owner() == deployment.safe, "DeployZodiacSafes: gov module handoff failed");
        require(signerModule.owner() == deployment.safe, "DeployZodiacSafes: signer module handoff failed");
    }

    function _execSafe(GnosisSafe safe, address target_, bytes memory data, address signer) internal {
        bool success = safe.execTransaction(
            target_, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(0), generateSignature(signer)
        );
        require(success, "DeployZodiacSafes: Safe execution failed");
    }

    function deployZodiacSafeWithMerkle(
        GnosisSafe safeSingleton,
        GnosisSafeProxyFactory safeFactory,
        address deployer,
        MerkleSnapshot merkleSnapshot,
        address signerVerifier,
        string memory safeName
    ) internal returns (SafeDeployment memory deployment) {
        // Setup with single signer (deployer) and threshold of 1 for easy module enablement
        address[] memory initialSigners = new address[](1);
        initialSigners[0] = deployer;
        uint256 threshold = 1;

        // Create Safe setup data
        bytes memory setupData = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            initialSigners,
            threshold,
            address(0), // to (for optional delegate call)
            "", // data (for optional delegate call)
            address(0), // fallback handler
            address(0), // payment token
            0, // payment
            address(0) // payment receiver
        );

        // Deploy Safe proxy with unique nonce
        address safeProxy = address(
            safeFactory.createProxyWithNonce(
                address(safeSingleton), setupData, uint256(keccak256(abi.encodePacked(safeName, block.timestamp)))
            )
        );

        // Deploy Merkle Gov Module. Construction is silent (indexer discovery ordering); this
        // standalone deployment has no discovery event to wait behind, so announce immediately.
        MerkleGovModule merkleGovModule = new MerkleGovModule(deployer, safeProxy, safeProxy, address(merkleSnapshot));
        merkleGovModule.publishInitialSnapshotBinding();
        // Add the merkle gov module as a hook to the merkle snapshot.
        merkleSnapshot.addHook(IMerkleSnapshotHook(address(merkleGovModule)));

        // Enable the module on the Safe
        // Since we have threshold of 1 and deployer is the signer, we can execute directly
        GnosisSafe safe = GnosisSafe(payable(safeProxy));

        // Prepare module enablement transaction
        bytes memory enableMerkleGovModuleData =
            abi.encodeWithSignature("enableModule(address)", address(merkleGovModule));

        // Execute module enablement as the Safe (threshold is 1, deployer can execute)
        bytes memory signature = generateSignature(deployer);

        // Enable Merkle Gov Module
        bool success = safe.execTransaction(
            address(safe), // to
            0, // value
            enableMerkleGovModuleData, // data
            Enum.Operation.Call, // operation
            0, // safeTxGas
            0, // baseGas
            0, // gasPrice
            address(0), // gasToken
            payable(0), // refundReceiver
            signature // signatures
        );

        // Deploy the SignerSyncZkModule, reusing the verifier / accumulator / paramsHash the
        // MerkleSnapshot already trusts and binding the governance module's activity chain.
        address signerSyncModule =
            _deploySignerModule(deployer, safeProxy, merkleSnapshot, merkleGovModule, signerVerifier);
        bytes memory enableSignerModuleData = abi.encodeWithSignature("enableModule(address)", signerSyncModule);
        bool signerEnabled = safe.execTransaction(
            address(safe),
            0,
            enableSignerModuleData,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(0),
            generateSignature(deployer)
        );

        // Fund the Safe with ETH
        uint256 fundingAmount = 2 ether;
        (bool fundingSuccess,) = safeProxy.call{value: fundingAmount}("");
        require(fundingSuccess, "Failed to fund Safe");

        deployment = SafeDeployment({
            safe: safeProxy,
            merkleGovModule: address(merkleGovModule),
            signerSyncModule: signerSyncModule,
            initialSigners: initialSigners,
            threshold: threshold,
            modulesEnabled: success && signerEnabled,
            fundingAmount: fundingAmount
        });

        // Log the deployment and enablement status
        if (deployment.modulesEnabled) {
            emit SafeModulesEnabled(safeProxy, address(merkleGovModule), signerSyncModule);
        }

        return deployment;
    }

    /// @dev Deploy the SignerSyncZkModule. It reuses the MerkleSnapshot's accumulator + paramsHash (so
    ///      the score root and signer set stay consistent), but MUST use its OWN verifier bound to the
    ///      SIGNER guest's vkey — reusing the MerkleSnapshot's (root-vkey) verifier would reject every
    ///      real signer proof. `signerVerifier` is that dedicated SP1JournalVerifier.
    function _deploySignerModule(
        address deployer,
        address safeProxy,
        MerkleSnapshot merkleSnapshot,
        MerkleGovModule merkleGovModule,
        address signerVerifier
    ) internal returns (address) {
        SignerSyncZkModule signerModule = new SignerSyncZkModule(
            deployer, // owner (transfer to a timelock for production)
            safeProxy, // avatar
            safeProxy, // target
            IZkVerifier(signerVerifier),
            IAttestationAccumulator(address(merkleSnapshot.accumulator())),
            ISignerSyncCheckpointSource(address(merkleSnapshot)),
            ISignerActivitySource(address(merkleGovModule)),
            5,
            2,
            5_000,
            151_200,
            2
        );
        return address(signerModule);
    }

    /// @notice Generate a signature for Safe transaction execution
    /// @dev Creates an approved hash signature (v=1) for single signer execution
    function generateSignature(address signer) internal pure returns (bytes memory) {
        // For single signer with threshold 1, we can use a pre-approved signature
        // v=1 means the signature is approved by the signer (owner)
        // Create approved hash signature format: r=signer, s=0, v=1
        // This works because the signer is an owner and we're marking it as pre-approved
        bytes memory signature = abi.encodePacked(
            uint256(uint160(signer)), // r = signer address padded to 32 bytes
            uint256(0), // s = 0 for approved hash
            uint8(1) // v = 1 for approved hash
        );

        return signature;
    }

    function writeDeploymentResults(SafeDeployment memory safe, address safeSingleton, address safeFactory) internal {
        string memory rootJson = "root";

        // Add deployment note and factory data
        string memory deploymentNote = "Safe has the MerkleGovModule, deployed with a single signer for easy setup.";
        rootJson.serialize("deployment_note", deploymentNote);
        rootJson.serialize("safe_singleton", Strings.toChecksumHexString(safeSingleton));
        rootJson.serialize("safe_factory", Strings.toChecksumHexString(safeFactory));

        // Safe data
        string memory safeJson = "safe";
        safeJson.serialize("address", Strings.toChecksumHexString(safe.safe));
        safeJson.serialize("merkle_gov_module", Strings.toChecksumHexString(safe.merkleGovModule));
        safeJson.serialize("signer_sync_module", Strings.toChecksumHexString(safe.signerSyncModule));
        safeJson.serialize("threshold", safe.threshold);
        vm.serializeBool(safeJson, "modules_enabled", safe.modulesEnabled);
        safeJson = vm.serializeUint(safeJson, "funding_amount", safe.fundingAmount);

        // Add safe to root JSON
        rootJson = rootJson.serialize("safe", safeJson);

        // Write to file
        vm.writeFile(script_output_path, rootJson);

        // Log success message
        console.log("================================================================================");
        console.log("ZODIAC SAFE DEPLOYED AND CONFIGURED");
        console.log("================================================================================");
        console.log("");
        console.log("Safe (MerkleGov):");
        console.log("  Address:", safe.safe);
        console.log("  Balance:", safe.fundingAmount / 1 ether, "ETH");
        console.log("  Merkle Gov Module:", safe.merkleGovModule, safe.modulesEnabled ? "(ENABLED)" : "(NOT ENABLED)");
        console.log("");
        console.log("Module Capabilities:");
        console.log("- Execute governance proposals via Merkle proofs against the ZK-proven MerkleSnapshot root");
        console.log("");
        console.log("Next Steps:");
        console.log("1. The Safe has been funded with 2 ETH and the module is enabled!");
        console.log("2. Submit governance proposals through the MerkleGovModule using merkle proofs");
        console.log("================================================================================");
    }

    // Events for logging
    event SafeModulesEnabled(address indexed safe, address indexed merkleGovModule, address indexed signerSyncModule);
}
