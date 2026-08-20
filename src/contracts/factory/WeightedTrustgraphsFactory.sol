// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";
import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";
import {WeightedPriorParamsController} from "contracts/factory/WeightedPriorParamsController.sol";
import {WeightedPriorParamsControllerDeployer} from "contracts/factory/WeightedInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "contracts/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {WeightedPriorParamsCodec} from "contracts/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "contracts/params/WeightedPriorValidator.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

/// @title WeightedTrustgraphsFactory
/// @notice Isolated one-transaction factory for the `trust-graph-weighted` program.
/// @dev Existing binary-seed factories and controllers are deliberately untouched.
contract WeightedTrustgraphsFactory {
    struct CreateArgs {
        string name;
        string metadataURI;
        WeightedPriorParamsCodec.Params params;
        /// Exact canonical TGWP bytes. The transaction input is the recovery source.
        bytes manifest;
        /// Digest of the non-consensus provenance document for this prior.
        bytes32 metadataDigest;
        address admin;
        uint64 epochLength;
        bool withDistributor;
        address distributorToken;
        bytes32 salt;
    }

    event WeightedInstanceCreated(
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
        bytes32 metadataDigest,
        WeightedPriorParamsCodec.Params params
    );

    event WeightedParamsControllerCreated(bytes32 indexed instanceId, address indexed controller);
    event InstancePrepaid(bytes32 indexed instanceId, address indexed from, uint256 amount);
    event SchemaAdopted(bytes32 indexed instanceId, bytes32 schemaUid);
    /// @notice A fund distributor was attached to an existing instance after creation.
    ///         `distributorToken` is presentation only, exactly like the creation-time field.
    event DistributorAttached(bytes32 indexed instanceId, address distributor, address distributorToken);

    string public constant VOUCH_SCHEMA = "string comment,uint256 confidence";
    bytes32 public constant PROGRAM = keccak256("trust-graph-weighted");
    uint256 public constant MAX_NAME_BYTES = 64;

    IEAS public immutable EAS;
    SchemaRegistrar public immutable SCHEMA_REGISTRAR;
    IZkVerifier public immutable VERIFIER;
    IInstanceRegistry public immutable INSTANCE_REGISTRY;
    IProvingVault public immutable VAULT;
    MerkleSnapshotDeployer public immutable SNAPSHOT_DEPLOYER;
    MerkleFundDistributorDeployer public immutable DISTRIBUTOR_DEPLOYER;
    WeightedPriorParamsControllerDeployer public immutable PARAMS_CONTROLLER_DEPLOYER;
    uint64 public immutable EPOCH_FLOOR;
    uint48 public immutable PRIOR_ACTIVATION_DELAY;

    /// @notice The one fund distributor this factory knows per instance: the creation-time one,
    ///         or the one `attachDistributor` deployed later. Zero means "none yet".
    mapping(bytes32 instanceId => address distributor) public distributorOf;

    error ZeroAddress();
    error ZeroEpochFloor();
    error ZeroActivationDelay();
    error InvalidAdmin();
    error EmptyName();
    error NameTooLong(uint256 length);
    error NoVaultConfigured();
    error ChainIdTooLarge(uint256 chainId);
    error SchemaUidMismatch(bytes32 registered, bytes32 expected);
    error UnknownInstance(bytes32 instanceId);
    error NotInstanceAuthority(bytes32 instanceId, address owner);
    error DistributorAlreadyAttached(bytes32 instanceId, address distributor);

    constructor(
        IEAS eas,
        SchemaRegistrar schemaRegistrar,
        IZkVerifier verifier,
        IInstanceRegistry instanceRegistry,
        MerkleSnapshotDeployer snapshotDeployer,
        MerkleFundDistributorDeployer distributorDeployer,
        WeightedPriorParamsControllerDeployer paramsControllerDeployer,
        uint64 epochFloor,
        uint48 priorActivationDelay,
        IProvingVault vault
    ) {
        if (
            address(eas) == address(0) || address(schemaRegistrar) == address(0) || address(verifier) == address(0)
                || address(instanceRegistry) == address(0) || address(snapshotDeployer) == address(0)
                || address(distributorDeployer) == address(0) || address(paramsControllerDeployer) == address(0)
        ) revert ZeroAddress();
        if (epochFloor == 0) revert ZeroEpochFloor();
        if (priorActivationDelay == 0) revert ZeroActivationDelay();

        EAS = eas;
        SCHEMA_REGISTRAR = schemaRegistrar;
        VERIFIER = verifier;
        INSTANCE_REGISTRY = instanceRegistry;
        SNAPSHOT_DEPLOYER = snapshotDeployer;
        DISTRIBUTOR_DEPLOYER = distributorDeployer;
        PARAMS_CONTROLLER_DEPLOYER = paramsControllerDeployer;
        EPOCH_FLOOR = epochFloor;
        PRIOR_ACTIVATION_DELAY = priorActivationDelay;
        VAULT = vault;
    }

    function createInstance(CreateArgs calldata args)
        external
        payable
        returns (bytes32 instanceId, address snapshot, address resolver, address distributor, bytes32 schemaUid)
    {
        if (msg.value != 0 && address(VAULT) == address(0)) {
            revert NoVaultConfigured();
        }
        uint256 nameLength = bytes(args.name).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength);
        if (block.chainid > type(uint64).max) revert ChainIdTooLarge(block.chainid);

        WeightedPriorParamsCodec.Params memory params = args.params;
        WeightedPriorValidator.validateCreation(params);
        WeightedPriorValidator.Commitment memory prior =
            WeightedPriorValidator.validateManifest(args.manifest, uint64(block.chainid));

        address admin = args.admin == address(0) ? msg.sender : args.admin;
        if (admin == address(this)) revert InvalidAdmin();
        instanceId = computeInstanceId(msg.sender, args.name, args.salt);

        EASIndexerResolver indexerResolver = new EASIndexerResolver(EAS);
        resolver = address(indexerResolver);
        schemaUid = keccak256(abi.encodePacked(VOUCH_SCHEMA, resolver, true));
        try SCHEMA_REGISTRAR.register(VOUCH_SCHEMA, ISchemaResolver(resolver), true) returns (bytes32 registered) {
            if (registered != schemaUid) revert SchemaUidMismatch(registered, schemaUid);
        } catch {
            emit SchemaAdopted(instanceId, schemaUid);
        }
        indexerResolver.bindSchema(schemaUid);

        params.priorRoot = prior.priorRoot;
        params.priorCount = prior.priorCount;
        params.manifestSha256 = prior.manifestSha256;
        params.schemaUid = schemaUid;
        params.accumulator = resolver;
        params.chainId = uint64(block.chainid);
        bytes32 paramsHash = WeightedPriorParamsCodec.hash(params);

        MerkleSnapshot merkleSnapshot = SNAPSHOT_DEPLOYER.deploy(
            VERIFIER, paramsHash, IAttestationAccumulator(resolver), address(this), address(this)
        );
        snapshot = address(merkleSnapshot);
        indexerResolver.bindSnapshot(snapshot);

        uint64 epochLength = args.epochLength < EPOCH_FLOOR ? EPOCH_FLOOR : args.epochLength;
        merkleSnapshot.setEpochLength(epochLength);
        WeightedPriorParamsController controller = PARAMS_CONTROLLER_DEPLOYER.deploy(
            instanceId,
            snapshot,
            INSTANCE_REGISTRY,
            params,
            args.manifest,
            args.metadataDigest,
            admin,
            PRIOR_ACTIVATION_DELAY
        );

        merkleSnapshot.grantRole(merkleSnapshot.OPERATIONAL_ROLE(), address(controller));
        merkleSnapshot.renounceRole(merkleSnapshot.OPERATIONAL_ROLE(), address(this));
        merkleSnapshot.grantRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), admin);
        merkleSnapshot.renounceRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), address(this));

        if (args.withDistributor) {
            distributor = address(DISTRIBUTOR_DEPLOYER.deploy(admin, snapshot, admin, 0, false));
            distributorOf[instanceId] = distributor;
        }

        INSTANCE_REGISTRY.registerWithParamsAuthority(
            instanceId,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: snapshot,
                verifier: address(VERIFIER),
                registryOrAccumulator: resolver,
                paramsHash: paramsHash
            }),
            address(controller)
        );

        if (msg.value != 0) {
            VAULT.depositETH{value: msg.value}(instanceId);
            emit InstancePrepaid(instanceId, msg.sender, msg.value);
        }

        emit WeightedInstanceCreated(
            instanceId,
            msg.sender,
            admin,
            args.name,
            args.metadataURI,
            resolver,
            schemaUid,
            snapshot,
            distributor,
            args.distributorToken,
            epochLength,
            args.metadataDigest,
            params
        );
        emit WeightedParamsControllerCreated(instanceId, address(controller));
        controller.publishInitialVersion();
    }

    /// @notice Attach a fund distributor to an instance created without one. Permissionless to
    ///         CALL — anyone may pay the gas — but the deployed fund is owned by `owner`, which
    ///         must hold the instance's constitutional role right now. Same terms as the
    ///         creation-time path: fee 0, `feeRecipient = owner`.
    function attachDistributor(bytes32 instanceId, address owner, address distributorToken)
        external
        returns (address distributor)
    {
        // An unregistered id reverts inside the registry (`InstanceNotFound`); this factory only
        // adds the program check so it never serves another program's instance.
        IInstanceRegistry.Instance memory record = INSTANCE_REGISTRY.getInstance(instanceId);
        if (record.program != PROGRAM) revert UnknownInstance(instanceId);
        address existing = distributorOf[instanceId];
        if (existing != address(0)) revert DistributorAlreadyAttached(instanceId, existing);
        MerkleSnapshot snapshot = MerkleSnapshot(record.snapshot);
        if (!snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), owner)) {
            revert NotInstanceAuthority(instanceId, owner);
        }
        distributor = address(DISTRIBUTOR_DEPLOYER.deploy(owner, record.snapshot, owner, 0, false));
        distributorOf[instanceId] = distributor;
        emit DistributorAttached(instanceId, distributor, distributorToken);
    }

    function computeInstanceId(address creator, string calldata name, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, name, salt));
    }

    function validateCreation(WeightedPriorParamsCodec.Params calldata params, bytes calldata manifest) external view {
        if (block.chainid > type(uint64).max) revert ChainIdTooLarge(block.chainid);
        WeightedPriorParamsCodec.Params memory paramsMemory = params;
        WeightedPriorValidator.validateCreation(paramsMemory);
        WeightedPriorValidator.validateManifest(manifest, uint64(block.chainid));
    }
}
