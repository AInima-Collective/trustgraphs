// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {stdJson} from "forge-std/StdJson.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {EasOffchainAnchorRegistryDeployer} from "src/factory/HybridInstanceDeployers.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    ParentAuthorityModuleDeployer,
    SignerSyncModuleDeployer,
    TrustgraphsParamsControllerDeployer
} from "src/factory/InstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {SubnetworkRegistry} from "src/registry/SubnetworkRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {Common} from "script/Common.s.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";

contract EasOffchainE2ESignerVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice Self-contained Anvil deployment for the strict EAS off-chain e2e.
/// @dev Production deployment remains split into reviewed scripts. This fixture intentionally
///      creates the same factory path in one broadcast so CI has one deterministic setup command.
contract DeployEasOffchainE2E is Common {
    using stdJson for string;

    function run(string calldata relayerA_, string calldata relayerB_)
        external
        returns (address factoryAddress, bytes32 instanceId, address snapshot, address resolver, address anchorRegistry)
    {
        address relayerA = vm.parseAddress(relayerA_);
        address relayerB = vm.parseAddress(relayerB_);
        require(relayerA != address(0) && relayerB != address(0) && relayerA != relayerB, "distinct relayers");

        address deployer = vm.addr(_privateKey);
        _startBroadcast();

        SchemaRegistry schemaRegistry = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        SchemaRegistrar schemaRegistrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        MockZkVerifier verifier = new MockZkVerifier();
        InstanceRegistry directory = new InstanceRegistry(deployer);
        MerkleSnapshotDeployer snapshotDeployer = new MerkleSnapshotDeployer();
        MerkleFundDistributorDeployer distributorDeployer = new MerkleFundDistributorDeployer();
        TrustgraphsParamsControllerDeployer paramsControllerDeployer = new TrustgraphsParamsControllerDeployer();
        EasOffchainAnchorRegistryDeployer easRegistryDeployer = new EasOffchainAnchorRegistryDeployer();

        TrustgraphsFactory factory = new TrustgraphsFactory(
            IEAS(address(eas)),
            schemaRegistrar,
            IZkVerifier(address(verifier)),
            IInstanceRegistry(address(directory)),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            easRegistryDeployer,
            1,
            IProvingVault(address(0))
        );
        directory.grantRole(directory.REGISTRAR_ROLE(), address(factory));

        ParamsCodec.Params memory params;
        params.dampingFp = 850_000_000_000_000_000;
        params.toleranceFp = 1_000_000_000_000;
        params.maxIterations = 100;
        params.minWeightFp = 0;
        params.maxWeightFp = 100_000_000_000_000_000_000;
        params.trustShareFp = 1_000_000_000_000_000_000;
        params.trustDecayFp = 800_000_000_000_000_000;
        params.trustedSeeds = new address[](2);
        params.trustedSeeds[0] = deployer;
        params.trustedSeeds[1] = relayerA;
        params.totalPool = 1_000_000_000_000_000_000_000_000;
        params.precisionScale = 1_000_000_000_000_000_000;
        params.weightFieldIndex = 1;

        TrustgraphsFactory.CreateArgs memory args;
        args.name = "strict-eas-offchain-e2e";
        args.metadataURI = "ipfs://strict-eas-offchain-e2e";
        args.params = params;
        args.admin = deployer;
        args.epochLength = 1;
        args.salt = keccak256("strict-eas-offchain-e2e-v1");

        address[] memory relayers = new address[](2);
        relayers[0] = relayerA;
        relayers[1] = relayerB;
        TrustgraphsFactory.OffchainEasConfig memory offchain =
            TrustgraphsFactory.OffchainEasConfig({maxTotalInputs: 200_000, initialRelayers: relayers});

        bytes32 schemaUid;
        (instanceId, snapshot, resolver,, schemaUid) = factory.createHybridInstance(args, offchain);
        anchorRegistry = address(MerkleSnapshot(snapshot).anchorRegistry());
        factoryAddress = address(factory);

        // The browser acceptance path uses the same governed wrapper as the product wizard. Keep
        // the seed hybrid above deterministic, then deploy the real Safe/guard/recovery stack so
        // CI can prove app creation without weakening the wizard's sealed-authority preflight.
        GnosisSafe safeSingleton = new GnosisSafe();
        GnosisSafeProxyFactory safeFactory = new GnosisSafeProxyFactory();
        GovernedAuthorityDeployer authorityDeployer = new GovernedAuthorityDeployer();
        SignerSyncModuleDeployer signerSyncDeployer = new SignerSyncModuleDeployer();
        MerkleGovModuleDeployer govModuleDeployer = new MerkleGovModuleDeployer();
        ParentAuthorityModuleDeployer parentAuthorityDeployer = new ParentAuthorityModuleDeployer();
        SubnetworkRegistry subnetworkRegistry = new SubnetworkRegistry(directory, deployer);
        bytes32 signerProgramVKey = keccak256("eas-offchain-e2e-signer");
        EasOffchainE2ESignerVerifier signerVerifier = new EasOffchainE2ESignerVerifier(signerProgramVKey);
        GovernedTrustgraphsFactory governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            parentAuthorityDeployer,
            subnetworkRegistry,
            signerVerifier,
            signerProgramVKey
        );
        vm.stopBroadcast();

        string memory output = "eas-offchain-e2e";
        output.serialize("chain_id", block.chainid);
        output.serialize("factory", Strings.toChecksumHexString(factoryAddress));
        output.serialize("instance_id", instanceId);
        output.serialize("instance_registry", Strings.toChecksumHexString(address(directory)));
        output.serialize("eas", Strings.toChecksumHexString(address(eas)));
        output.serialize("eas_version", eas.version());
        output.serialize("schema_registry", Strings.toChecksumHexString(address(schemaRegistry)));
        output.serialize("schema_registrar", Strings.toChecksumHexString(address(schemaRegistrar)));
        output.serialize("schema_uid", schemaUid);
        output.serialize("snapshot", Strings.toChecksumHexString(snapshot));
        output.serialize("resolver", Strings.toChecksumHexString(resolver));
        output.serialize("anchor_registry", Strings.toChecksumHexString(anchorRegistry));
        output.serialize("governed_factory", Strings.toChecksumHexString(address(governedFactory)));
        output.serialize("safe_singleton", Strings.toChecksumHexString(address(safeSingleton)));
        output.serialize("safe_factory", Strings.toChecksumHexString(address(safeFactory)));
        output.serialize("authority_deployer", Strings.toChecksumHexString(address(authorityDeployer)));
        output.serialize("signer_sync_deployer", Strings.toChecksumHexString(address(signerSyncDeployer)));
        output.serialize("gov_module_deployer", Strings.toChecksumHexString(address(govModuleDeployer)));
        output.serialize("relayer_a", Strings.toChecksumHexString(relayerA));
        string memory json = output.serialize("relayer_b", Strings.toChecksumHexString(relayerB));

        string memory path =
            vm.envOr("EAS_OFFCHAIN_E2E_DEPLOY_FILE", string.concat(vm.projectRoot(), "/.trustgraph/e2e/deploy.json"));
        vm.createDir(string.concat(vm.projectRoot(), "/.trustgraph/e2e"), true);
        vm.writeJson(json, path);
    }
}
