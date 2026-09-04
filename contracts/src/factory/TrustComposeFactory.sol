// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {TrustComposeParamsController} from "src/factory/TrustComposeParamsController.sol";
import {
    CompositionSourceAccumulatorDeployer,
    TrustComposeParamsControllerDeployer
} from "src/factory/TrustComposeInstanceDeployers.sol";
import {SafeOwnerPolicy} from "src/factory/SafeOwnerPolicy.sol";
import {DistributorAttaching} from "src/factory/DistributorAttaching.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

/// @title TrustComposeFactory
/// @notice Isolated one-transaction factory/registry path for the `trust-compose` program.
///         Registers the same `trust-compose` program as V1 — a differently named composition
///         program would be invisible to the immutable V1 adapters' nested-composition rejection —
///         and is distinguished by its typed controller params, verifier, and program key.
contract TrustComposeFactory is DistributorAttaching {
    struct CreateArgs {
        string name;
        string metadataURI;
        TrustComposeParamsCodec.Params params;
        bytes policyManifest;
        address[] sourceAdapters;
        bytes32 metadataDigest;
        /// Instance authority. Must be an initialized Safe when `withDistributor` is true.
        address admin;
        uint64 epochLength;
        bool withDistributor;
        address distributorToken;
        bytes32 salt;
    }

    event TrustComposeInstanceCreated(
        bytes32 indexed instanceId,
        address indexed creator,
        address indexed admin,
        string name,
        string metadataURI,
        address accumulator,
        address snapshot,
        address distributor,
        address distributorToken,
        uint64 epochLength,
        bytes32 programVKey,
        bytes32 metadataDigest,
        TrustComposeParamsCodec.Params params
    );
    event TrustComposeParamsControllerCreated(bytes32 indexed instanceId, address indexed controller);
    event InstancePrepaid(bytes32 indexed instanceId, address indexed from, uint256 amount);

    uint256 public constant MAX_NAME_BYTES = 64;

    IZkVerifier public immutable VERIFIER;
    bytes32 public immutable PROGRAM_VKEY;
    ICompositionSourceAdapterFactory public immutable SOURCE_ADAPTER_FACTORY;
    MerkleSnapshotDeployer public immutable SNAPSHOT_DEPLOYER;
    CompositionSourceAccumulatorDeployer public immutable ACCUMULATOR_DEPLOYER;
    TrustComposeParamsControllerDeployer public immutable PARAMS_CONTROLLER_DEPLOYER;
    IProvingVault public immutable VAULT;
    uint64 public immutable EPOCH_FLOOR;
    uint48 public immutable POLICY_ACTIVATION_DELAY;

    error ZeroEpochFloor();
    error ZeroActivationDelay();
    error InvalidAdmin();
    error EmptyName();
    error NameTooLong(uint256 length);
    error NoVaultConfigured();
    error ChainIdTooLarge(uint256 chainId);
    error InvalidCompositionVerifier();
    error ProgramVKeyMismatch(bytes32 expected, bytes32 actual);
    error SourceAdapterRegistryMismatch(address expected, address actual);

    constructor(
        IZkVerifier verifier,
        bytes32 programVKey,
        IInstanceRegistry instanceRegistry,
        ICompositionSourceAdapterFactory sourceAdapterFactory,
        MerkleSnapshotDeployer snapshotDeployer,
        MerkleFundDistributorDeployer distributorDeployer,
        CompositionSourceAccumulatorDeployer accumulatorDeployer,
        TrustComposeParamsControllerDeployer paramsControllerDeployer,
        uint64 epochFloor,
        uint48 policyActivationDelay,
        IProvingVault vault
    ) DistributorAttaching(keccak256("trust-compose"), instanceRegistry, distributorDeployer) {
        if (
            address(verifier) == address(0) || address(instanceRegistry) == address(0)
                || address(sourceAdapterFactory) == address(0) || address(snapshotDeployer) == address(0)
                || address(distributorDeployer) == address(0) || address(accumulatorDeployer) == address(0)
                || address(paramsControllerDeployer) == address(0)
        ) revert ZeroAddress();
        if (programVKey == bytes32(0)) revert InvalidCompositionVerifier();
        if (epochFloor == 0) revert ZeroEpochFloor();
        if (policyActivationDelay == 0) revert ZeroActivationDelay();
        (bool ok, bytes memory returned) = address(verifier).staticcall(abi.encodeWithSignature("programVKey()"));
        if (!ok || returned.length != 32) revert InvalidCompositionVerifier();
        bytes32 verifierVKey = abi.decode(returned, (bytes32));
        if (verifierVKey != programVKey) revert ProgramVKeyMismatch(programVKey, verifierVKey);
        address adapterRegistry = address(sourceAdapterFactory.registry());
        if (adapterRegistry != address(instanceRegistry)) {
            revert SourceAdapterRegistryMismatch(address(instanceRegistry), adapterRegistry);
        }

        VERIFIER = verifier;
        PROGRAM_VKEY = programVKey;
        SOURCE_ADAPTER_FACTORY = sourceAdapterFactory;
        SNAPSHOT_DEPLOYER = snapshotDeployer;
        ACCUMULATOR_DEPLOYER = accumulatorDeployer;
        PARAMS_CONTROLLER_DEPLOYER = paramsControllerDeployer;
        EPOCH_FLOOR = epochFloor;
        POLICY_ACTIVATION_DELAY = policyActivationDelay;
        VAULT = vault;
    }

    function createInstance(CreateArgs calldata args)
        external
        payable
        returns (bytes32 instanceId, address snapshot, address accumulatorAddress, address distributor)
    {
        if (msg.value != 0 && address(VAULT) == address(0)) revert NoVaultConfigured();
        uint256 nameLength = bytes(args.name).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength);
        if (block.chainid > type(uint64).max) revert ChainIdTooLarge(block.chainid);

        TrustComposeParamsCodec.Params memory params = args.params;
        TrustComposeValidator.validateCreation(params);
        TrustComposeValidator.Commitment memory policy = TrustComposeValidator.validatePolicyManifest(
            args.policyManifest, uint64(block.chainid), params.maxSourceAgeBlocks
        );
        address admin = args.admin == address(0) ? msg.sender : args.admin;
        if (admin == address(this)) revert InvalidAdmin();
        if (args.withDistributor && !SafeOwnerPolicy.isSafe(admin)) revert InvalidDistributorSafe(admin);
        instanceId = computeInstanceId(msg.sender, args.name, args.salt);

        CompositionSourceAccumulator accumulator = ACCUMULATOR_DEPLOYER.deploy(SOURCE_ADAPTER_FACTORY);
        accumulatorAddress = address(accumulator);
        params.sourcePolicyRoot = policy.sourcePolicyRoot;
        params.sourceCount = policy.sourceCount;
        params.policyManifestSha256 = policy.manifestSha256;
        params.accumulator = accumulatorAddress;
        params.chainId = uint64(block.chainid);
        bytes32 paramsHash = TrustComposeParamsCodec.hash(params);

        MerkleSnapshot merkleSnapshot = SNAPSHOT_DEPLOYER.deploy(
            VERIFIER,
            paramsHash,
            IAttestationAccumulator(accumulatorAddress),
            address(this),
            address(this),
            args.metadataURI
        );
        snapshot = address(merkleSnapshot);
        // Composition indexers must authenticate the exact accepted checkpoint, params, verifier,
        // codehash, and program key instead of inferring acceptance from a root-shaped event.
        merkleSnapshot.enableStateProvenance();
        uint64 epochLength = args.epochLength < EPOCH_FLOOR ? EPOCH_FLOOR : args.epochLength;
        merkleSnapshot.setEpochLength(epochLength);

        TrustComposeParamsController controller = PARAMS_CONTROLLER_DEPLOYER.deploy(
            instanceId,
            snapshot,
            accumulator,
            INSTANCE_REGISTRY,
            params,
            args.policyManifest,
            args.sourceAdapters,
            args.metadataDigest,
            admin,
            POLICY_ACTIVATION_DELAY
        );
        accumulator.bind(snapshot, address(controller));

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
                registryOrAccumulator: accumulatorAddress,
                paramsHash: paramsHash
            }),
            address(controller)
        );
        if (msg.value != 0) {
            VAULT.depositETH{value: msg.value}(instanceId);
            emit InstancePrepaid(instanceId, msg.sender, msg.value);
        }

        emit TrustComposeInstanceCreated(
            instanceId,
            msg.sender,
            admin,
            args.name,
            args.metadataURI,
            accumulatorAddress,
            snapshot,
            distributor,
            args.distributorToken,
            epochLength,
            PROGRAM_VKEY,
            args.metadataDigest,
            params
        );
        emit TrustComposeParamsControllerCreated(instanceId, address(controller));
        controller.publishInitialPolicy(args.policyManifest, args.sourceAdapters);
    }

    /// @notice View twin of `createInstance`'s validation for preflight callers.
    function validateCreation(TrustComposeParamsCodec.Params calldata params, bytes calldata manifest) external view {
        if (block.chainid > type(uint64).max) revert ChainIdTooLarge(block.chainid);
        TrustComposeParamsCodec.Params memory paramsMemory = params;
        TrustComposeValidator.validateCreation(paramsMemory);
        TrustComposeValidator.validatePolicyManifest(manifest, uint64(block.chainid), paramsMemory.maxSourceAgeBlocks);
    }
}
