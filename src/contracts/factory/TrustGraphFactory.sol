// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";
import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "contracts/factory/InstanceDeployers.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title TrustGraphFactory
/// @notice Creates a complete, working trust-graph instance in ONE transaction: an attestation
///         accumulator, its vouching schema, a `MerkleSnapshot` bound to a freshly computed
///         `paramsHash`, an optional fund distributor, and a directory entry — all owned by the
///         creator, none of it owned by this factory.
///
/// @dev The whole design lives in `research/INSTANCE_FACTORY.md`; the operator's view is
///      `docs/trust-graph/FACTORY.md`. Three properties carry the weight:
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
contract TrustGraphFactory {
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
    /// @notice Creation-code holders for the two large children (see `InstanceDeployers.sol`).
    MerkleSnapshotDeployer public immutable SNAPSHOT_DEPLOYER;
    MerkleFundDistributorDeployer public immutable DISTRIBUTOR_DEPLOYER;

    /// @notice The minimum epoch length, in blocks. Chain-appropriate: roughly monthly on mainnet
    ///         (what hosted proving commits to), tiny on a devnet. A shorter request is raised to
    ///         this rather than rejected — see `createInstance`.
    uint64 public immutable EPOCH_FLOOR;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    /// @notice `EPOCH_FLOOR` of zero would let a creator opt out of the schedule entirely.
    error ZeroEpochFloor();
    /// @notice The factory may not be an instance's admin (see `createInstance`).
    error InvalidAdmin();
    error EmptyName();
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
        uint64 epochFloor
    ) {
        if (
            address(eas) == address(0) || address(schemaRegistrar) == address(0) || address(verifier) == address(0)
                || address(instanceRegistry) == address(0) || address(snapshotDeployer) == address(0)
                || address(distributorDeployer) == address(0)
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
        INSTANCE_REGISTRY = instanceRegistry;
        SNAPSHOT_DEPLOYER = snapshotDeployer;
        DISTRIBUTOR_DEPLOYER = distributorDeployer;
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
    function createInstance(CreateArgs calldata args)
        external
        returns (bytes32 instanceId, address snapshot, address resolver, address distributor, bytes32 schemaUid)
    {
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

        // --- 4. The snapshot. This factory takes CONSTITUTIONAL_ROLE transiently (step 5); the --
        //        admin holds OPERATIONAL_ROLE from birth.
        MerkleSnapshot merkleSnapshot =
            SNAPSHOT_DEPLOYER.deploy(VERIFIER, paramsHash, IAttestationAccumulator(resolver), address(this), admin);
        snapshot = address(merkleSnapshot);

        //        Bind the accumulator to that snapshot, in the same transaction. `trigger()` is
        //        then the ONLY way to mint a checkpoint here, which is what makes the epoch
        //        schedule below binding rather than advisory (issue #10). This factory is the
        //        resolver's deployer and therefore its `binder`; the window in which the
        //        accumulator is unbound never leaves this call.
        indexerResolver.bindSnapshot(snapshot);

        // --- 5. The epoch schedule, then hand the constitutional key over. --------------------
        //        `setEpochLength` is constitutional-only and not a constructor argument, which is
        //        the sole reason this factory ever holds a role. GRANT BEFORE RENOUNCE: the
        //        opposite order would leave the instance with no constitutional holder at all,
        //        permanently — the role administers itself.
        uint64 epochLength = args.epochLength < EPOCH_FLOOR ? EPOCH_FLOOR : args.epochLength;
        merkleSnapshot.setEpochLength(epochLength);
        merkleSnapshot.grantRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), admin);
        merkleSnapshot.renounceRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), address(this));

        // --- 6. The optional fund distributor, owned outright by the admin. -------------------
        //        No fee by default: the community can set one later. `feeRecipient` is the admin so
        //        that turning a fee on never routes value to a stranger.
        if (args.withDistributor) {
            distributor = address(DISTRIBUTOR_DEPLOYER.deploy(admin, snapshot, admin, 0, false));
        }

        // --- 7. The directory entry. Presentation-free by design: name/metadata live in the -----
        //        event and the indexer, never on the registry record.
        INSTANCE_REGISTRY.register(
            instanceId,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: snapshot,
                verifier: address(VERIFIER),
                registryOrAccumulator: resolver,
                paramsHash: paramsHash
            })
        );

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
        // Identity fields are derived, never supplied (see `CreateArgs`).
        if (p.schemaUid != bytes32(0) || p.accumulator != address(0) || p.chainId != 0) {
            revert DerivedFieldNotZero();
        }

        // Damping is a probability: 0 makes PageRank a constant, S makes it never teleport.
        if (p.dampingFp == 0 || p.dampingFp >= PRECISION_SCALE) revert InvalidDamping(p.dampingFp);
        if (p.toleranceFp == 0 || p.toleranceFp > MAX_TOLERANCE_FP) {
            revert InvalidTolerance(p.toleranceFp);
        }
        if (p.maxIterations == 0 || p.maxIterations > MAX_ITERATIONS) {
            revert InvalidIterations(p.maxIterations);
        }
        if (p.maxWeightFp == 0 || p.minWeightFp > p.maxWeightFp || p.maxWeightFp > MAX_WEIGHT_FP) {
            revert InvalidWeightBounds(p.minWeightFp, p.maxWeightFp);
        }
        // Trust share is the fraction of rank mass reserved for the seeded component.
        if (p.trustShareFp > PRECISION_SCALE) revert InvalidTrustShare(p.trustShareFp);
        if (p.trustDecayFp > PRECISION_SCALE) revert InvalidTrustDecay(p.trustDecayFp);
        if (p.trustMultiplierFp > MAX_TRUST_MULTIPLIER_FP) {
            revert InvalidTrustMultiplier(p.trustMultiplierFp);
        }
        // The scale is the guest's own constant, not a per-instance choice.
        if (p.precisionScale != PRECISION_SCALE) revert InvalidPrecisionScale(p.precisionScale);
        // A zero pool scores every member zero — a network that renders as all-zeros forever.
        if (p.totalPool == 0) revert InvalidTotalPool();
        if (p.weightFieldIndex != WEIGHT_FIELD_INDEX) {
            revert InvalidWeightFieldIndex(p.weightFieldIndex);
        }

        // Seeds: trust has to start somewhere, so an empty set is rejected rather than silently
        // producing an untrusted graph. Duplicates are rejected too — `seedSetRoot` sorts and would
        // absorb them, so a duplicate is always a mistake in the caller's list.
        uint256 seedCount = p.trustedSeeds.length;
        if (seedCount == 0) revert NoTrustedSeeds();
        if (seedCount > MAX_TRUSTED_SEEDS) revert TooManyTrustedSeeds(seedCount);
        for (uint256 i = 0; i < seedCount; i++) {
            address seed = p.trustedSeeds[i];
            if (seed == address(0)) revert InvalidSeed(seed);
            for (uint256 j = 0; j < i; j++) {
                if (p.trustedSeeds[j] == seed) revert InvalidSeed(seed);
            }
        }

        // Lane 2 needs an `AnchorRegistry` per instance and an envelope-signing story; the v1
        // bundle is lane-1-only, and the snapshot is created with no anchor registry to match.
        if (p.envelope0DomainSeparators.length != 0 || p.lane2MaxHeadAge != 0) {
            revert Lane2NotSupported();
        }

        _validateGrowth(p);
    }

    /// @dev The one bound that is not a single-field range check, and the one that matters most.
    ///
    ///      The guest normalizes ranks ONCE, after the iteration loop
    ///      (`pagerank::calculate_generic`). So a seed whose entire out-weight points at another
    ///      seed multiplies its own rank by `damping x multiplier` on every iteration, with nothing
    ///      pulling it back. Past `type(uint256).max` the fixed-point core aborts, which means the
    ///      instance can never be proven — and before that abort existed, it silently wrapped and
    ///      produced scores that were wrong but perfectly provable, and that the browser's
    ///      arbitrary-precision port disagreed with.
    ///
    ///      No single-field bound can express this: safety is a joint property of damping, the
    ///      multiplier and the iteration count. (The blessed live params grow 1.7x per iteration,
    ///      which is fine for 100 iterations and overflows by 500.) So walk the worst case forward
    ///      and refuse configurations that reach the ceiling. Bounded by `maxIterations`, which is
    ///      itself capped, and it exits early on rejection.
    function _validateGrowth(ParamsCodec.Params memory p) private pure {
        uint256 factor = (p.dampingFp * p.trustMultiplierFp) / PRECISION_SCALE;
        // factor <= 1 ⇒ ranks never grow, so no iteration count is unsafe.
        if (factor <= PRECISION_SCALE) return;

        uint256 growth = PRECISION_SCALE;
        for (uint256 i = 0; i < p.maxIterations; i++) {
            // Check before multiplying: this loop must not overflow while proving that the guest's
            // would.
            if (growth > type(uint256).max / factor) {
                revert RankGrowthUnbounded(factor, p.maxIterations);
            }
            growth = (growth * factor) / PRECISION_SCALE;
            if (growth > MAX_RANK_FP) revert RankGrowthUnbounded(factor, p.maxIterations);
        }
    }
}
