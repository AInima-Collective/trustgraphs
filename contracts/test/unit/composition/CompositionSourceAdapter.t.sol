// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {ICompositionSourceAdapter} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";

contract DirectAdapterVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }
}

contract DirectAdapterSnapshot {
    bool public provenanceEnabled = true;
    uint256 public stateCount = 1;
    IMerkleSnapshot.MerkleState private _state;
    IMerkleSnapshotProvenance.StateProvenance private _provenance;

    constructor(address verifier, bytes32 verifierCodehash, bytes32 programVKey) {
        _state = IMerkleSnapshot.MerkleState({
            blockNumber: 10,
            timestamp: 100,
            root: keccak256("root"),
            ipfsHash: sha256("blob"),
            ipfsHashCid: "bafk-source",
            totalValue: 1_000
        });
        _provenance = IMerkleSnapshotProvenance.StateProvenance({
            checkpointId: 7,
            stateIndex: 0,
            acceptedAtBlock: 11,
            paramsHash: keccak256("params"),
            verifier: verifier,
            verifierCodehash: verifierCodehash,
            programVKey: programVKey
        });
    }

    function setProvenanceEnabled(bool enabled) external {
        provenanceEnabled = enabled;
    }

    function setStateCount(uint256 count) external {
        stateCount = count;
    }

    function setState(IMerkleSnapshot.MerkleState calldata state_) external {
        _state = state_;
    }

    function setProvenance(IMerkleSnapshotProvenance.StateProvenance calldata provenance_) external {
        _provenance = provenance_;
    }

    function getStateCount() external view returns (uint256) {
        return stateCount;
    }

    function getStateAtIndex(uint256) external view returns (IMerkleSnapshot.MerkleState memory) {
        return _state;
    }

    function getStateProvenance(uint256) external view returns (IMerkleSnapshotProvenance.StateProvenance memory) {
        return _provenance;
    }

    function getAcceptedCheckpoint(uint256)
        external
        view
        returns (IMerkleSnapshot.MerkleState memory, IMerkleSnapshotProvenance.StateProvenance memory)
    {
        return (_state, _provenance);
    }
}

contract CompositionSourceAdapterTest is Test {
    bytes32 internal constant INSTANCE_ID = keccak256("source instance");
    bytes32 internal constant SOURCE_ID = keccak256("source id");
    bytes32 internal constant SOURCE_PROGRAM = keccak256("trust-graph-weighted");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    bytes32 internal constant PROVENANCE = keccak256("deployment provenance");
    bytes32 internal constant VKEY = keccak256("source vkey");

    InstanceRegistry internal registry;
    DirectAdapterVerifier internal verifier;
    DirectAdapterSnapshot internal snapshot;
    CompositionSourceAdapterFactory internal factory;
    CompositionSourceAdapter internal adapter;

    function setUp() public {
        registry = new InstanceRegistry(address(this));
        verifier = new DirectAdapterVerifier(VKEY);
        snapshot = new DirectAdapterSnapshot(address(verifier), address(verifier).codehash, VKEY);
        _register(INSTANCE_ID, SOURCE_PROGRAM, address(snapshot), address(verifier), address(0xACC), address(this));
        factory = new CompositionSourceAdapterFactory(registry);
        adapter = factory.create(registry, INSTANCE_ID, SOURCE_ID, FAMILY, OUTPUT_KIND, PROVENANCE);
    }

    function _register(
        bytes32 id,
        bytes32 program,
        address snapshot_,
        address verifier_,
        address accumulator,
        address authority
    ) internal {
        IInstanceRegistry.Instance memory record = IInstanceRegistry.Instance({
            program: program,
            snapshot: snapshot_,
            verifier: verifier_,
            registryOrAccumulator: accumulator,
            paramsHash: keccak256(abi.encode("params", id))
        });
        if (authority == address(0)) registry.register(id, record);
        else registry.registerWithParamsAuthority(id, record, authority);
    }

    function test_FactoryPinsRegistryAndRegistersOnlySuccessfulAdapters() public {
        assertEq(address(factory.registry()), address(registry));
        assertTrue(factory.isAdapter(address(adapter)));
        assertEq(address(adapter.registry()), address(registry));
        assertEq(adapter.instanceId(), INSTANCE_ID);
        assertEq(adapter.snapshot(), address(snapshot));
        assertEq(adapter.verifier(), address(verifier));
        assertEq(adapter.programVKey(), VKEY);
        assertEq(adapter.deploymentProvenance(), PROVENANCE);

        InstanceRegistry foreign = new InstanceRegistry(address(this));
        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAdapterFactory.ForeignRegistry.selector, address(registry), address(foreign)
            )
        );
        factory.create(foreign, INSTANCE_ID, SOURCE_ID, FAMILY, OUTPUT_KIND, PROVENANCE);
    }

    function test_ReadLatestAtAndCheckpointReturnAuthenticatedProvenance() public view {
        ICompositionSourceAdapter.CapturedState memory latest = adapter.readLatest();
        assertEq(latest.stateIndex, 0);
        assertEq(latest.freezeBlock, 10);
        assertEq(latest.checkpointId, 7);
        assertEq(latest.acceptedAtBlock, 11);
        assertEq(latest.totalValue, 1_000);
        assertEq(latest.verifier, address(verifier));
        assertEq(latest.verifierCodehash, address(verifier).codehash);
        assertEq(latest.programVKey, VKEY);
        assertEq(adapter.readAt(0).outputRoot, latest.outputRoot);
        assertEq(adapter.readCheckpoint(7).outputRoot, latest.outputRoot);
    }

    function test_ConstructorRejectsZeroIdentityCompositeAndUncontrolledSources() public {
        vm.expectRevert(CompositionSourceAdapter.ZeroIdentity.selector);
        new CompositionSourceAdapter(registry, INSTANCE_ID, bytes32(0), FAMILY, OUTPUT_KIND, PROVENANCE);

        bytes32 compositeId = keccak256("composite");
        _register(
            compositeId,
            keccak256("trust-compose"),
            address(snapshot),
            address(verifier),
            address(0xACC2),
            address(this)
        );
        vm.expectRevert(CompositionSourceAdapter.CompositeSourceUnsupported.selector);
        new CompositionSourceAdapter(registry, compositeId, SOURCE_ID, FAMILY, OUTPUT_KIND, PROVENANCE);

        bytes32 uncontrolledId = keccak256("uncontrolled");
        _register(uncontrolledId, SOURCE_PROGRAM, address(snapshot), address(verifier), address(0xACC3), address(0));
        vm.expectRevert(CompositionSourceAdapter.UncontrolledSource.selector);
        new CompositionSourceAdapter(registry, uncontrolledId, SOURCE_ID, FAMILY, OUTPUT_KIND, PROVENANCE);
    }

    function test_ConstructorRequiresProvenanceEnabled() public {
        DirectAdapterSnapshot disabled = new DirectAdapterSnapshot(address(verifier), address(verifier).codehash, VKEY);
        disabled.setProvenanceEnabled(false);
        bytes32 disabledId = keccak256("disabled");
        _register(disabledId, SOURCE_PROGRAM, address(disabled), address(verifier), address(0xACC4), address(this));
        vm.expectRevert(CompositionSourceAdapter.ProvenanceDisabled.selector);
        new CompositionSourceAdapter(registry, disabledId, SOURCE_ID, FAMILY, OUTPUT_KIND, PROVENANCE);
    }

    function test_ReadsFailClosedForUnavailableMalformedOrWrongVerifierState() public {
        snapshot.setStateCount(0);
        vm.expectRevert(CompositionSourceAdapter.SourceUnavailable.selector);
        adapter.readLatest();

        snapshot.setStateCount(1);
        IMerkleSnapshot.MerkleState memory malformed = IMerkleSnapshot.MerkleState({
            blockNumber: 10,
            timestamp: 100,
            root: keccak256("root"),
            ipfsHash: sha256("blob"),
            ipfsHashCid: "bafk-source",
            totalValue: 0
        });
        snapshot.setState(malformed);
        vm.expectPartialRevert(CompositionSourceAdapter.InvalidTotalValue.selector);
        adapter.readLatest();

        malformed.totalValue = 1;
        snapshot.setState(malformed);
        IMerkleSnapshotProvenance.StateProvenance memory provenance = IMerkleSnapshotProvenance.StateProvenance({
            checkpointId: 7,
            stateIndex: 0,
            acceptedAtBlock: 11,
            paramsHash: keccak256("params"),
            verifier: address(0xBAD),
            verifierCodehash: address(verifier).codehash,
            programVKey: VKEY
        });
        snapshot.setProvenance(provenance);
        vm.expectPartialRevert(CompositionSourceAdapter.WrongVerifier.selector);
        adapter.readLatest();
    }

    function test_RegistryIdentityDriftInvalidatesAdapter() public {
        IInstanceRegistry.Instance memory record = registry.getInstance(INSTANCE_ID);
        record.registryOrAccumulator = address(0xDEAD);
        registry.update(INSTANCE_ID, record);
        vm.expectRevert(CompositionSourceAdapter.RegistryRecordChanged.selector);
        adapter.readLatest();
    }
}
