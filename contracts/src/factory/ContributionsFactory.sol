// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {ContributionResolver} from "src/eas/resolvers/ContributionResolver.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TrustAccumulatorMirror} from "src/merkle/TrustAccumulatorMirror.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsValidator} from "src/params/ContributionsParamsValidator.sol";
import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {ContributionsParamsControllerDeployer} from "src/factory/ContributionsInstanceDeployers.sol";
import {SafeOwnerPolicy} from "src/factory/SafeOwnerPolicy.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title ContributionsFactory
/// @notice Creates a complete contributions ROUND in one transaction: the three contribution
///         schemas, their `ContributionResolver` (the round's own accumulator), a read-only
///         `TrustAccumulatorMirror` over the PARENT trust network's accumulator, a two-lane
///         `MerkleSnapshot`, a `MerkleFundDistributor` for the payouts, the typed params
///         controller, and the directory entry — all owned by the round admin, none of it owned by
///         this factory.
///
/// @dev Mirrors `TrustgraphsFactory`'s discipline throughout (that contract's header explains the
///      three ground rules). What is different here is structural, not stylistic:
///
///      1. **A round hangs off a parent.** `CreateArgs.parentInstanceId` names an existing
///         trust-graph row in the `InstanceRegistry`; the factory asserts the record's program,
///         reads its accumulator for the mirror's lane-1 seam, and emits the link in the creation
///         event. Rounds render on the parent's pages, so creation is gated on the PARENT'S
///         authority: only a holder of the parent snapshot's `CONSTITUTIONAL_ROLE` may hang a
///         round on it (for a governed network that means a proposal — exactly right). Anyone can
///         create a trust network; nobody can decorate someone else's.
///      2. **The mirror and resolver are CREATE'd inline.** `TrustAccumulatorMirror.binder` is
///         `msg.sender` — not a constructor argument — so the factory must be the deployer to
///         perform the one-shot `bindSnapshot` (the M6-1 fix: `trigger()` stays the only
///         checkpoint mint, so a contributions-blind checkpoint id can never exist). The resolver
///         is inline for the same one-frame reason: its schema allowlist (`setSchemas`) and the
///         three registrations happen before anything could attest against a half-wired round.
///      3. **The reconstruction contract is preserved.** `registerWithParamsAuthority` + the
///         controller's deferred `publishInitialVersion()` are exactly the shape the script-based
///         deploys produced, so `operator-core`'s five-way agreement check keeps working with zero
///         changes. The creation event is purely additive discovery for the indexer and frontend.
contract ContributionsFactory {
    /*//////////////////////////////////////////////////////////////
                          THE CREATION INTERFACE
    //////////////////////////////////////////////////////////////*/

    /// @notice Everything a round's creator chooses.
    /// @dev The three schema-UID fields of `params` (slots 19–21) are DERIVED — they must be
    ///      submitted as zero and are filled in by this contract, because they bind the round's
    ///      kind tags to the freshly registered schemas of the freshly created resolver. A
    ///      copy-pasted tuple from another round would otherwise commit to foreign schemas.
    struct CreateArgs {
        /// The parent trust-graph instance (an `InstanceRegistry` key) this round is scored
        /// against. Its accumulator becomes the mirror's lane-1 source; its constitutional
        /// authority is who may create the round.
        bytes32 parentInstanceId;
        /// Short human label. Part of `instanceId`; shown in the app.
        string name;
        /// IPFS URI of the presentation blob. Nothing here is consensus-relevant.
        string metadataURI;
        /// The full 21-field contributions params (see `ContributionsParamsValidator`).
        ContributionsParamsCodec.Params params;
        /// Initialized Safe holding the snapshot's constitutional role, controller, and
        /// distributor. Zero resolves to `msg.sender` and therefore works only when the caller is
        /// itself an initialized Safe.
        address admin;
        /// Requested epoch length in blocks; raised to `EPOCH_FLOOR` if lower.
        uint64 epochLength;
        /// The token the round intends to pay out in. Presentation only — the distributor is
        /// multi-token; this is the app's default pick, recorded in the event.
        address distributorToken;
        /// Lets one creator reuse a name (`instanceId` mixes it in).
        bytes32 salt;
    }

    /// @notice A new contributions round exists. The discovery interface for indexers: it carries
    ///         the parent link, every child address, the three schema UIDs, the effective epoch
    ///         length, and the FINAL params tuple (derived fields filled in). It always holds that
    ///         `ContributionsParamsCodec.hash(params) == MerkleSnapshot(snapshot).paramsHash()`.
    /// @dev Purely additive next to the registry events — `operator-core` keeps reconstructing
    ///      rounds from the registry row + typed controller and never needs this event.
    event ContributionsInstanceCreated(
        bytes32 indexed instanceId,
        bytes32 indexed parentInstanceId,
        address indexed creator,
        address admin,
        string name,
        string metadataURI,
        address trustAccumulator,
        address mirror,
        address resolver,
        address snapshot,
        address distributor,
        address distributorToken,
        uint64 epochLength,
        bytes32 claimSchemaUid,
        bytes32 responseSchemaUid,
        bytes32 valuationSchemaUid,
        ContributionsParamsCodec.Params params
    );

    /// @notice Discovery link for the typed parameter control plane.
    event ContributionsParamsControllerCreated(bytes32 indexed instanceId, address indexed controller);

    /// @notice One of the round's three schemas already existed and was adopted rather than
    ///         registered — i.e. someone front-ran the registration. Harmless (see the adoption
    ///         note in `createInstance` step 2), but worth being able to see from the outside.
    /// @param schemaIndex 0 = claim, 1 = response, 2 = valuation (the resolver's kind-tag index).
    event SchemaAdopted(bytes32 indexed instanceId, uint8 schemaIndex, bytes32 uid);

    /// @notice The three contribution schemas, EXACTLY as frozen in
    ///         research/operations/contributions/interfaces.md §1 (comma-separated without spaces — the
    ///         canonical registered form). Uniform on purpose, like the vouch schema: the guest,
    ///         indexer and frontend all decode these exact field layouts.
    string public constant CLAIM_SCHEMA =
        "string title,bytes32 contentHash,string uri,address[] contributors,uint32[] shares";
    string public constant RESPONSE_SCHEMA = "bytes32 claimUID,uint8 response";
    string public constant VALUATION_SCHEMA = "bytes32 claimUID,uint8 score";

    /// @notice The registry `program` label for instances this factory creates.
    bytes32 public constant PROGRAM = keccak256("contributions");
    /// @notice The registry `program` label a parent must carry.
    bytes32 public constant PARENT_PROGRAM = keccak256("trust-graph");
    /// @notice `name` bound — it is part of `instanceId` and of every directory row.
    uint256 public constant MAX_NAME_BYTES = 64;
    /// @dev `MerkleSnapshot.CONSTITUTIONAL_ROLE`, inlined (it is a public constant there).
    bytes32 private constant PARENT_AUTHORITY_ROLE = keccak256("CONSTITUTIONAL_ROLE");

    /*//////////////////////////////////////////////////////////////
                            SHARED SINGLETONS
    //////////////////////////////////////////////////////////////*/

    /// @notice The chain's EAS.
    IEAS public immutable EAS;
    /// @notice The shared schema registrar (thin wrapper over EAS's `SchemaRegistry`).
    SchemaRegistrar public immutable SCHEMA_REGISTRAR;
    /// @notice The shared `SP1JournalVerifier` for the current contributions vkey. One per
    ///         (chain, program vkey) — every round reuses it; the constructor cross-checks its
    ///         `programVKey()` so a factory can never be wired to the wrong guest.
    IZkVerifier public immutable VERIFIER;
    /// @notice The contributions guest's verification key, as cross-checked at construction.
    bytes32 public immutable PROGRAM_VKEY;
    /// @notice The chain's instance directory. This factory holds `REGISTRAR_ROLE` on it and
    ///         nothing else (append-only; it can never rewrite a record).
    IInstanceRegistry public immutable INSTANCE_REGISTRY;
    /// @notice Creation-code holders for the two large shared children (`InstanceDeployers.sol`).
    MerkleSnapshotDeployer public immutable SNAPSHOT_DEPLOYER;
    MerkleFundDistributorDeployer public immutable DISTRIBUTOR_DEPLOYER;
    /// @notice Creation-code holder for the contributions-specific typed params controller.
    ContributionsParamsControllerDeployer public immutable PARAMS_CONTROLLER_DEPLOYER;
    /// @notice The minimum epoch length, in blocks (see `TrustgraphsFactory.EPOCH_FLOOR`).
    uint64 public immutable EPOCH_FLOOR;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ZeroEpochFloor();
    error InvalidAdmin();
    /// @notice Every contributions round includes funds, so its admin must be an initialized Safe.
    error InvalidDistributorSafe(address owner);
    error EmptyName();
    error NameTooLong(uint256 length);
    /// @notice The verifier has no readable `programVKey()`, or the supplied vkey is zero.
    error InvalidContributionsVerifier();
    /// @notice The shared verifier proves a different guest than the one this factory names.
    error ProgramVKeyMismatch(bytes32 expected, bytes32 actual);
    /// @notice The named parent row exists but is not a trust-graph instance.
    error ParentNotTrustGraph(bytes32 parentInstanceId, bytes32 program);
    error HybridParentUnsupported(bytes32 parentInstanceId, address anchorRegistry);
    /// @notice The caller does not hold the parent snapshot's constitutional role.
    error NotParentAuthority(bytes32 parentInstanceId, address caller);
    /// @notice EAS returned a schema UID other than the one its documented derivation implies.
    error SchemaUidMismatch(bytes32 registered, bytes32 expected);

    /// @param eas The chain's EAS contract.
    /// @param schemaRegistrar The shared schema registrar.
    /// @param verifier The shared `SP1JournalVerifier` for the current contributions vkey.
    /// @param programVKey The contributions guest vkey the verifier must prove.
    /// @param instanceRegistry The chain's instance directory (grant this factory `REGISTRAR_ROLE`).
    /// @param snapshotDeployer Creation-code holder for `MerkleSnapshot`.
    /// @param distributorDeployer Creation-code holder for `MerkleFundDistributor`.
    /// @param paramsControllerDeployer Creation-code holder for `ContributionsParamsController`.
    /// @param epochFloor Minimum epoch length in blocks.
    constructor(
        IEAS eas,
        SchemaRegistrar schemaRegistrar,
        IZkVerifier verifier,
        bytes32 programVKey,
        IInstanceRegistry instanceRegistry,
        MerkleSnapshotDeployer snapshotDeployer,
        MerkleFundDistributorDeployer distributorDeployer,
        ContributionsParamsControllerDeployer paramsControllerDeployer,
        uint64 epochFloor
    ) {
        if (
            address(eas) == address(0) || address(schemaRegistrar) == address(0) || address(verifier) == address(0)
                || address(instanceRegistry) == address(0) || address(snapshotDeployer) == address(0)
                || address(distributorDeployer) == address(0) || address(paramsControllerDeployer) == address(0)
        ) {
            revert ZeroAddress();
        }
        if (epochFloor == 0) revert ZeroEpochFloor();
        // Fail closed on a mis-wired verifier (the TrustComposeFactory pattern): the verifier is
        // the one contract that decides which guest's journals are truth here, so the factory
        // refuses to exist unless it provably carries the contributions vkey.
        if (programVKey == bytes32(0)) revert InvalidContributionsVerifier();
        (bool ok, bytes memory returned) = address(verifier).staticcall(abi.encodeWithSignature("programVKey()"));
        if (!ok || returned.length != 32) revert InvalidContributionsVerifier();
        bytes32 verifierVKey = abi.decode(returned, (bytes32));
        if (verifierVKey != programVKey) revert ProgramVKeyMismatch(programVKey, verifierVKey);

        EAS = eas;
        SCHEMA_REGISTRAR = schemaRegistrar;
        VERIFIER = verifier;
        PROGRAM_VKEY = programVKey;
        INSTANCE_REGISTRY = instanceRegistry;
        SNAPSHOT_DEPLOYER = snapshotDeployer;
        DISTRIBUTOR_DEPLOYER = distributorDeployer;
        PARAMS_CONTROLLER_DEPLOYER = paramsControllerDeployer;
        EPOCH_FLOOR = epochFloor;
    }

    /*//////////////////////////////////////////////////////////////
                                 CREATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a contributions round against an existing trust-graph parent. Callable only
    ///         by a holder of the parent snapshot's constitutional role.
    /// @param args See `CreateArgs`.
    /// @return instanceId The directory key: `keccak256(abi.encode(creator, name, salt))`.
    /// @return snapshot The round's `MerkleSnapshot` (two-lane: trust mirror + contribution log).
    /// @return resolver The round's `ContributionResolver` (its contribution accumulator).
    /// @return mirror The round's `TrustAccumulatorMirror` over the parent's accumulator.
    /// @return distributor The round's `MerkleFundDistributor`.
    function createInstance(CreateArgs calldata args)
        external
        returns (bytes32 instanceId, address snapshot, address resolver, address mirror, address distributor)
    {
        // --- 0. Validate everything before deploying anything. -------------------------------
        uint256 nameLength = bytes(args.name).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength);

        ContributionsParamsCodec.Params memory params = args.params;
        ContributionsParamsValidator.validateCreation(params);

        address admin = args.admin == address(0) ? msg.sender : args.admin;
        // The one address that may NOT be a round admin is this factory (same self-brick argument
        // as TrustgraphsFactory: step 6 grants CONSTITUTIONAL_ROLE to `admin` then renounces it
        // from this address, and the role administers itself).
        if (admin == address(this)) revert InvalidAdmin();
        instanceId = computeInstanceId(msg.sender, args.name, args.salt);

        // --- 1. The parent gate + lane-1 source. ----------------------------------------------
        //        `getInstance` reverts `InstanceNotFound` for an unknown id, so an unregistered
        //        parent fails here with a typed error. The record's accumulator (the parent's
        //        `EASIndexerResolver`) is what the mirror wraps for journal slot A.
        address trustAccumulator = _requireParentAuthority(args.parentInstanceId, msg.sender);
        if (!SafeOwnerPolicy.isSafe(admin)) revert InvalidDistributorSafe(admin);

        // --- 2. The contribution accumulator + its three schemas. ----------------------------
        //        The resolver is inline CREATE so this factory is its `schemaAdmin`-designate and
        //        the whole register → allowlist dance stays in one frame; the UIDs bind the
        //        resolver address, so registration must follow its deployment.
        ContributionResolver contributionResolver = new ContributionResolver(EAS, address(this));
        resolver = address(contributionResolver);

        //        ADOPT, don't insist (the TrustgraphsFactory schema-squat defence, ×3): EAS keys a
        //        schema by `keccak256(abi.encodePacked(schema, resolver, revocable))` with no
        //        `msg.sender`, and the resolver address above is a plain-CREATE prediction anyone
        //        can front-run. A pre-registered tuple for THIS resolver can only be the exact
        //        record we were about to create, so adopting its UID is safe by construction —
        //        while reverting would let one ~100k-gas transaction brick round creation forever.
        bytes32 claimUid = _registerOrAdopt(instanceId, 0, CLAIM_SCHEMA, resolver);
        bytes32 responseUid = _registerOrAdopt(instanceId, 1, RESPONSE_SCHEMA, resolver);
        bytes32 valuationUid = _registerOrAdopt(instanceId, 2, VALUATION_SCHEMA, resolver);

        //        One-shot allowlist, same transaction: no attestation can ever reach `_fold` with
        //        an untrusted kind tag, and the allowlist can never be set to anything else.
        contributionResolver.setSchemas(claimUid, responseUid, valuationUid);

        // --- 3. The lane-1 mirror. Inline CREATE because `binder = msg.sender` is not a --------
        //        constructor argument — the factory must be the deployer to bind below.
        mirror = address(new TrustAccumulatorMirror(IAttestationAccumulator(trustAccumulator)));

        // --- 4. The derived identity fields, then the canonical hash. -------------------------
        params.claimSchemaUid = claimUid;
        params.responseSchemaUid = responseUid;
        params.valuationSchemaUid = valuationUid;
        bytes32 paramsHash = ContributionsParamsCodec.hash(params);

        // --- 5. The two-lane snapshot. The factory takes both roles transiently: --------------
        //        `setAnchorRegistry` / `setEpochLength` are constitutional-only and not
        //        constructor arguments, and the controller's constructor needs this address.
        MerkleSnapshot merkleSnapshot = SNAPSHOT_DEPLOYER.deploy(
            VERIFIER, paramsHash, IAttestationAccumulator(mirror), address(this), address(this)
        );
        snapshot = address(merkleSnapshot);

        //        Enable the accepted-state provenance history now, while zero states exist — the
        //        only moment it is possible (the window closes forever at the first accepted
        //        root). Recording is additive and never blocks acceptance.
        merkleSnapshot.enableStateProvenance();

        //        Journal v2 wiring: slot A (acc, leafCount) = the parent's trust accumulator via
        //        the mirror; slot B (anchorAcc, anchorCount) = the contribution log via the
        //        resolver's IAnchorRegistry aliases. One `trigger()` freezes both lanes at once.
        merkleSnapshot.setAnchorRegistry(IAnchorRegistry(resolver));

        //        M6-1 (research/audits/2026-07-M6.md): bind the mirror to the snapshot in the same
        //        transaction, so `trigger()` is the ONLY checkpoint mint and an unpaired id (whose
        //        lane-2 freeze would read the default `(0,0)` and admit a contributions-blind
        //        proof) can never exist. The window in which the mirror is unbound never leaves
        //        this call.
        TrustAccumulatorMirror(mirror).bindSnapshot(snapshot);

        uint64 epochLength = args.epochLength < EPOCH_FLOOR ? EPOCH_FLOOR : args.epochLength;
        merkleSnapshot.setEpochLength(epochLength);

        // --- 6. The typed controller, then hand every role over. GRANT BEFORE RENOUNCE. -------
        ContributionsParamsController controller =
            PARAMS_CONTROLLER_DEPLOYER.deploy(instanceId, snapshot, address(EAS), INSTANCE_REGISTRY, params, admin);
        merkleSnapshot.grantRole(merkleSnapshot.OPERATIONAL_ROLE(), address(controller));
        merkleSnapshot.renounceRole(merkleSnapshot.OPERATIONAL_ROLE(), address(this));
        merkleSnapshot.grantRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), admin);
        merkleSnapshot.renounceRole(merkleSnapshot.CONSTITUTIONAL_ROLE(), address(this));

        // --- 7. The payout distributor, owned outright by the admin. --------------------------
        //        Factory convention, not the legacy script's: no fee, and `feeRecipient` is the
        //        admin so that turning a fee on later never routes value to a stranger.
        distributor = address(DISTRIBUTOR_DEPLOYER.deploy(admin, snapshot, admin, 0, false));

        // --- 8. The directory entry + typed authority, exactly the reconstruction contract -----
        //        `operator-core` consumes (registry row + controller; catalog.rs's five-way
        //        agreement check needs zero changes).
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

        emit ContributionsInstanceCreated(
            instanceId,
            args.parentInstanceId,
            msg.sender,
            admin,
            args.name,
            args.metadataURI,
            trustAccumulator,
            mirror,
            resolver,
            snapshot,
            distributor,
            args.distributorToken,
            epochLength,
            claimUid,
            responseUid,
            valuationUid,
            params
        );
        // Emitted after the creation event so ordered indexers have already materialized the
        // round row when they attach its separately-discovered controller; the controller's own
        // first event (`publishInitialVersion`) comes after BOTH discovery events — the
        // discovery-before-children rule every new contract follows.
        emit ContributionsParamsControllerCreated(instanceId, address(controller));
        controller.publishInitialVersion();
    }

    /// @notice The directory key for a would-be round. Mixing the creator in makes label squatting
    ///         pointless and `salt` lets one creator reuse a name — and unlike the legacy script's
    ///         snapshot-address-mixing derivation, it is PRE-computable, so a wizard can show the
    ///         id (and link to it) before the transaction is signed.
    function computeInstanceId(address creator, string calldata name, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, name, salt));
    }

    /// @notice Whether `createInstance` would accept these params (the same checks, as a view).
    ///         The round wizard calls this to show a problem before asking for a signature.
    function validateParams(ContributionsParamsCodec.Params calldata params) external pure {
        ContributionsParamsValidator.validateCreation(params);
    }

    /// @notice Whether `creator` may hang a round on `parentInstanceId` (the same parent gate, as
    ///         a view — reverts with the creation path's exact errors).
    /// @return trustAccumulator The parent's accumulator a round's mirror would wrap.
    function validateParent(bytes32 parentInstanceId, address creator) external view returns (address) {
        return _requireParentAuthority(parentInstanceId, creator);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev The parent gate: the row must exist (registry reverts otherwise), carry the
    ///      trust-graph program label, and count `creator` among its snapshot's constitutional
    ///      holders. Returns the parent's accumulator (its `EASIndexerResolver`).
    function _requireParentAuthority(bytes32 parentInstanceId, address creator) internal view returns (address) {
        IInstanceRegistry.Instance memory parent = INSTANCE_REGISTRY.getInstance(parentInstanceId);
        if (parent.program != PARENT_PROGRAM) {
            revert ParentNotTrustGraph(parentInstanceId, parent.program);
        }
        MerkleSnapshot parentSnapshot = MerkleSnapshot(parent.snapshot);
        address anchorRegistry = address(parentSnapshot.anchorRegistry());
        if (anchorRegistry != address(0)) {
            revert HybridParentUnsupported(parentInstanceId, anchorRegistry);
        }
        if (!parentSnapshot.hasRole(PARENT_AUTHORITY_ROLE, creator)) {
            revert NotParentAuthority(parentInstanceId, creator);
        }
        return parent.registryOrAccumulator;
    }

    /// @dev Register one schema, or adopt the identical pre-existing record (see step 2's note).
    ///      The expected UID is recomputed from EAS's documented derivation and cross-checked on
    ///      the success path, so a change in EAS's keying fails loudly instead of hashing a UID
    ///      that does not exist.
    function _registerOrAdopt(bytes32 instanceId, uint8 schemaIndex, string memory schema, address resolver)
        internal
        returns (bytes32 schemaUid)
    {
        schemaUid = keccak256(abi.encodePacked(schema, resolver, true));
        try SCHEMA_REGISTRAR.register(schema, ISchemaResolver(resolver), true) returns (bytes32 registered) {
            if (registered != schemaUid) revert SchemaUidMismatch(registered, schemaUid);
        } catch {
            emit SchemaAdopted(instanceId, schemaIndex, schemaUid);
        }
    }
}
