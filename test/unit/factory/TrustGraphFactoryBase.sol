// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";
import {TrustGraphFactory} from "contracts/factory/TrustGraphFactory.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "contracts/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";

/// @title TrustGraphFactoryBase
/// @notice Shared rig for the M1 factory battery: a real EAS + `SchemaRegistry` (so created
///         instances can actually be attested against), a real `InstanceRegistry` with the factory
///         holding `REGISTRAR_ROLE`, and a mock verifier standing in for the shared
///         `SP1JournalVerifier`.
/// @dev    The default params are the GOLDEN vector's params with the three derived identity fields
///         zeroed. Every test therefore exercises the same encoding the cross-language parity job
///         locks, and `TrustGraphFactoryTest.test_ParamsHashMatchesGoldenEncoder` closes the loop
///         between the factory's own hash path and `test/golden/trust-graph.json`.
abstract contract TrustGraphFactoryBase is Test {
    using stdJson for string;

    /*//////////////////////////////////////////////////////////////
                                 THE RIG
    //////////////////////////////////////////////////////////////*/

    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    SchemaRegistrar internal registrar;
    MockZkVerifier internal verifier;
    InstanceRegistry internal registry;
    MerkleSnapshotDeployer internal snapshotDeployer;
    MerkleFundDistributorDeployer internal distributorDeployer;
    TrustGraphFactory internal factory;

    /// @notice The registry's own admin (the operational timelock in production).
    address internal registryAdmin = address(0x0BE7);
    /// @notice Small on a devnet, ~monthly on mainnet. Small here so `trigger()` is reachable.
    uint64 internal constant EPOCH_FLOOR = 5;

    string internal goldenJson;

    /*//////////////////////////////////////////////////////////////
                          DECODED EVENT / RESULT
    //////////////////////////////////////////////////////////////*/

    /// @notice `InstanceCreated`, decoded back out of the log — the exact bytes an indexer or the
    ///         hosted prover would consume.
    struct CreatedEvent {
        bytes32 instanceId;
        address creator;
        address admin;
        string name;
        string metadataURI;
        address resolver;
        bytes32 schemaUid;
        address snapshot;
        address distributor;
        address distributorToken;
        uint64 epochLength;
        ParamsCodec.Params params;
    }

    /// @notice Everything one `createInstance` call produced: its return tuple, its event, and every
    ///         log the transaction emitted (the role-enumeration source).
    struct Created {
        bytes32 instanceId;
        address snapshot;
        address resolver;
        address distributor;
        bytes32 schemaUid;
        address admin;
        CreatedEvent evt;
        Vm.Log[] logs;
    }

    function setUp() public virtual {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        verifier = new MockZkVerifier();
        registry = new InstanceRegistry(registryAdmin);
        snapshotDeployer = new MerkleSnapshotDeployer();
        distributorDeployer = new MerkleFundDistributorDeployer();

        factory = new TrustGraphFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(verifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            EPOCH_FLOOR
        );

        // The factory's ONLY privilege anywhere: APPEND rows. Deliberately not `OPERATOR_ROLE`,
        // which would also grant `update()` — the power to rewrite an existing community's record.
        // Read the role BEFORE the prank: `vm.prank` applies to the next call, and a getter is a
        // call, so inlining it here would spend the prank and run `grantRole` as the test contract.
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.prank(registryAdmin);
        registry.grantRole(registrarRole, address(factory));

        goldenJson = vm.readFile("test/golden/trust-graph.json");
    }

    /*//////////////////////////////////////////////////////////////
                                 PARAMS
    //////////////////////////////////////////////////////////////*/

    /// @dev The golden vector's params, verbatim (derived fields included). Assembled field by
    ///      field rather than as a struct literal — a 17-field literal is stack-too-deep under IR.
    function _goldenParams() internal view returns (ParamsCodec.Params memory p) {
        p.dampingFp = goldenJson.readUint(".params.dampingFp");
        p.toleranceFp = goldenJson.readUint(".params.toleranceFp");
        p.maxIterations = uint32(goldenJson.readUint(".params.maxIterations"));
        p.minWeightFp = goldenJson.readUint(".params.minWeightFp");
        p.maxWeightFp = goldenJson.readUint(".params.maxWeightFp");
        p.trustMultiplierFp = goldenJson.readUint(".params.trustMultiplierFp");
        p.trustShareFp = goldenJson.readUint(".params.trustShareFp");
        p.trustDecayFp = goldenJson.readUint(".params.trustDecayFp");
        p.trustedSeeds = goldenJson.readAddressArray(".params.sortedSeeds");
        p.totalPool = goldenJson.readUint(".params.totalPool");
        p.precisionScale = goldenJson.readUint(".params.precisionScale");
        p.schemaUid = goldenJson.readBytes32(".params.schemaUid");
        p.weightFieldIndex = uint32(goldenJson.readUint(".params.weightFieldIndex"));
        p.envelope0DomainSeparators = goldenJson.readBytes32Array(".params.envelope0DomainSeparators");
        p.lane2MaxHeadAge = uint64(goldenJson.readUint(".params.lane2MaxHeadAge"));
        p.accumulator = goldenJson.readAddress(".params.accumulator");
        p.chainId = uint64(goldenJson.readUint(".params.chainId"));
    }

    /// @dev What a wizard actually submits: the golden params with the three DERIVED identity
    ///      fields left at zero for the factory to fill in.
    function _baseParams() internal view returns (ParamsCodec.Params memory p) {
        p = _goldenParams();
        p.schemaUid = bytes32(0);
        p.accumulator = address(0);
        p.chainId = 0;
    }

    /// @dev A wizard's default submission. `admin`, `withDistributor`, `distributorToken` and `salt`
    ///      stay at their zero values; tests override what they are about.
    function _args(string memory name, ParamsCodec.Params memory params)
        internal
        pure
        returns (TrustGraphFactory.CreateArgs memory args)
    {
        args.name = name;
        args.metadataURI = "ipfs://bafkreiexamplemetadatacid";
        args.params = params;
        args.epochLength = EPOCH_FLOOR;
    }

    function _args(string memory name) internal view returns (TrustGraphFactory.CreateArgs memory) {
        return _args(name, _baseParams());
    }

    /*//////////////////////////////////////////////////////////////
                            CREATE + CAPTURE
    //////////////////////////////////////////////////////////////*/

    /// @dev Run one creation and hand back everything an assertion could want: the return tuple, the
    ///      decoded `InstanceCreated` event, and the raw logs (from which roles are ENUMERATED
    ///      rather than guessed).
    function _create(TrustGraphFactory.CreateArgs memory args) internal returns (Created memory c) {
        vm.recordLogs();
        (c.instanceId, c.snapshot, c.resolver, c.distributor, c.schemaUid) = factory.createInstance(args);
        c.logs = vm.getRecordedLogs();
        c.evt = _decodeCreated(c.logs);
        c.admin = c.evt.admin;
    }

    /// @dev Pull `InstanceCreated` back out of the logs by topic0, exactly as an indexer would.
    function _decodeCreated(Vm.Log[] memory logs) internal view returns (CreatedEvent memory e) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(factory)) continue;
            if (logs[i].topics.length != 4) continue;
            if (logs[i].topics[0] != TrustGraphFactory.InstanceCreated.selector) continue;

            e.instanceId = logs[i].topics[1];
            e.creator = address(uint160(uint256(logs[i].topics[2])));
            e.admin = address(uint160(uint256(logs[i].topics[3])));
            (
                e.name,
                e.metadataURI,
                e.resolver,
                e.schemaUid,
                e.snapshot,
                e.distributor,
                e.distributorToken,
                e.epochLength,
                e.params
            ) =
                abi.decode(
                    logs[i].data,
                    (string, string, address, bytes32, address, address, address, uint64, ParamsCodec.Params)
                );
            return e;
        }
        revert("InstanceCreated was not emitted");
    }

    /*//////////////////////////////////////////////////////////////
                         GROUND RULE 3 (INERTNESS)
    //////////////////////////////////////////////////////////////*/

    /// @dev Every role id that this transaction so much as mentioned, deduped. Enumerating the
    ///      AccessControl events means a role nobody thought to write an assertion for is still
    ///      checked — a spot check on three constants would not survive a fourth role being added.
    function _rolesTouched(Vm.Log[] memory logs) internal pure returns (bytes32[] memory roles) {
        bytes32[] memory found = new bytes32[](logs.length);
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length < 2) continue;
            bytes32 sig = logs[i].topics[0];
            if (
                sig != IAccessControl.RoleGranted.selector && sig != IAccessControl.RoleRevoked.selector
                    && sig != IAccessControl.RoleAdminChanged.selector
            ) continue;

            bytes32 role = logs[i].topics[1];
            bool seen;
            for (uint256 j = 0; j < n; j++) {
                if (found[j] == role) seen = true;
            }
            if (!seen) found[n++] = role;
        }
        roles = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            roles[i] = found[i];
        }
    }

    /// @dev GROUND RULE 3, as an enumerated assertion: after the transaction the factory (and the
    ///      two creation-code deployers, which are the literal `msg.sender` of each CREATE) hold
    ///      nothing on the new instance, the admin holds both real roles, the distributor is owned
    ///      outright by the admin, and the factory's only privilege anywhere is `REGISTRAR_ROLE` on
    ///      the directory.
    function _assertFactoryInert(Created memory c) internal view {
        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);

        bytes32 constitutional = snapshot.CONSTITUTIONAL_ROLE();
        bytes32 operational = snapshot.OPERATIONAL_ROLE();
        bytes32 defaultAdmin = snapshot.DEFAULT_ADMIN_ROLE();

        // The three declared roles, named explicitly...
        bytes32[3] memory declared = [constitutional, operational, defaultAdmin];
        for (uint256 i = 0; i < declared.length; i++) {
            _assertHoldsNothing(snapshot, declared[i]);
        }

        // ...and every role the transaction touched, whether or not we named it above. This is what
        // makes the invariant survive a future role being added to MerkleSnapshot.
        bytes32[] memory touched = _rolesTouched(c.logs);
        assertGe(touched.length, 2, "the create tx must have granted at least two roles");
        for (uint256 i = 0; i < touched.length; i++) {
            _assertHoldsNothing(snapshot, touched[i]);
        }

        // The admin, conversely, holds BOTH real roles — the handover is what makes the renounce
        // safe rather than a brick.
        assertTrue(snapshot.hasRole(constitutional, c.admin), "admin must hold CONSTITUTIONAL_ROLE");
        assertTrue(snapshot.hasRole(operational, c.admin), "admin must hold OPERATIONAL_ROLE");
        // Nobody holds the OZ default admin: both roles are administered by CONSTITUTIONAL_ROLE.
        assertFalse(snapshot.hasRole(defaultAdmin, c.admin), "nobody may hold DEFAULT_ADMIN_ROLE");

        // The distributor: owned outright, with no pending handshake left dangling.
        if (c.distributor != address(0)) {
            MerkleFundDistributor dist = MerkleFundDistributor(payable(c.distributor));
            assertEq(dist.owner(), c.admin, "distributor owner must be the admin");
            assertEq(dist.pendingOwner(), address(0), "no pending ownership may survive creation");
            assertEq(dist.merkleSnapshot(), c.snapshot, "distributor must read this instance's root");
        }

        // The directory: exactly one privilege, and not the one that rewrites history.
        assertTrue(
            registry.hasRole(registry.REGISTRAR_ROLE(), address(factory)),
            "factory must keep REGISTRAR_ROLE on the registry"
        );
        assertFalse(
            registry.hasRole(registry.OPERATOR_ROLE(), address(factory)),
            "factory must NEVER hold OPERATOR_ROLE: that is the role that can rewrite a record"
        );
        assertFalse(
            registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(factory)),
            "factory must never administer the registry"
        );
    }

    /// @dev No role on a created instance may be held by the factory or by either creation-code
    ///      deployer.
    function _assertHoldsNothing(MerkleSnapshot snapshot, bytes32 role) internal view {
        assertFalse(snapshot.hasRole(role, address(factory)), "factory holds a role on the instance");
        assertFalse(snapshot.hasRole(role, address(snapshotDeployer)), "snapshot deployer holds a role");
        assertFalse(snapshot.hasRole(role, address(distributorDeployer)), "distributor deployer holds a role");
    }
}
