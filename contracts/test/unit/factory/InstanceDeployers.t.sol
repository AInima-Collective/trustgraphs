// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustgraphsFactoryBase} from "./TrustgraphsFactoryBase.sol";

import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer,
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {TrustgraphsParamsController} from "src/factory/TrustgraphsParamsController.sol";
import {SafeExecutionGuard} from "src/zodiac/SafeExecutionGuard.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {
    SignerSyncZkModule,
    ISignerSyncCheckpointSource,
    ISignerActivitySource
} from "src/zodiac/SignerSyncZkModule.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

contract InstanceDeployerVkeyVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

contract InstanceDeployersTest is TrustgraphsFactoryBase {
    address internal constant CONSTITUTIONAL = address(0xC043);
    address internal constant OPERATIONAL = address(0x0A11);
    address internal constant SAFE = address(0x5AFE);

    function test_MerkleSnapshotDeployerUsesExplicitAdminsAndRetainsNoAuthority() public {
        MockAccumulator accumulator = new MockAccumulator();
        bytes32 paramsHash = keccak256("params");
        MerkleSnapshot snapshot =
            snapshotDeployer.deploy(verifier, paramsHash, accumulator, CONSTITUTIONAL, OPERATIONAL, "");

        assertEq(address(snapshot.zkVerifier()), address(verifier));
        assertEq(address(snapshot.accumulator()), address(accumulator));
        assertEq(snapshot.paramsHash(), paramsHash);
        assertTrue(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), CONSTITUTIONAL));
        assertTrue(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), OPERATIONAL));
        assertFalse(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), address(snapshotDeployer)));
        assertFalse(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), address(snapshotDeployer)));
    }

    function test_MerkleFundDistributorDeployerSetsOwnerDirectlyAndRetainsNothing() public {
        address owner = address(0xA11CE);
        MerkleFundDistributor distributor = distributorDeployer.deploy(owner, address(0x500), owner, 5e16, true);

        assertEq(distributor.owner(), owner);
        assertEq(distributor.pendingOwner(), address(0));
        assertEq(distributor.merkleSnapshot(), address(0x500));
        assertEq(distributor.feeRecipient(), owner);
        assertEq(distributor.feePercentage(), 5e16);
        assertTrue(distributor.allowlistEnabled());
        assertNotEq(distributor.owner(), address(distributorDeployer));
    }

    function test_TrustgraphsParamsControllerDeployerPreservesCallerAsInitialPublisher() public {
        ParamsCodec.Params memory params = _goldenParams();
        MockAccumulator accumulator = new MockAccumulator();
        params.accumulator = address(accumulator);
        params.chainId = uint64(block.chainid);
        params.lane2MaxHeadAge = 0;
        bytes32 paramsHash = ParamsCodec.hash(params);
        MerkleSnapshot snapshot =
            snapshotDeployer.deploy(verifier, paramsHash, accumulator, CONSTITUTIONAL, OPERATIONAL, "");
        TrustgraphsParamsControllerDeployer directDeployer = new TrustgraphsParamsControllerDeployer();
        address owner = address(0xA11CE);
        TrustgraphsParamsController controller = directDeployer.deploy(
            keccak256("instance"), address(snapshot), IInstanceRegistry(address(registry)), params, owner
        );

        assertEq(controller.owner(), owner);
        assertEq(controller.initialPublisher(), address(this));
        assertEq(controller.currentParamsHash(), paramsHash);
        assertFalse(controller.versionOnePublished());
    }

    function test_GovernedAuthorityDeployerUsesExplicitSafeBootstrapperAndRecoveryTerms() public {
        GovernedAuthorityDeployer directDeployer = new GovernedAuthorityDeployer();
        address bootstrapper = address(0xB007);
        address proposer = address(0xCA11);
        (SafeExecutionGuard guard, DelayedRecoveryModule recovery) =
            directDeployer.deploy(SAFE, bootstrapper, proposer, uint48(14 days));

        assertEq(guard.safe(), SAFE);
        assertEq(guard.bootstrapper(), bootstrapper);
        assertFalse(guard.isSealed());
        assertEq(address(recovery.safe()), SAFE);
        assertEq(recovery.proposer(), proposer);
        assertEq(recovery.delay(), 14 days);
    }

    function test_MerkleGovModuleDeployerUsesOnlyExplicitAuthorityAndSnapshot() public {
        MockAccumulator accumulator = new MockAccumulator();
        MerkleSnapshot snapshot =
            snapshotDeployer.deploy(verifier, keccak256("params"), accumulator, CONSTITUTIONAL, OPERATIONAL, "");
        MerkleGovModuleDeployer directDeployer = new MerkleGovModuleDeployer();
        MerkleGovModule module = directDeployer.deploy(SAFE, SAFE, SAFE, address(snapshot));

        assertEq(module.owner(), SAFE);
        assertEq(module.avatar(), SAFE);
        assertEq(module.target(), SAFE);
        assertEq(module.merkleSnapshotContract(), address(snapshot));
        assertEq(module.currentMerkleRoot(), bytes32(0));
    }

    function test_SignerSyncModuleDeployerValidatesVerifierSelectionAndConfiguresModule() public {
        bytes32 vkey = keccak256("signer vkey");
        InstanceDeployerVkeyVerifier signerVerifier = new InstanceDeployerVkeyVerifier(vkey);
        MockAccumulator accumulator = new MockAccumulator();
        SignerSyncModuleDeployer directDeployer = new SignerSyncModuleDeployer();
        bytes32 instanceId = keccak256("instance");
        ISignerSyncCheckpointSource scoreSource = ISignerSyncCheckpointSource(address(0x501));
        ISignerActivitySource activitySource = ISignerActivitySource(address(0xA71));

        SignerSyncZkModule module = directDeployer.deploy(
            instanceId,
            SAFE,
            signerVerifier,
            IAttestationAccumulator(address(accumulator)),
            scoreSource,
            activitySource,
            vkey,
            5,
            2,
            5_000,
            151_200,
            2
        );

        assertEq(module.owner(), SAFE);
        assertEq(module.avatar(), SAFE);
        assertEq(address(module.zkVerifier()), address(signerVerifier));
        assertEq(address(module.accumulator()), address(accumulator));
        assertEq(address(module.scoreSnapshot()), address(scoreSource));
        assertEq(address(module.activitySource()), address(activitySource));
        assertEq(
            module.selectionParamsHash(),
            keccak256(abi.encode(uint32(5), uint32(2), uint32(5_000), uint64(151_200), uint32(2)))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                SignerSyncModuleDeployer.SignerProgramVKeyMismatch.selector, bytes32(uint256(1)), vkey
            )
        );
        directDeployer.deploy(
            instanceId,
            SAFE,
            signerVerifier,
            accumulator,
            scoreSource,
            activitySource,
            bytes32(uint256(1)),
            5,
            2,
            5_000,
            151_200,
            2
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                SignerSyncModuleDeployer.InvalidSignerSelection.selector, uint32(1), uint32(1), uint32(0)
            )
        );
        directDeployer.deploy(
            instanceId, SAFE, signerVerifier, accumulator, scoreSource, activitySource, vkey, 1, 1, 0, 151_200, 1
        );
    }
}
