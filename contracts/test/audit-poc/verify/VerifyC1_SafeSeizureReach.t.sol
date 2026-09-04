// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Safe} from "@safe-global/safe-smart-account/Safe.sol";
import {Enum} from "@safe-global/safe-smart-account/libraries/Enum.sol";
import {SafeProxyFactory} from "@safe-global/safe-smart-account/proxies/SafeProxyFactory.sol";

import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    ParentAuthorityModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {SubnetworkRegistry} from "src/registry/SubnetworkRegistry.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {SignerSyncZkModule} from "src/zodiac/SignerSyncZkModule.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {SafeExecutionGuard} from "src/zodiac/SafeExecutionGuard.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract AlwaysAccept is IZkVerifier {
    bytes32 public constant programVKey = keccak256("looks-real");

    function verify(bytes calldata, bytes32) external view {}
}

/// ADJUDICATION: does owning the governed Safe's owner slot actually confer control?
contract VerifyC1_SafeSeizureReach is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal gf;
    Safe internal singleton;
    SafeProxyFactory internal proxyFactory;
    AlwaysAccept internal fake;

    address internal creator = address(0xA11CE);
    address internal stranger = address(0xBADBAD);

    function setUp() public override {
        super.setUp();
        singleton = new Safe();
        proxyFactory = new SafeProxyFactory();
        fake = new AlwaysAccept();
        gf = new GovernedTrustgraphsFactory(
            factory,
            proxyFactory,
            address(singleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            new ParentAuthorityModuleDeployer(),
            new SubnetworkRegistry(registry, registryAdmin),
            fake,
            fake.programVKey()
        );
    }

    function test_SeizedOwnerSetCannotExecuteAnything() public {
        TrustgraphsFactory.CreateArgs memory args = _args("victim");
        args.salt = bytes32(uint256(1));

        vm.prank(creator);
        (bytes32 instanceId, address safeAddr,, address snapshot) = gf.createGovernedInstance(
            args,
            GovernedFactoryBase.InitialPolicy(0, 0),
            GovernedFactoryBase.SignerSyncConfig({enabled: true, topN: 3, minThreshold: 2, targetThresholdBps: 5_000})
        );

        GovernedFactoryBase.Authority memory auth = gf.authorityOf(instanceId);
        Safe safe = Safe(payable(safeAddr));

        // Give the Safe something worth stealing.
        vm.deal(safeAddr, 10 ether);

        MerkleSnapshot snap = MerkleSnapshot(snapshot);
        vm.roll(uint256(snap.epochOriginBlock()) + EPOCH_FLOOR);
        uint256 cp = snap.trigger();
        _mockActivity(auth.governanceModule);

        address[] memory desired = new address[](1);
        desired[0] = stranger;
        vm.prank(stranger);
        SignerSyncZkModule(auth.signerSyncModule).submitSignerProof(cp, 0, desired, 1, hex"00");

        assertTrue(safe.isOwner(stranger), "stranger is sole owner");
        assertEq(safe.getThreshold(), 1);

        // The guard is sealed. Try to move the Safe's ETH as the sole owner with an approved-hash
        // signature (v=1, valid for a 1-of-1 owner calling execTransaction directly).
        bytes memory sig = abi.encodePacked(uint256(uint160(stranger)), uint256(0), uint8(1));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SafeExecutionGuard.OwnerExecutionLocked.selector, stranger));
        safe.execTransaction(stranger, 10 ether, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig);
        assertEq(safeAddr.balance, 10 ether, "funds untouched");

        // ... and cannot remove the guard, enable a module, or delegatecall either.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SafeExecutionGuard.OwnerExecutionLocked.selector, stranger));
        safe.execTransaction(
            safeAddr,
            0,
            abi.encodeWithSignature("setGuard(address)", address(0)),
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            sig
        );

        // The snapshot's constitutional role is the Safe, and the Safe can only act through
        // modules, so the seized owner slot buys no authority over the instance either.
        assertTrue(snap.hasRole(snap.CONSTITUTIONAL_ROLE(), safeAddr));
        assertTrue(SafeExecutionGuard(auth.executionGuard).isSealed(), "guard sealed at creation");

        // The recovery proposer is still the creator, unchanged by the owner rotation.
        (bool ok, bytes memory ret) = auth.recoveryModule.staticcall(abi.encodeWithSignature("proposer()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), creator, "recovery identity unaffected by owner seizure");
    }

    /// The latent half: the sealed guard is not permanent. The creator's own recovery module can
    /// remove it after 14 days, and the attacker-chosen owner set then IS the Safe.
    function test_GuardRemovalMakesTheSeizedOwnerSetLive() public {
        TrustgraphsFactory.CreateArgs memory args = _args("victim2");
        args.salt = bytes32(uint256(2));

        vm.prank(creator);
        (bytes32 instanceId, address safeAddr,, address snapshot) = gf.createGovernedInstance(
            args,
            GovernedFactoryBase.InitialPolicy(0, 0),
            GovernedFactoryBase.SignerSyncConfig({enabled: true, topN: 3, minThreshold: 2, targetThresholdBps: 5_000})
        );
        GovernedFactoryBase.Authority memory auth = gf.authorityOf(instanceId);
        Safe safe = Safe(payable(safeAddr));
        vm.deal(safeAddr, 10 ether);

        MerkleSnapshot snap = MerkleSnapshot(snapshot);
        vm.roll(uint256(snap.epochOriginBlock()) + EPOCH_FLOOR);
        uint256 cp = snap.trigger();
        _mockActivity(auth.governanceModule);

        address[] memory desired = new address[](1);
        desired[0] = stranger;
        vm.prank(stranger);
        SignerSyncZkModule(auth.signerSyncModule).submitSignerProof(cp, 0, desired, 1, hex"00");

        // The recovery proposer (the creator) queues an ordinary guard removal.
        DelayedRecoveryModule rec = DelayedRecoveryModule(auth.recoveryModule);
        bytes memory removeGuard = abi.encodeWithSignature("setGuard(address)", address(0));
        vm.prank(rec.proposer());
        rec.schedule(safeAddr, 0, removeGuard, Enum.Operation.Call);
        vm.warp(block.timestamp + 14 days);
        rec.execute(0, safeAddr, 0, removeGuard, Enum.Operation.Call);

        // The seized owner set is now full control of the Safe.
        bytes memory sig = abi.encodePacked(uint256(uint160(stranger)), uint256(0), uint8(1));
        vm.prank(stranger);
        assertTrue(
            safe.execTransaction(
                stranger, 10 ether, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig
            )
        );
        assertEq(safeAddr.balance, 0, "attacker drained the Safe once the guard was gone");
        assertEq(stranger.balance, 10 ether);
    }

    function _mockActivity(address governanceModule) internal {
        bytes32 activityAcc = keccak256("adjudication activity");
        vm.mockCall(
            governanceModule,
            abi.encodeWithSelector(bytes4(keccak256("activityAccumulator()"))),
            abi.encode(activityAcc)
        );
        vm.mockCall(
            governanceModule, abi.encodeWithSelector(bytes4(keccak256("activityCount()"))), abi.encode(uint64(2))
        );
        vm.mockCall(
            governanceModule,
            abi.encodeWithSelector(MerkleGovModule.getActivityCheckpoint.selector, uint256(0)),
            abi.encode(MerkleGovModule.ActivityCheckpoint(activityAcc, 2, uint64(block.number)))
        );
    }
}
