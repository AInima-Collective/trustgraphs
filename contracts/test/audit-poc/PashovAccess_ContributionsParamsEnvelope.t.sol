// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {ContributionsFactory} from "src/factory/ContributionsFactory.sol";
import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {ContributionsParamsControllerDeployer} from "src/factory/ContributionsInstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer
} from "src/factory/InstanceDeployers.sol";
import {EasOffchainAnchorRegistryDeployer} from "src/factory/HybridInstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsValidator} from "src/params/ContributionsParamsValidator.sol";
import {TrustgraphsParamsController} from "src/factory/TrustgraphsParamsController.sol";
import {TrustgraphsParamsValidator} from "src/params/TrustgraphsParamsValidator.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

import {MockSP1Gateway} from "../mocks/MockSP1Gateway.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";

/// @notice Thin wrapper so the library's internal entry point is reachable through a real call
///         (so `vm.expectRevert` has an external frame to catch).
contract ValidatorProbe {
    function validateFinal(ContributionsParamsCodec.Params calldata p) external pure {
        ContributionsParamsCodec.Params memory q = p;
        ContributionsParamsValidator.validateFinal(q);
    }
}

/// @title PashovAccess_ContributionsParamsEnvelope
/// @notice `ContributionsParamsController.updateParams` performs NO envelope validation, unlike
///         every sibling controller (`TrustgraphsParamsController.updateParams` ->
///         `TrustgraphsParamsValidator.validateUpdate`, `WeightedPriorParamsController.activatePrior`
///         -> `WeightedPriorValidator.validateRotation`, `TrustComposeParamsController.activatePolicy`
///         -> `TrustComposeValidator.validateRotation`). The round owner can therefore rotate the
///         live `paramsHash` to a tuple the factory would have refused at creation.
contract PashovAccess_ContributionsParamsEnvelopeTest is Test {
    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    SchemaRegistrar internal registrar;
    InstanceRegistry internal registry;
    MerkleSnapshotDeployer internal snapshotDeployer;
    MerkleFundDistributorDeployer internal distributorDeployer;

    MockZkVerifier internal trustVerifier;
    TrustgraphsFactory internal trustFactory;

    SP1JournalVerifier internal contributionsVerifier;
    ContributionsFactory internal factory;

    address internal registryAdmin = address(0x0BE7);
    address internal parentAdmin = address(0xA11CE);

    uint64 internal constant EPOCH_FLOOR = 5;
    bytes32 internal constant CONTRIBUTIONS_VKEY = bytes32(uint256(0xC0117B));

    bytes32 internal parentId;
    ValidatorProbe internal probe;

    function setUp() public {
        probe = new ValidatorProbe();
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        registry = new InstanceRegistry(registryAdmin);
        snapshotDeployer = new MerkleSnapshotDeployer();
        distributorDeployer = new MerkleFundDistributorDeployer();

        trustVerifier = new MockZkVerifier();
        trustFactory = new TrustgraphsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(trustVerifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            new TrustgraphsParamsControllerDeployer(),
            new EasOffchainAnchorRegistryDeployer(),
            EPOCH_FLOOR,
            IProvingVault(address(0))
        );

        contributionsVerifier =
            new SP1JournalVerifier(ISP1Verifier(address(new MockSP1Gateway())), CONTRIBUTIONS_VKEY);
        factory = new ContributionsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(contributionsVerifier)),
            CONTRIBUTIONS_VKEY,
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            new ContributionsParamsControllerDeployer(),
            EPOCH_FLOOR
        );

        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.startPrank(registryAdmin);
        registry.grantRole(registrarRole, address(trustFactory));
        registry.grantRole(registrarRole, address(factory));
        vm.stopPrank();

        (parentId,,,,) = trustFactory.createInstance(_trustArgs("parent-network"));
    }

    function _trustArgs(string memory name) internal view returns (TrustgraphsFactory.CreateArgs memory args) {
        ParamsCodec.Params memory p;
        p.dampingFp = 0.85e18;
        p.toleranceFp = 1e12;
        p.maxIterations = 50;
        p.minWeightFp = 0;
        p.maxWeightFp = 100e18;
        p.trustShareFp = 0.5e18;
        p.trustDecayFp = 0.5e18;
        p.trustedSeeds = new address[](2);
        p.trustedSeeds[0] = address(0x5EED1);
        p.trustedSeeds[1] = address(0x5EED2);
        p.totalPool = 1e24;
        p.precisionScale = 1e18;
        p.weightFieldIndex = 1;

        args.name = name;
        args.metadataURI = "";
        args.params = p;
        args.admin = parentAdmin;
        args.epochLength = EPOCH_FLOOR;
    }

    function _contribParams() internal pure returns (ContributionsParamsCodec.Params memory p) {
        p.dampingFp = 0.85e18;
        p.toleranceFp = 1e12;
        p.maxIterations = 50;
        p.minWeightFp = 0;
        p.maxWeightFp = 100e18;
        p.trustShareFp = 0.5e18;
        p.trustDecayFp = 0.5e18;
        p.trustedSeeds = new address[](2);
        p.trustedSeeds[0] = address(0x5EED1);
        p.trustedSeeds[1] = address(0x5EED2);
        p.precisionScale = 1e18;
        p.weightFieldIndex = 1;
        p.roundStart = 1_000;
        p.roundEnd = 2_000;
        p.unacceptedMultFp = 0.5e18;
        p.collaboratorMultFp = 0.5e18;
        p.minRaterRepFp = 0;
        p.evaluatorCarveoutBps = 100;
        p.totalPool = 1_000_000e6;
    }

    /// @dev The out-of-envelope mutations `ContributionsParamsValidator` rejects.
    function _makeRogue(ContributionsParamsCodec.Params memory p) internal pure {
        p.precisionScale = 1; // validator: InvalidPrecisionScale (must equal 1e18)
        p.maxIterations = 100_000; // validator: InvalidIterations (ceiling is 500)
        p.roundStart = 9_000;
        p.roundEnd = 1; // validator: InvalidRoundWindow
        p.trustedSeeds = new address[](0); // validator: NoTrustedSeeds
        p.evaluatorCarveoutBps = 60_000; // validator: InvalidCarveout (max 10_000)
    }

    function _decodeController(Vm.Log[] memory logs, bytes32 instanceId) internal view returns (address) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(factory) || logs[i].topics.length != 3) continue;
            if (logs[i].topics[0] != ContributionsFactory.ContributionsParamsControllerCreated.selector) continue;
            if (logs[i].topics[1] != instanceId) continue;
            return address(uint160(uint256(logs[i].topics[2])));
        }
        revert("ContributionsParamsControllerCreated was not emitted");
    }

    /// @notice The round owner rotates the live params commitment to a tuple that the program's
    ///         own validator rejects (`precisionScale != 1e18`, `maxIterations` past the ceiling,
    ///         `roundEnd < roundStart`, empty seed set). Nothing stops it: the snapshot and the
    ///         registry both accept the new hash.
    function test_UpdateParamsAcceptsTupleTheValidatorRejects() public {
        ContributionsFactory.CreateArgs memory args;
        args.parentInstanceId = parentId;
        args.name = "round-1";
        args.metadataURI = "";
        args.params = _contribParams();
        args.epochLength = EPOCH_FLOOR;

        vm.recordLogs();
        vm.prank(parentAdmin);
        (bytes32 instanceId, address snapshot,,,) = factory.createInstance(args);
        address controller = _decodeController(vm.getRecordedLogs(), instanceId);

        assertEq(
            ContributionsParamsController(controller).owner(), parentAdmin, "round owner should be the round admin"
        );

        // 1. The same out-of-envelope mutations, on a fresh creation-shaped tuple (derived fields
        //    still zero). The factory's creation gate refuses it.
        //    NOTE: built independently — a `memory` struct assignment in Solidity aliases, it does
        //    not copy, so reusing one struct for both checks would mutate the other.
        ContributionsParamsCodec.Params memory rogueAtCreation = _contribParams();
        _makeRogue(rogueAtCreation);
        vm.expectRevert();
        factory.validateParams(rogueAtCreation);

        // 2. The live tuple, mutated the same way. The program's own validator refuses it.
        ContributionsParamsCodec.Params memory rogue =
            ContributionsParamsController(controller).getContributionsParams();
        _makeRogue(rogue);
        vm.expectRevert();
        probe.validateFinal(rogue);

        // 3. ...and yet the controller installs it as the live commitment.
        bytes32 before = MerkleSnapshot(snapshot).paramsHash();
        vm.prank(parentAdmin);
        (uint64 newVersion, bytes32 newHash) =
            ContributionsParamsController(controller).updateParams(rogue, "ipfs://evidence");

        assertEq(newVersion, 2, "version should have advanced");
        assertTrue(newHash != before, "the live params hash changed");
        assertEq(MerkleSnapshot(snapshot).paramsHash(), newHash, "snapshot now pins the out-of-envelope tuple");
        assertEq(
            registry.getInstance(instanceId).paramsHash, newHash, "registry now pins the out-of-envelope tuple"
        );
        assertEq(
            ContributionsParamsController(controller).getContributionsParams().precisionScale,
            1,
            "precisionScale escaped the fixed-point envelope"
        );
    }

    /// @notice Control: the sibling trust-graph controller DOES validate the same class of update,
    ///         which is what makes the gap above an inconsistency rather than a design choice.
    function test_SiblingTrustgraphsControllerRejectsTheSameClassOfUpdate() public {
        vm.recordLogs();
        (bytes32 tgInstanceId,,,,) = trustFactory.createInstance(_trustArgs("control-network"));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address tgController;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(trustFactory) || logs[i].topics.length != 3) continue;
            if (logs[i].topics[0] != TrustgraphsFactory.ParamsControllerCreated.selector) continue;
            if (logs[i].topics[1] != tgInstanceId) continue;
            tgController = address(uint160(uint256(logs[i].topics[2])));
        }
        require(tgController != address(0), "no controller");

        TrustgraphsParamsController tg = TrustgraphsParamsController(tgController);
        ParamsCodec.Params memory next = tg.getCurrentParams();
        next.precisionScale = 1;

        vm.prank(parentAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidPrecisionScale.selector, uint256(1))
        );
        tg.updateParams(next, "");
    }
}
