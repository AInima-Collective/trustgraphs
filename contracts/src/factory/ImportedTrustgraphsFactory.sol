// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaRecord} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

import {OnchainAttestationImporter} from "src/eas/OnchainAttestationImporter.sol";
import {EASAttestAndImportRouter} from "src/eas/EASAttestAndImportRouter.sol";
import {DistributorAttaching} from "src/factory/DistributorAttaching.sol";
import {SafeOwnerPolicy} from "src/factory/SafeOwnerPolicy.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsController} from "src/factory/TrustgraphsParamsController.sol";
import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer,
    OnchainImportLaneDeployer
} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {TrustgraphsParamsValidator} from "src/params/TrustgraphsParamsValidator.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

/// @title ImportedTrustgraphsBundleDeployer
/// @notice Performs the imported lane's child wiring outside the public factory's runtime.
/// @dev Every child creation code already lives in a purpose-built deployer. This helper holds the
///      orchestration as well, preserving an explicit EIP-170 margin on both public factories. It
///      retains no role: snapshot authority is handed to `admin`, the controller is owned by
///      `admin`, and the importer's pending binder is consumed before `deploy` returns.
contract ImportedTrustgraphsBundleDeployer {
    struct DeployArgs {
        bytes32 instanceId;
        bytes32 schemaUid;
        string metadataURI;
        ParamsCodec.Params params;
        address admin;
        uint64 epochLength;
        bool withDistributor;
    }

    struct Bundle {
        address importer;
        address router;
        address snapshot;
        address distributor;
        address controller;
        bytes32 paramsHash;
        ParamsCodec.Params params;
    }

    IEAS public immutable EAS;
    IZkVerifier public immutable VERIFIER;
    IInstanceRegistry public immutable INSTANCE_REGISTRY;
    MerkleSnapshotDeployer public immutable SNAPSHOT_DEPLOYER;
    MerkleFundDistributorDeployer public immutable DISTRIBUTOR_DEPLOYER;
    TrustgraphsParamsControllerDeployer public immutable PARAMS_CONTROLLER_DEPLOYER;
    OnchainImportLaneDeployer public immutable IMPORT_LANE_DEPLOYER;

    mapping(address controller => address factory) public pendingFinalizer;

    error ZeroAddress();
    error ImportedSchemaNotFound(bytes32 schemaUid);
    error NotPendingFinalizer(address controller, address caller);

    constructor(
        IEAS eas,
        IZkVerifier verifier,
        IInstanceRegistry instanceRegistry,
        MerkleSnapshotDeployer snapshotDeployer,
        MerkleFundDistributorDeployer distributorDeployer,
        TrustgraphsParamsControllerDeployer paramsControllerDeployer,
        OnchainImportLaneDeployer importLaneDeployer
    ) {
        if (
            address(eas) == address(0) || address(verifier) == address(0) || address(instanceRegistry) == address(0)
                || address(snapshotDeployer) == address(0) || address(distributorDeployer) == address(0)
                || address(paramsControllerDeployer) == address(0) || address(importLaneDeployer) == address(0)
        ) revert ZeroAddress();
        EAS = eas;
        VERIFIER = verifier;
        INSTANCE_REGISTRY = instanceRegistry;
        SNAPSHOT_DEPLOYER = snapshotDeployer;
        DISTRIBUTOR_DEPLOYER = distributorDeployer;
        PARAMS_CONTROLLER_DEPLOYER = paramsControllerDeployer;
        IMPORT_LANE_DEPLOYER = importLaneDeployer;
    }

    function deploy(DeployArgs calldata args) external returns (Bundle memory bundle) {
        if (args.admin == address(0)) revert ZeroAddress();
        ParamsCodec.Params memory params = args.params;
        TrustgraphsParamsValidator.validateImportedCreation(params);

        SchemaRecord memory schema = EAS.getSchemaRegistry().getSchema(args.schemaUid);
        if (schema.uid != args.schemaUid) revert ImportedSchemaNotFound(args.schemaUid);

        OnchainAttestationImporter importer;
        EASAttestAndImportRouter router;
        (importer, router) = IMPORT_LANE_DEPLOYER.deploy(EAS, args.schemaUid);

        params.schemaUid = args.schemaUid;
        params.accumulator = address(importer);
        params.chainId = uint64(block.chainid);
        bytes32 paramsHash = ParamsCodec.hash(params);

        MerkleSnapshot snapshot = SNAPSHOT_DEPLOYER.deploy(
            VERIFIER,
            paramsHash,
            IAttestationAccumulator(address(importer)),
            address(this),
            address(this),
            args.metadataURI
        );
        snapshot.enableStateProvenance();
        IMPORT_LANE_DEPLOYER.bindSnapshot(importer, address(snapshot));
        snapshot.setEpochLength(args.epochLength);

        TrustgraphsParamsController controller = PARAMS_CONTROLLER_DEPLOYER.deploy(
            args.instanceId, address(snapshot), INSTANCE_REGISTRY, params, args.admin
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(controller));
        snapshot.renounceRole(snapshot.OPERATIONAL_ROLE(), address(this));
        snapshot.grantRole(snapshot.CONSTITUTIONAL_ROLE(), args.admin);
        snapshot.renounceRole(snapshot.CONSTITUTIONAL_ROLE(), address(this));

        address distributor;
        if (args.withDistributor) {
            distributor = address(DISTRIBUTOR_DEPLOYER.deploy(args.admin, address(snapshot), args.admin, 0, false));
        }

        pendingFinalizer[address(controller)] = msg.sender;
        bundle = Bundle({
            importer: address(importer),
            router: address(router),
            snapshot: address(snapshot),
            distributor: distributor,
            controller: address(controller),
            paramsHash: paramsHash,
            params: params
        });
    }

    /// @notice Publish controller version 1 after its factory discovery event has been emitted.
    function finalize(TrustgraphsParamsController controller) external {
        if (pendingFinalizer[address(controller)] != msg.sender) {
            revert NotPendingFinalizer(address(controller), msg.sender);
        }
        delete pendingFinalizer[address(controller)];
        controller.publishInitialVersion();
    }
}

/// @title ImportedTrustgraphsFactory
/// @notice Creates a complete Trustgraph over one existing, immutable EAS schema.
/// @dev This is a sibling rather than another selector on `TrustgraphsFactory`: the native factory
///      deliberately keeps >3 KB EIP-170 headroom. It emits the byte-identical `InstanceCreated`
///      catalog event, then an additive lane record containing the immutable importer/router tuple.
contract ImportedTrustgraphsFactory is DistributorAttaching {
    uint256 public constant MAX_NAME_BYTES = 64;
    uint32 public constant UNIFORM_WEIGHT_FIELD_INDEX = type(uint32).max;

    IEAS public immutable EAS;
    IZkVerifier public immutable VERIFIER;
    IProvingVault public immutable VAULT;
    ImportedTrustgraphsBundleDeployer public immutable BUNDLE_DEPLOYER;
    uint64 public immutable EPOCH_FLOOR;

    event InstanceCreated(
        bytes32 indexed instanceId,
        address indexed creator,
        address indexed admin,
        string name,
        string metadataURI,
        address resolver,
        bytes32 schemaUid,
        address snapshot,
        address distributor,
        address distributorToken,
        uint64 epochLength,
        ParamsCodec.Params params
    );
    event ImportedEasLaneCreated(
        bytes32 indexed instanceId, address indexed importer, address indexed router, address eas, bytes32 schemaUid
    );
    event ParamsControllerCreated(bytes32 indexed instanceId, address indexed controller);
    event InstancePrepaid(bytes32 indexed instanceId, address indexed from, uint256 amount);

    error ZeroEpochFloor();
    error InvalidAdmin();
    error EmptyName();
    error NameTooLong(uint256 length);
    error NoVaultConfigured();

    constructor(
        ImportedTrustgraphsBundleDeployer bundleDeployer,
        MerkleFundDistributorDeployer distributorDeployer,
        uint64 epochFloor,
        IProvingVault vault
    ) DistributorAttaching(keccak256("trust-graph"), bundleDeployer.INSTANCE_REGISTRY(), distributorDeployer) {
        if (address(bundleDeployer) == address(0)) revert ZeroAddress();
        if (address(bundleDeployer.DISTRIBUTOR_DEPLOYER()) != address(distributorDeployer)) revert ZeroAddress();
        if (epochFloor == 0) revert ZeroEpochFloor();
        BUNDLE_DEPLOYER = bundleDeployer;
        EAS = bundleDeployer.EAS();
        VERIFIER = bundleDeployer.VERIFIER();
        VAULT = vault;
        EPOCH_FLOOR = epochFloor;
    }

    function createImportedInstance(TrustgraphsFactory.CreateArgs calldata args, bytes32 importedSchemaUid)
        external
        payable
        returns (bytes32 instanceId, address snapshot, address importer, address distributor, bytes32 schemaUid)
    {
        if (msg.value != 0 && address(VAULT) == address(0)) {
            revert NoVaultConfigured();
        }
        uint256 nameLength = bytes(args.name).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength);

        address admin = args.admin == address(0) ? msg.sender : args.admin;
        if (admin == address(this)) revert InvalidAdmin();
        if (args.withDistributor && !SafeOwnerPolicy.isSafe(admin)) revert InvalidDistributorSafe(admin);
        instanceId = computeInstanceId(msg.sender, args.name, args.salt);
        uint64 epochLength = args.epochLength < EPOCH_FLOOR ? EPOCH_FLOOR : args.epochLength;

        ImportedTrustgraphsBundleDeployer.Bundle memory bundle = BUNDLE_DEPLOYER.deploy(
            ImportedTrustgraphsBundleDeployer.DeployArgs({
                instanceId: instanceId,
                schemaUid: importedSchemaUid,
                metadataURI: args.metadataURI,
                params: args.params,
                admin: admin,
                epochLength: epochLength,
                withDistributor: args.withDistributor
            })
        );
        snapshot = bundle.snapshot;
        importer = bundle.importer;
        distributor = bundle.distributor;
        schemaUid = importedSchemaUid;
        if (distributor != address(0)) distributorOf[instanceId] = distributor;

        INSTANCE_REGISTRY.registerWithParamsAuthority(
            instanceId,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: snapshot,
                verifier: address(VERIFIER),
                registryOrAccumulator: importer,
                paramsHash: bundle.paramsHash
            }),
            bundle.controller
        );

        if (msg.value != 0) {
            VAULT.depositETH{value: msg.value}(instanceId);
            emit InstancePrepaid(instanceId, msg.sender, msg.value);
        }

        emit InstanceCreated(
            instanceId,
            msg.sender,
            admin,
            args.name,
            args.metadataURI,
            importer,
            schemaUid,
            snapshot,
            distributor,
            args.distributorToken,
            epochLength,
            bundle.params
        );
        emit ImportedEasLaneCreated(instanceId, importer, bundle.router, address(EAS), schemaUid);
        emit ParamsControllerCreated(instanceId, bundle.controller);
        BUNDLE_DEPLOYER.finalize(TrustgraphsParamsController(bundle.controller));
    }

    function validateParams(ParamsCodec.Params calldata params) external pure {
        ParamsCodec.Params memory copy = params;
        TrustgraphsParamsValidator.validateImportedCreation(copy);
    }
}
