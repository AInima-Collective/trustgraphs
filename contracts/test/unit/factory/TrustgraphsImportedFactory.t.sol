// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Vm} from "forge-std/Vm.sol";

import {
    IEAS,
    AttestationRequestData,
    DelegatedAttestationRequest,
    MultiDelegatedAttestationRequest
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {
    Attestation,
    EMPTY_UID,
    NO_EXPIRATION_TIME,
    Signature
} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {EASAttestAndImportRouter} from "src/eas/EASAttestAndImportRouter.sol";
import {OnchainAttestationImporter} from "src/eas/OnchainAttestationImporter.sol";
import {
    ImportedTrustgraphsFactory,
    ImportedTrustgraphsBundleDeployer
} from "src/factory/ImportedTrustgraphsFactory.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {GovernedImportedTrustgraphsFactory} from "src/factory/GovernedImportedTrustgraphsFactory.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {
    OnchainImportLaneDeployer,
    GovernedAuthorityDeployer,
    SignerSyncModuleDeployer,
    MerkleGovModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

import {TrustgraphsFactoryBase} from "./TrustgraphsFactoryBase.sol";

contract ImportedFactorySignerVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

contract TrustgraphsImportedFactoryTest is TrustgraphsFactoryBase {
    uint256 internal constant ATTESTER_KEY = 0xA11CE;
    address internal attester;
    address internal relayer = address(0xB0B);
    bytes32 internal legacySchemaUid;
    OnchainImportLaneDeployer internal importLaneDeployer;
    ImportedTrustgraphsBundleDeployer internal bundleDeployer;
    ImportedTrustgraphsFactory internal importedFactory;

    function setUp() public override {
        super.setUp();
        attester = vm.addr(ATTESTER_KEY);
        legacySchemaUid =
            schemaRegistry.register("string context,uint256 reputation", ISchemaResolver(address(0)), true);
        importLaneDeployer = new OnchainImportLaneDeployer();
        bundleDeployer = new ImportedTrustgraphsBundleDeployer(
            IEAS(address(eas)),
            IZkVerifier(address(verifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            importLaneDeployer
        );
        importedFactory = new ImportedTrustgraphsFactory(bundleDeployer, distributorDeployer, EPOCH_FLOOR, vault);
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.prank(registryAdmin);
        registry.grantRole(registrarRole, address(importedFactory));
    }

    function _importArgs(string memory name) internal view returns (TrustgraphsFactory.CreateArgs memory args) {
        args = _args(name);
        args.params.minWeightFp = 1e18;
        args.params.weightFieldIndex = type(uint32).max;
    }

    function _importLane(Vm.Log[] memory logs, bytes32 expectedInstanceId)
        internal
        view
        returns (address importer, address router, address sourceEas, bytes32 schemaUid)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (
                log.emitter != address(importedFactory) || log.topics.length != 4
                    || log.topics[0] != ImportedTrustgraphsFactory.ImportedEasLaneCreated.selector
            ) continue;
            assertEq(log.topics[1], expectedInstanceId, "wrong imported instance id");
            importer = address(uint160(uint256(log.topics[2])));
            router = address(uint160(uint256(log.topics[3])));
            (sourceEas, schemaUid) = abi.decode(log.data, (address, bytes32));
            return (importer, router, sourceEas, schemaUid);
        }
        revert("ImportedEasLaneCreated was not emitted");
    }

    function _data(address recipient, uint256 reputation) internal pure returns (AttestationRequestData memory) {
        return AttestationRequestData({
            recipient: recipient,
            expirationTime: NO_EXPIRATION_TIME,
            revocable: true,
            refUID: EMPTY_UID,
            data: abi.encode("legacy", reputation),
            value: 0
        });
    }

    function _sign(AttestationRequestData memory data, uint256 nonce, uint64 deadline)
        internal
        view
        returns (Signature memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                eas.getAttestTypeHash(),
                attester,
                legacySchemaUid,
                data.recipient,
                data.expirationTime,
                data.revocable,
                data.refUID,
                keccak256(data.data),
                data.value,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", eas.getDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, digest);
        return Signature({v: v, r: r, s: s});
    }

    function test_CreateImportedInstanceWiresImmutableLaneAndFrozenCatalogEvent() public {
        TrustgraphsFactory.CreateArgs memory args = _importArgs("legacy-community");
        vm.recordLogs();
        (bytes32 instanceId, address snapshot, address accumulator,, bytes32 schemaUid) =
            importedFactory.createImportedInstance(args, legacySchemaUid);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (address importer, address router, address sourceEas, bytes32 importedSchema) = _importLane(logs, instanceId);
        assertEq(accumulator, importer);
        assertEq(schemaUid, legacySchemaUid);
        assertEq(importedSchema, legacySchemaUid);
        assertEq(sourceEas, address(eas));
        assertEq(address(OnchainAttestationImporter(importer).EAS()), address(eas));
        assertEq(OnchainAttestationImporter(importer).schemaUid(), legacySchemaUid);
        assertEq(OnchainAttestationImporter(importer).snapshot(), snapshot);
        assertEq(address(EASAttestAndImportRouter(router).EAS()), address(eas));
        assertEq(address(EASAttestAndImportRouter(router).IMPORTER()), importer);
        assertEq(EASAttestAndImportRouter(router).SCHEMA_UID(), legacySchemaUid);
        assertEq(importLaneDeployer.pendingBinder(importer), address(0), "binder capability survived creation");

        MerkleSnapshot merkleSnapshot = MerkleSnapshot(snapshot);
        assertEq(address(merkleSnapshot.accumulator()), importer);
        ParamsCodec.Params memory finalParams = args.params;
        finalParams.schemaUid = legacySchemaUid;
        finalParams.accumulator = importer;
        finalParams.chainId = uint64(block.chainid);
        assertEq(merkleSnapshot.paramsHash(), ParamsCodec.hash(finalParams));

        IInstanceRegistry.Instance memory registered = registry.getInstance(instanceId);
        assertEq(registered.registryOrAccumulator, importer);
        assertEq(registered.snapshot, snapshot);
    }

    function test_CreateImportedInstanceRejectsUnknownSchemaBeforeRegistration() public {
        bytes32 missing = keccak256("not registered");
        vm.expectRevert(
            abi.encodeWithSelector(ImportedTrustgraphsBundleDeployer.ImportedSchemaNotFound.selector, missing)
        );
        importedFactory.createImportedInstance(_importArgs("missing"), missing);
    }

    function test_RouterPreservesSignerAndImportsReturnedUidAtomically() public {
        TrustgraphsFactory.CreateArgs memory args = _importArgs("router");
        vm.recordLogs();
        (bytes32 instanceId,, address importer,,) = importedFactory.createImportedInstance(args, legacySchemaUid);
        (, address router,,) = _importLane(vm.getRecordedLogs(), instanceId);

        AttestationRequestData memory data = _data(address(0xCAFE), 87);
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        DelegatedAttestationRequest memory request = DelegatedAttestationRequest({
            schema: legacySchemaUid,
            data: data,
            signature: _sign(data, 0, deadline),
            attester: attester,
            deadline: deadline
        });

        vm.prank(relayer);
        bytes32 uid = EASAttestAndImportRouter(router).attestAndImport(request);
        Attestation memory stored = eas.getAttestation(uid);
        assertEq(stored.attester, attester, "router became the attester");
        assertEq(stored.recipient, data.recipient);
        assertTrue(OnchainAttestationImporter(importer).attestationsProcessed(uid));
        assertEq(OnchainAttestationImporter(importer).leafCount(), 1);
        assertEq(eas.getNonce(attester), 1);
    }

    function test_RouterImportsADelegatedBatchAndRejectsForeignSchemaAtomically() public {
        vm.recordLogs();
        (bytes32 instanceId,, address importer,,) =
            importedFactory.createImportedInstance(_importArgs("batch-router"), legacySchemaUid);
        (, address router,,) = _importLane(vm.getRecordedLogs(), instanceId);

        uint64 deadline = uint64(block.timestamp + 15 minutes);
        AttestationRequestData[] memory data = new AttestationRequestData[](2);
        data[0] = _data(address(0x1111), 10);
        data[1] = _data(address(0x2222), 20);
        Signature[] memory signatures = new Signature[](2);
        signatures[0] = _sign(data[0], 0, deadline);
        signatures[1] = _sign(data[1], 1, deadline);
        MultiDelegatedAttestationRequest[] memory requests = new MultiDelegatedAttestationRequest[](1);
        requests[0] = MultiDelegatedAttestationRequest({
            schema: legacySchemaUid, data: data, signatures: signatures, attester: attester, deadline: deadline
        });

        vm.prank(relayer);
        bytes32[] memory uids = EASAttestAndImportRouter(router).multiAttestAndImport(requests);
        assertEq(uids.length, 2);
        assertEq(OnchainAttestationImporter(importer).leafCount(), 2);
        assertTrue(OnchainAttestationImporter(importer).attestationsProcessed(uids[0]));
        assertTrue(OnchainAttestationImporter(importer).attestationsProcessed(uids[1]));

        bytes32 foreign = schemaRegistry.register("bytes32 foreign", ISchemaResolver(address(0)), true);
        requests[0].schema = foreign;
        vm.expectRevert(
            abi.encodeWithSelector(EASAttestAndImportRouter.ForeignSchema.selector, foreign, legacySchemaUid)
        );
        EASAttestAndImportRouter(router).multiAttestAndImport(requests);
        assertEq(OnchainAttestationImporter(importer).leafCount(), 2);
    }

    function test_GovernedImportedInstanceMakesSafeTheAuthority() public {
        bytes32 signerVkey = keccak256("imported factory signer guest");
        GovernedImportedTrustgraphsFactory governed = new GovernedImportedTrustgraphsFactory(
            importedFactory,
            new GnosisSafeProxyFactory(),
            address(new GnosisSafe()),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            new ImportedFactorySignerVerifier(signerVkey),
            signerVkey
        );
        TrustgraphsFactory.CreateArgs memory args = _importArgs("governed-legacy");
        args.admin = address(0xBAD);
        GovernedFactoryBase.InitialPolicy memory policy =
            GovernedFactoryBase.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
        GovernedFactoryBase.SignerSyncConfig memory signer =
            GovernedFactoryBase.SignerSyncConfig({enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0});

        vm.recordLogs();
        vm.prank(attester);
        (bytes32 instanceId, address safe,, address snapshot) =
            governed.createGovernedImportedInstance(args, legacySchemaUid, policy, signer);
        (address importer,,,) = _importLane(vm.getRecordedLogs(), instanceId);

        assertEq(address(MerkleSnapshot(snapshot).accumulator()), importer);
        assertEq(governed.authorityOf(instanceId).safe, safe);
        assertTrue(MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), safe));
        assertFalse(MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), address(governed)));
    }

    function test_ImportedFactoriesRetainEip170Headroom() public view {
        assertLt(address(importedFactory).code.length, 24_576);
        assertLt(address(bundleDeployer).code.length, 24_576);
        assertGt(24_576 - address(importedFactory).code.length, 10_000, "imported factory runtime margin");
        assertGt(24_576 - address(bundleDeployer).code.length, 10_000, "bundle deployer runtime margin");
    }
}
