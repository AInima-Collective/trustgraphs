// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {DistributorAttaching} from "src/factory/DistributorAttaching.sol";
import {CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {
    CompositionSourceAccumulatorDeployer,
    TrustComposeParamsControllerDeployer
} from "src/factory/TrustComposeInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {CompositionPolicyTestLib} from "../../helpers/CompositionPolicyTestLib.sol";
import {MockSafeOwner} from "../../helpers/MockSafeOwner.sol";

contract DirectComposeVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

contract DirectNoVkeyVerifier is IZkVerifier {
    function verify(bytes calldata, bytes32) external pure {}
}

contract TrustComposeFactoryTest is Test {
    bytes32 internal constant VKEY = keccak256("composition vkey");
    uint64 internal constant EPOCH_FLOOR = 7_200;
    uint48 internal constant ACTIVATION_DELAY = 2 days;

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    DirectComposeVerifier internal verifier;
    MerkleSnapshotDeployer internal snapshotDeployer;
    MerkleFundDistributorDeployer internal distributorDeployer;
    CompositionSourceAccumulatorDeployer internal accumulatorDeployer;
    TrustComposeParamsControllerDeployer internal controllerDeployer;
    TrustComposeFactory internal factory;

    function setUp() public {
        registry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(registry);
        verifier = new DirectComposeVerifier(VKEY);
        snapshotDeployer = new MerkleSnapshotDeployer();
        distributorDeployer = new MerkleFundDistributorDeployer();
        accumulatorDeployer = new CompositionSourceAccumulatorDeployer();
        controllerDeployer = new TrustComposeParamsControllerDeployer();
        factory = _deploy(verifier, VKEY, registry, adapterFactory, EPOCH_FLOOR, ACTIVATION_DELAY);
    }

    function _deploy(
        IZkVerifier verifier_,
        bytes32 vkey,
        IInstanceRegistry registry_,
        CompositionSourceAdapterFactory adapterFactory_,
        uint64 epochFloor,
        uint48 activationDelay
    ) internal returns (TrustComposeFactory) {
        return new TrustComposeFactory(
            verifier_,
            vkey,
            registry_,
            adapterFactory_,
            snapshotDeployer,
            distributorDeployer,
            accumulatorDeployer,
            controllerDeployer,
            epochFloor,
            activationDelay,
            IProvingVault(address(0))
        );
    }

    function test_ConstructorPinsDependenciesAndTimingConstants() public view {
        assertEq(address(factory.VERIFIER()), address(verifier));
        assertEq(factory.PROGRAM_VKEY(), VKEY);
        assertEq(address(factory.INSTANCE_REGISTRY()), address(registry));
        assertEq(address(factory.SOURCE_ADAPTER_FACTORY()), address(adapterFactory));
        assertEq(factory.EPOCH_FLOOR(), EPOCH_FLOOR);
        assertEq(factory.POLICY_ACTIVATION_DELAY(), ACTIVATION_DELAY);
        assertEq(address(factory.VAULT()), address(0));
        assertEq(factory.PROGRAM(), keccak256("trust-compose"), "the factory registers the composition program");
    }

    function test_ConstructorRejectsZeroInvalidAndMismatchedVerifier() public {
        vm.expectRevert(DistributorAttaching.ZeroAddress.selector);
        _deploy(IZkVerifier(address(0)), VKEY, registry, adapterFactory, EPOCH_FLOOR, ACTIVATION_DELAY);

        DirectNoVkeyVerifier invalidVerifier = new DirectNoVkeyVerifier();
        vm.expectRevert(TrustComposeFactory.InvalidCompositionVerifier.selector);
        _deploy(invalidVerifier, VKEY, registry, adapterFactory, EPOCH_FLOOR, ACTIVATION_DELAY);

        bytes32 supplied = keccak256("wrong supplied vkey");
        vm.expectRevert(abi.encodeWithSelector(TrustComposeFactory.ProgramVKeyMismatch.selector, supplied, VKEY));
        _deploy(verifier, supplied, registry, adapterFactory, EPOCH_FLOOR, ACTIVATION_DELAY);

        vm.expectRevert(TrustComposeFactory.ZeroEpochFloor.selector);
        _deploy(verifier, VKEY, registry, adapterFactory, 0, ACTIVATION_DELAY);

        vm.expectRevert(TrustComposeFactory.ZeroActivationDelay.selector);
        _deploy(verifier, VKEY, registry, adapterFactory, EPOCH_FLOOR, 0);
    }

    function test_ConstructorRejectsAdapterFactoryFromAnotherRegistry() public {
        InstanceRegistry foreignRegistry = new InstanceRegistry(address(this));
        CompositionSourceAdapterFactory foreignFactory = new CompositionSourceAdapterFactory(foreignRegistry);
        vm.expectRevert(
            abi.encodeWithSelector(
                TrustComposeFactory.SourceAdapterRegistryMismatch.selector, address(registry), address(foreignRegistry)
            )
        );
        _deploy(verifier, VKEY, registry, foreignFactory, EPOCH_FLOOR, ACTIVATION_DELAY);
    }

    function test_CreateInstanceRejectsPaymentWithoutVaultAndNameBoundariesBeforeDeployment() public {
        TrustComposeFactory.CreateArgs memory args;
        args.name = "valid";
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TrustComposeFactory.NoVaultConfigured.selector);
        factory.createInstance{value: 1}(args);

        args.name = "";
        vm.expectRevert(TrustComposeFactory.EmptyName.selector);
        factory.createInstance(args);

        args.name = new string(factory.MAX_NAME_BYTES() + 1);
        vm.expectRevert(abi.encodeWithSelector(TrustComposeFactory.NameTooLong.selector, bytes(args.name).length));
        factory.createInstance(args);
    }

    function test_ComputeInstanceIdIsDomainSeparatedByCreatorNameAndSalt() public view {
        bytes32 salt = keccak256("salt");
        bytes32 expected = keccak256(abi.encode(address(this), "name", salt));
        assertEq(factory.computeInstanceId(address(this), "name", salt), expected);
        assertNotEq(factory.computeInstanceId(address(0xBEEF), "name", salt), expected);
        assertNotEq(factory.computeInstanceId(address(this), "other", salt), expected);
    }

    function test_AttachDistributorRejectsInstancesFromAnotherProgram() public {
        bytes32 instanceId = keccak256("foreign instance");
        registry.register(
            instanceId,
            IInstanceRegistry.Instance({
                program: keccak256("trust-graph"),
                snapshot: address(0x100),
                verifier: address(verifier),
                registryOrAccumulator: address(0x200),
                paramsHash: keccak256("params")
            })
        );
        vm.expectRevert(abi.encodeWithSelector(DistributorAttaching.UnknownInstance.selector, instanceId));
        factory.attachDistributor(instanceId, address(this), address(0));
    }

    function test_DistributorCreationAndAttachmentRejectEoaOwners() public {
        TrustComposeFactory.CreateArgs memory args;
        args.name = "unsafe composition fund";
        args.params = CompositionPolicyTestLib.creationParams(1_000);
        args.policyManifest = CompositionPolicyTestLib.manifest(address(0x100), address(0x200), 1_000, false);
        args.admin = address(this);
        args.withDistributor = true;
        vm.expectRevert(abi.encodeWithSelector(DistributorAttaching.InvalidDistributorSafe.selector, address(this)));
        factory.createInstance(args);

        MockAccumulator accumulator = new MockAccumulator();
        MockSafeOwner safe = new MockSafeOwner(address(this), 1);
        MerkleSnapshot safeSnapshot = new MerkleSnapshot(
            verifier,
            keccak256("safe compose params"),
            IAttestationAccumulator(address(accumulator)),
            address(safe),
            address(safe),
            ""
        );
        bytes32 safeInstanceId = keccak256("safe fundless composition");
        registry.register(
            safeInstanceId,
            IInstanceRegistry.Instance({
                program: factory.PROGRAM(),
                snapshot: address(safeSnapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accumulator),
                paramsHash: safeSnapshot.paramsHash()
            })
        );
        address distributor = factory.attachDistributor(safeInstanceId, address(safe), address(0));
        assertEq(factory.distributorOf(safeInstanceId), distributor);
    }
}
