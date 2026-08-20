// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";
import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {TrustgraphsParamsValidator} from "contracts/params/TrustgraphsParamsValidator.sol";
import {TrustgraphsParamsController} from "contracts/factory/TrustgraphsParamsController.sol";
import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer
} from "contracts/factory/InstanceDeployers.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

/// @title TrustgraphsFactory
/// @notice Creates a complete, working trust-graph instance in ONE transaction: an attestation
///         accumulator, its vouching schema, a `MerkleSnapshot` bound to a freshly computed
///         `paramsHash`, an optional fund distributor, and a directory entry — all owned by the
///         creator, none of it owned by this factory.
///
/// @dev The whole design lives in `research/INSTANCE_FACTORY.md`; the operator's view is
///      `docs/build/create-a-network.md`. Three properties carry the weight:
///
///      1. **The factory ends the transaction holding nothing.** It takes `CONSTITUTIONAL_ROLE` on
///         the new snapshot only because `setEpochLength` is constitutional-only and is not a
///         constructor argument (`MerkleSnapshot.sol` — `epochLength` is a governance knob, not a
///         deploy knob). Within the same call it grants that role to the instance admin and then
///         renounces its own. A compromised factory can write directory garbage; it cannot touch a
///         single existing instance. Enforced as a test invariant, not a convention.
///      2. **The event is the interface.** `InstanceCreated` carries the FULL params struct, so the
///         hosted prover reconstructs any instance's input from chain data alone (registry →
///         addresses, event → params, self-check `hash(params) == snapshot.paramsHash()`), the UI
///         can show what a community actually computes instead of a hash, and third parties can
///         audit it. Treat its shape as frozen.
///      3. **Permissionless is not unvalidated.** `paramsHash` is otherwise an opaque bytes32 that
///         accepts anything; creation-time bounds (below) keep every instance inside the envelope
///         the guest is proven safe over, and the epoch floor bounds what hosted proving costs.
contract TrustgraphsFactory {
    /*//////////////////////////////////////////////////////////////
                          THE FROZEN INTERFACE
    //////////////////////////////////////////////////////////////*/

    /// @notice Everything a community chooses at creation.
    /// @dev `params.schemaUid`, `params.accumulator` and `params.chainId` are DERIVED — they must be
    ///      submitted as zero and are filled in by this contract. They identify the instance, and an
    ///      instance cannot name its own identity: a copy-pasted params struct from another network
    ///      would otherwise bind the new snapshot to a foreign domain, which is exactly the replay
    ///      hazard the params-schema v2 fields exist to close.
    struct CreateArgs {
        /// Short human label. Part of `instanceId`; shown in the app.
        string name;
        /// IPFS URI of the presentation blob `{name, description, criteria, image, applicationUrl}`.
        /// Nothing here is consensus-relevant.
        string metadataURI;
        /// The full governance params (see the bounds in `_validateParams`).
        ParamsCodec.Params params;
        /// Holder of both snapshot roles and the distributor's ownership. Zero ⇒ `msg.sender`.
        address admin;
        /// Requested epoch length in blocks; raised to `EPOCH_FLOOR` if lower.
        uint64 epochLength;
        /// Whether to include a `MerkleFundDistributor`.
        bool withDistributor;
        /// The token the community intends to distribute. Presentation only — the distributor is
        /// multi-token (`distribute(token, …)` takes it per distribution); this is the app's default
        /// pick, recorded in the event so the payout screen doesn't have to guess.
        address distributorToken;
        /// Lets one creator reuse a name (`instanceId` mixes it in).
        bytes32 salt;
    }

    /// @notice A new instance exists. THE load-bearing interface — provers, indexers and auditors
    ///         all reconstruct an instance from this event, so its shape is frozen like a journal.
    /// @param params The FINAL params, i.e. with the derived fields filled in. It always holds that
    ///        `ParamsCodec.hash(params) == MerkleSnapshot(snapshot).paramsHash()`.
    /// @param distributor The fund distributor, or `address(0)` when the creator declined one.
    /// @param epochLength The EFFECTIVE epoch length after the floor was applied.
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

    /// @notice A creator endowed the new instance's proving tank in the creating transaction.
    event InstancePrepaid(bytes32 indexed instanceId, address indexed from, uint256 amount);

    /// @notice Discovery link for the typed parameter control plane. `InstanceCreated` stays frozen.
    event ParamsControllerCreated(bytes32 indexed instanceId, address indexed controller);

    /// @notice A fund distributor was attached to an existing instance after creation.
    ///         `InstanceCreated` stays frozen; this event is the additive discovery source for
    ///         late-attached funds. `distributorToken` is presentation only, exactly like the
    ///         creation-time field: the distributor is multi-token.
    event DistributorAttached(bytes32 indexed instanceId, address distributor, address distributorToken);

    /// @notice The one vouching schema every factory instance uses. Uniform on purpose: a
    ///         creator-customizable schema would fork `weightFieldIndex` and multiply the surface
    ///         every consumer (guest, indexer, frontend) has to handle.
    string public constant VOUCH_SCHEMA = "string comment,uint256 confidence";

    /// @notice The registry `program` label for instances this factory creates.
    bytes32 public constant PROGRAM = keccak256("trust-graph");

    /*//////////////////////////////////////////////////////////////
                       CREATION-TIME PARAM BOUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice The fixed-point scale S every instance must use (the guest's own constant).
    uint256 public constant PRECISION_SCALE = 1e18;
    /// @notice `weightFieldIndex` is fixed by `VOUCH_SCHEMA`: `confidence` sits in ABI head slot 1.
    uint32 public constant WEIGHT_FIELD_INDEX = 1;
    /// @notice Iteration ceiling — past this the guest's cycle count, not the maths, is the limit.
    uint32 public constant MAX_ITERATIONS = 500;
    /// @notice Convergence tolerance must be meaningfully below S; 1e15 is 0.1% of a unit score.
    uint256 public constant MAX_TOLERANCE_FP = 1e15;
    /// @notice A ceiling on the seed boost. Defence in depth only — `_validateGrowth` is what
    ///         actually decides whether a multiplier is safe, because safety depends jointly on
    ///         damping and the iteration count, not on this number alone.
    uint256 public constant MAX_TRUST_MULTIPLIER_FP = 100e18;
    /// @notice Ceiling on a single vouch's weight. The canonical schema's `confidence` is a small
    ///         integer (the live network caps at 100), so a million units is four orders of
    ///         headroom while still bounding the per-attester weight sums the guest accumulates.
    uint256 public constant MAX_WEIGHT_FP = 1e6 * PRECISION_SCALE;
    /// @notice The largest rank the fixed-point core can hold with headroom for one more multiply.
    ///         Past `type(uint256).max` the guest ABORTS (`zk_core::fixed::mul_div`), so an
    ///         instance whose ranks can reach here is not merely badly tuned — it is unprovable.
    uint256 public constant MAX_RANK_FP = type(uint256).max / PRECISION_SCALE;
    /// @notice Seeds are hashed into a merkle root at creation; keep the loop bounded.
    uint256 public constant MAX_TRUSTED_SEEDS = 64;
    /// @notice `name` bound — it is part of `instanceId` and of every directory row.
    uint256 public constant MAX_NAME_BYTES = 64;

    /*//////////////////////////////////////////////////////////////
                            SHARED SINGLETONS
    //////////////////////////////////////////////////////////////*/

    /// @notice The chain's EAS.
    IEAS public immutable EAS;
    /// @notice The shared schema registrar (thin wrapper over EAS's `SchemaRegistry`).
    SchemaRegistrar public immutable SCHEMA_REGISTRAR;
    /// @notice The shared `SP1JournalVerifier` for the current trust-graph vkey. One per (chain,
    ///         program vkey) — every instance of this program reuses it.
    IZkVerifier public immutable VERIFIER;
    /// @notice The chain's instance directory. This factory holds `OPERATOR_ROLE` on it and nothing
    ///         else; `update()` stays timelock-only so a factory bug cannot rewrite history.
    IInstanceRegistry public immutable INSTANCE_REGISTRY;

    /// @notice The `ProvingVault` a creator's `msg.value` is forwarded into. Zero disables the
    ///         prepay path entirely (and makes a non-zero `msg.value` revert rather than being
    ///         silently kept).
    /// @dev The factory holds no role on the vault and never touches an existing account: it can
    ///      only add funds to the id it just created. Deliberately immutable — a re-pointable
    ///      vault address on a permissionless factory is a way to route every creator's prepay
    ///      somewhere else.
    IProvingVault public immutable VAULT;
    /// @notice Creation-code holders for the two large children (see `InstanceDeployers.sol`).
    MerkleSnapshotDeployer public immutable SNAPSHOT_DEPLOYER;
    MerkleFundDistributorDeployer public immutable DISTRIBUTOR_DEPLOYER;
    /// @notice Creation-code holder for the trust-graph-specific typed params controller.
    TrustgraphsParamsControllerDeployer public immutable PARAMS_CONTROLLER_DEPLOYER;

    /// @notice The minimum epoch length, in blocks. Chain-appropriate: roughly monthly on mainnet
    ///         (what hosted proving commits to), tiny on a devnet. A shorter request is raised to
    ///         this rather than rejected — see `createInstance`.
    uint64 public immutable EPOCH_FLOOR;

    /// @notice The one fund distributor this factory knows per instance: the creation-time one,
    ///         or the one `attachDistributor` deployed later. Zero means "none yet".
    mapping(bytes32 instanceId => address distributor) public distributorOf;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    /// @notice `EPOCH_FLOOR` of zero would let a creator opt out of the schedule entirely.
    error ZeroEpochFloor();
    /// @notice The factory may not be an instance's admin (see `createInstance`).
    error InvalidAdmin();
    error EmptyName();
    /// @notice `msg.value` was sent to a factory deployed without a vault.
    error NoVaultConfigured();
    error NameTooLong(uint256 length);
    /// @notice A derived field (`schemaUid`, `accumulator`, `chainId`) was not submitted as zero.
    error DerivedFieldNotZero();
    error InvalidDamping(uint256 dampingFp);
    error InvalidTolerance(uint256 toleranceFp);
    error InvalidIterations(uint32 maxIterations);
    error InvalidWeightBounds(uint256 minWeightFp, uint256 maxWeightFp);
    /// @notice `damping x multiplier` compounds past what U256 can hold within `maxIterations`.
    error RankGrowthUnbounded(uint256 factorFp, uint32 maxIterations);
    /// @notice EAS returned a schema UID other than the one its documented derivation implies.
    error SchemaUidMismatch(bytes32 registered, bytes32 expected);

    /// @notice The instance's vouching schema already existed and was adopted rather than
    ///         registered — i.e. someone front-ran the registration. Harmless (the record is
    ///         necessarily the one we wanted), but worth being able to see from the outside.
    event SchemaAdopted(bytes32 indexed instanceId, bytes32 schemaUid);
    error InvalidTrustShare(uint256 trustShareFp);
    error InvalidTrustDecay(uint256 trustDecayFp);
    error InvalidTrustMultiplier(uint256 trustMultiplierFp);
    error InvalidPrecisionScale(uint256 precisionScale);
    error InvalidTotalPool();
    error InvalidWeightFieldIndex(uint32 weightFieldIndex);
    error NoTrustedSeeds();
    error TooManyTrustedSeeds(uint256 count);
    /// @notice A seed was the zero address, or the same address appeared twice.
    error InvalidSeed(address seed);
    /// @notice Lane 2 (off-chain envelopes) is not part of the v1 factory bundle.
    error Lane2NotSupported();
    /// @notice `attachDistributor` was asked about an id this factory's program never registered.
    error UnknownInstance(bytes32 instanceId);
    /// @notice The proposed fund owner does not hold the instance's constitutional role.
    error NotInstanceAuthority(bytes32 instanceId, address owner);
    /// @notice The instance already has a factory-known fund distributor.
    error DistributorAlreadyAttached(bytes32 instanceId, address distributor);

    /// @param eas The chain's EAS contract.
    /// @param schemaRegistrar The shared schema registrar.
    /// @param verifier The shared `SP1JournalVerifier` for the current trust-graph vkey.
    /// @param instanceRegistry The chain's instance directory (grant this factory `OPERATOR_ROLE`).
    /// @param snapshotDeployer Creation-code holder for `MerkleSnapshot`.
    /// @param distributorDeployer Creation-code holder for `MerkleFundDistributor`.
    /// @param epochFloor Minimum epoch length in blocks (see `EPOCH_FLOOR`).
    constructor(
        IEAS eas,
        SchemaRegistrar schemaRegistrar,
        IZkVerifier verifier,
        IInstanceRegistry instanceRegistry,
        MerkleSnapshotDeployer snapshotDeployer,
        MerkleFundDistributorDeployer distributorDeployer,
        TrustgraphsParamsControllerDeployer paramsControllerDeployer,
        uint64 epochFloor,
        IProvingVault vault
    ) {
        if (
            address(eas) == address(0) || address(schemaRegistrar) == address(0) || address(verifier) == address(0)
                || address(instanceRegistry) == address(0) || address(snapshotDeployer) == address(0)
                || address(distributorDeployer) == address(0) || address(paramsControllerDeployer) == address(0)
        ) {
            revert ZeroAddress();
        }
        // A zero floor is not "no minimum", it is "no schedule": `setEpochLength(0)` disables the
        // boundary check entirely, which would hand epoch selection back to whoever proves first
        // (OFFCHAIN §4.1 — boundaries are never prover-chosen). Every factory has a real floor.
        if (epochFloor == 0) revert ZeroEpochFloor();
        EAS = eas;
        SCHEMA_REGISTRAR = schemaRegistrar;
        VERIFIER = verifier;
        // Zero is allowed and means "no prepay path on this factory". Sending value to such a
        // factory reverts rather than being kept.
        VAULT = vault;
        INSTANCE_REGISTRY = instanceRegistry;
        SNAPSHOT_DEPLOYER = snapshotDeployer;
        DISTRIBUTOR_DEPLOYER = distributorDeployer;
        PARAMS_CONTROLLER_DEPLOYER = paramsControllerDeployer;
        EPOCH_FLOOR = epochFloor;
    }

    /*//////////////////////////////////////////////////////////////
                                 CREATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a trust-graph instance. Permissionless and non-payable.
    /// @dev The dependency chain is a DAG and is walked exactly once, in this order:
    ///      resolver → schema UID → paramsHash → snapshot → epoch → roles → distributor → registry.
    ///      The schema must precede the hash because its UID binds the resolver address, and the
    ///      hash must precede the snapshot because the snapshot stores it.
    /// @param args See `CreateArgs`.
    /// @return instanceId The directory key: `keccak256(abi.encode(creator, name, salt))`.
    /// @return snapshot The new `MerkleSnapshot`.
    /// @return resolver The new `EASIndexerResolver` (this instance's attestation accumulator).
    /// @return distributor The new `MerkleFundDistributor`, or zero when not requested.
    /// @return schemaUid The instance's vouching schema UID (what members attest against).
    /// @dev Payable: `msg.value` is forwarded into the instance's `ProvingVault` account, so a
    ///      community can deploy its network endowed with a year of roots in one transaction
    ///      rather than discovering the funding step after its first epoch goes unproven. Sending
    ///      nothing is the normal case and costs nothing.
    function createInstance(CreateArgs calldata args)
        external
        payable
        returns (bytes32 instanceId, address snapshot, address resolver, address distributor, bytes32 schemaUid)
    {
        if (msg.value != 0 && address(VAULT) == address(0)) {
            revert NoVaultConfigured();
        }
        // --- 0. Validate everything before deploying anything. -------------------------------
        uint256 nameLength = bytes(args.name).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength);

        ParamsCodec.Params memory params = args.params;
        _validateParams(params);

        address admin = args.admin == address(0) ? msg.sender : args.admin;
        // The one address that may NOT be an instance admin is this factory. Naming it would (a)
        // leave the factory holding OPERATIONAL_ROLE and owning the distributor once the
        // transaction ends — the exact thing ground rule 3 forbids — and (b) brick the instance,
        // because step 5 grants CONSTITUTIONAL_ROLE to `admin` and then renounces it from the same
        // address, and that role administers itself, so nobody could ever hold it again.
        if (admin == address(this)) revert InvalidAdmin();
        instanceId = computeInstanceId(msg.sender, args.name, args.salt);

        // --- 1. The accumulator. Permissionless folds, no roles, no post-wiring. --------------
        EASIndexerResolver indexerResolver = new EASIndexerResolver(EAS);
        resolver = address(indexerResolver);

        // --- 2. The vouching schema. Its UID binds the resolver, so it must exist before the ---
        //        hash that commits to it.
        //
        //        ADOPT, don't insist. EAS keys a schema by
        //        `keccak256(abi.encodePacked(schema, resolver, revocable))` with no `msg.sender`,
        //        and reverts `AlreadyExists` on a duplicate. The resolver address above comes from
        //        plain CREATE, so it is `keccak(rlp(factory, factoryNonce))` — public. A stranger
        //        can therefore pre-register our exact tuple for the address we are about to use;
        //        because our transaction then reverts, the factory's nonce is rolled back with it
        //        and the SAME address is predicted next time. That one ~100k-gas transaction would
        //        brick `createInstance` for every creator, forever, with no recovery path.
        //
        //        Adopting the existing UID costs nothing and is safe by construction: the UID is a
        //        pure hash of the tuple, so a UID that already exists for THIS freshly-created
        //        resolver can only be the canonical schema, revocable, bound to this resolver —
        //        exactly the record we were about to create. (Squatting a *different* schema string
        //        against the same resolver produces a different UID and does not collide.)
        schemaUid = keccak256(abi.encodePacked(VOUCH_SCHEMA, resolver, true));
        try SCHEMA_REGISTRAR.register(VOUCH_SCHEMA, ISchemaResolver(resolver), true) returns (bytes32 registered) {
            // Belt and braces: if EAS ever changed its UID derivation, fail loudly here rather than
            // hashing a UID that does not exist.
            if (registered != schemaUid) revert SchemaUidMismatch(registered, schemaUid);
        } catch {
            emit SchemaAdopted(instanceId, schemaUid);
        }

        //        Bind the resolver to that schema, in the same transaction, so there is never a
        //        window in which it would fold a foreign edge into this instance's accumulator.
        indexerResolver.bindSchema(schemaUid);

        // --- 3. The derived identity fields, then the canonical hash. -------------------------
        params.schemaUid = schemaUid;
        params.accumulator = resolver;
        params.chainId = uint64(block.chainid);
        bytes32 paramsHash = ParamsCodec.hash(params);

        // --- 4. The snapshot. The factory takes both roles transiently so it can install the ----
        //        controller whose constructor needs this newly-created snapshot's address.
        MerkleSnapshot merkleSnapshot = SNAPSHOT_DEPLOYER.deploy(
            VERIFIER, paramsHash, IAttestationAccumulator(resolver), address(this), address(this)
        );
        snapshot = address(merkleSnapshot);

        //        Enable the accepted-state provenance history now, while zero states exist — the
        //        only moment it is possible. The window closes forever at the first accepted root,
        //        and after this transaction the constitutional role may sit behind a governed Safe
        //        that cannot act until a root lands. This is what lets the instance serve as a
        //        composition source later; recording is additive and never blocks acceptance.
        merkleSnapshot.enableStateProvenance();

        //        Bind the accumulator to that snapshot, in the same transaction. `trigger()` is
        //        then the ONLY way to mint a checkpoint here, which is what makes the epoch
        //        schedule below binding rather than advisory (issue #10). This factory is the
        //        resolver's deployer and therefore its `binder`; the window in which the
        //        accumulator is unbound never leaves this call.
        indexerResolver.bindSnapshot(snapshot);

        // --- 5. Publish version 1, install its typed controller, and hand both roles over. -----
        //        `setEpochLength` is constitutional-only and not a constructor argument, which is
        //        the sole reason this factory ever holds a role. GRANT BEFORE RENOUNCE: the
        //        opposite order would leave the instance with no constitutional holder at all,
        //        permanently — the role administers itself.
        uint64 epochLength = args.epochLength < EPOCH_FLOOR ? EPOCH_FLOOR : args.epochLength;
        merkleSnapshot.setEpochLength(epochLength);

        TrustgraphsParamsController controller =
            PARAMS_CONTROLLER_DEPLOYER.deploy(instanceId, snapshot, INSTANCE_REGISTRY, params, admin);
        merkleSnapshot.grantRole(merkleSnapshot.OPERATIONAL_ROLE(), address(controller));
        merkleSnapshot.renounceRole(merkleSnapshot.OPERATIONAL_ROLE(), address(this));
        merkleSnapshot.grantRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), admin);
        merkleSnapshot.renounceRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), address(this));

        // --- 6. The optional fund distributor, owned outright by the admin. -------------------
        //        No fee by default: the community can set one later. `feeRecipient` is the admin so
        //        that turning a fee on never routes value to a stranger.
        if (args.withDistributor) {
            distributor = address(DISTRIBUTOR_DEPLOYER.deploy(admin, snapshot, admin, 0, false));
            distributorOf[instanceId] = distributor;
        }

        // --- 7. The directory entry. Presentation-free by design: name/metadata live in the -----
        //        event and the indexer, never on the registry record.
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

        // --- 8. The optional prepay. AFTER the registry row, because the vault resolves the ---
        //        instance through it at first deposit — depositing first would revert on an id
        //        the directory does not yet know.
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
            resolver,
            schemaUid,
            snapshot,
            distributor,
            args.distributorToken,
            epochLength,
            params
        );
        // Emitted after the frozen creation event so ordered indexers have already materialized
        // the instance row when they attach its separately-discovered controller.
        emit ParamsControllerCreated(instanceId, address(controller));
        controller.publishInitialVersion();
    }

    /// @notice Attach a fund distributor to an instance created without one. Permissionless to
    ///         CALL — anyone may pay the gas — but the deployed fund is owned by `owner`, which
    ///         must hold the instance's constitutional role right now, so the caller can route
    ///         value only to the instance's own live authority (for a governed instance that is
    ///         its Safe). Same terms as the creation-time path: fee 0, `feeRecipient = owner`.
    /// @param instanceId The instance to attach a fund to (this factory's program only).
    /// @param owner The fund's owner; verified against the snapshot's CONSTITUTIONAL_ROLE.
    /// @param distributorToken The token the community intends to distribute. Presentation only,
    ///        recorded in the event exactly like `CreateArgs.distributorToken`.
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

    /// @notice The directory key for a would-be instance. Mixing the creator in makes label
    ///         squatting pointless (nobody can block "gitcoin" for anyone else) and `salt` lets one
    ///         creator reuse a name.
    function computeInstanceId(address creator, string calldata name, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, name, salt));
    }

    /// @notice Whether `createInstance` would accept these params (the same checks, as a view).
    ///         The wizard calls this to show a problem before asking for a signature.
    function validateParams(ParamsCodec.Params calldata params) external pure {
        _validateParams(params);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev The §2.2 bounds. These are not opinions about what makes a good community — they are
    ///      the envelope the fixed-point guest is proven over, plus the two identity rules.
    function _validateParams(ParamsCodec.Params memory p) internal pure {
        TrustgraphsParamsValidator.validateCreation(p);
    }
}
