// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Vm} from "forge-std/Vm.sol";

import {GovernedTrustgraphsFactory} from "contracts/factory/GovernedTrustgraphsFactory.sol";
import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsController} from "contracts/factory/TrustgraphsParamsController.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleGovModule} from "contracts/zodiac/MerkleGovModule.sol";
import {SignerSyncZkModule} from "contracts/zodiac/SignerSyncZkModule.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {DeployZodiacSafes} from "script/DeployZodiacSafes.s.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract DeployZodiacSafesHarness is DeployZodiacSafes {
    function handoff(address deployer, SafeDeployment memory deployment, TrustgraphsParamsController controller)
        external
    {
        _handoffScoringAuthority(deployer, deployment, controller);
    }
}

contract GovernedTrustgraphsFactoryTest is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    DeployZodiacSafesHarness internal zodiacHarness;

    address internal creator = address(0xA11CE);

    function _unpaidPolicy() internal pure returns (GovernedTrustgraphsFactory.InitialPolicy memory) {
        return GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
    }

    function setUp() public override {
        super.setUp();
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        governedFactory = new GovernedTrustgraphsFactory(factory, safeFactory, address(safeSingleton));
        zodiacHarness = new DeployZodiacSafesHarness();
    }

    function test_CreateGovernedInstanceMakesSafeTheAuthorityFromGenesis() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-owned");
        args.admin = address(0xBAD); // ignored: governed creation is never EOA-administered
        args.withDistributor = true;
        args.salt = bytes32(uint256(7));

        vm.recordLogs();
        vm.prank(creator);
        (bytes32 instanceId, address safe, address module, address snapshot) =
            governedFactory.createGovernedInstance(args, _unpaidPolicy());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        CreatedEvent memory created = _decodeCreated(logs);
        address controller = _decodeController(logs, instanceId);

        assertEq(created.creator, safe, "the Safe must be the canonical factory caller");
        assertEq(created.admin, safe, "the Safe must hold every instance authority");
        assertEq(factory.computeInstanceId(safe, args.name, args.salt), instanceId, "instance id creator mismatch");
        assertEq(created.snapshot, snapshot, "wrapper discovered the wrong snapshot");

        assertEq(TrustgraphsParamsController(controller).owner(), safe, "Safe must own scoring controller");
        assertEq(MerkleFundDistributor(created.distributor).owner(), safe, "Safe must own shared fund");
        assertTrue(
            MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), safe),
            "Safe must hold constitutional authority"
        );

        MerkleGovModule gov = MerkleGovModule(module);
        assertEq(gov.owner(), safe, "Safe must own governance settings");
        assertEq(gov.avatar(), safe, "module avatar must be Safe");
        assertEq(gov.target(), safe, "module target must be Safe");
        assertEq(gov.merkleSnapshotContract(), snapshot, "module must vote from this network");
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(module), "governance module must be enabled");
        assertEq(MerkleSnapshot(snapshot).hookCount(), 1, "governance hook must be installed");
        assertEq(address(MerkleSnapshot(snapshot).hooks(1)), module, "wrong governance hook");

        address[] memory owners = GnosisSafe(payable(safe)).getOwners();
        assertEq(owners.length, 1, "bootstrap owner must be removed");
        assertEq(owners[0], creator, "creator must be initial break-glass signer");
        assertEq(GnosisSafe(payable(safe)).getThreshold(), 1, "initial Safe threshold");
        assertFalse(GnosisSafe(payable(safe)).isOwner(address(governedFactory)), "wrapper retained Safe ownership");
    }

    function test_CreateGovernedInstanceForwardsPrepayAndInstallsPayablePolicyThroughSafe() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-funded");
        uint96 cap = 25e8;
        vault.setFeePerRootUsd(factory.PROGRAM(), 1, 5e8);
        vm.deal(creator, 3 ether);

        vm.prank(creator);
        (bytes32 instanceId, address safe,, address snapshot) = governedFactory.createGovernedInstance{value: 3 ether}(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: cap})
        );

        IProvingVault.Account memory account = vault.accountOf(instanceId);
        assertEq(account.ethBalance, 3 ether, "the instance tank must receive the full prepay");
        IProvingVault.Policy memory policy = vault.policyOf(instanceId);
        assertEq(policy.minPaidIntervalBlocks, EPOCH_FLOOR, "paid cadence must be installed atomically");
        assertEq(policy.maxPerRootUsd, cap, "per-root cap must be installed atomically");
        assertEq(address(vault).balance, 3 ether, "the governed wrapper must retain nothing");
        assertEq(safe.balance, 0, "the bootstrap Safe must retain nothing");
        assertEq(address(governedFactory).balance, 0, "the wrapper must retain nothing");

        vm.roll(EPOCH_FLOOR);
        MerkleSnapshot(snapshot).trigger();
        IProvingVault.Quote memory quote = vault.quote(instanceId, 0);
        assertTrue(quote.eligible, "the first valid checkpoint must be payable");
        assertTrue(
            quote.reason != uint8(IProvingVault.IneligibleReason.PolicyDisabled),
            "a prepaid instance must never start policy-disabled"
        );
    }

    function test_CreateGovernedInstanceRejectsPrepayWithoutPolicy() public {
        TrustgraphsFactory.CreateArgs memory args = _args("disabled-prepay");
        vm.deal(creator, 1 ether);

        vm.prank(creator);
        vm.expectRevert(GovernedTrustgraphsFactory.PrepayRequiresPolicy.selector);
        governedFactory.createGovernedInstance{value: 1 ether}(args, _unpaidPolicy());
        assertEq(registry.instanceCount(), 0, "invalid prepay must create nothing");
    }

    function test_CreateGovernedInstanceRejectsPolicyWithoutPrepay() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unfunded-policy");

        vm.prank(creator);
        vm.expectRevert(GovernedTrustgraphsFactory.PolicyRequiresPrepay.selector);
        governedFactory.createGovernedInstance(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8})
        );
        assertEq(registry.instanceCount(), 0, "unfunded policy must create nothing");
    }

    function test_CreateGovernedInstanceRequiresAPricedInitialBand() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unpriced-prepay");
        vm.deal(creator, 1 ether);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialFeeUnpriced.selector, factory.PROGRAM(), uint8(1))
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 25e8})
        );
    }

    function test_CreateGovernedInstanceBoundsInitialPaidTerms() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unsafe-policy");
        vault.setFeePerRootUsd(factory.PROGRAM(), 1, 5e8);
        vm.deal(creator, 2 ether);

        vm.startPrank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernedTrustgraphsFactory.InitialPaidIntervalTooShort.selector, EPOCH_FLOOR - 1, EPOCH_FLOOR
            )
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR - 1, maxPerRootUsd: 25e8})
        );

        uint96 maximum = governedFactory.MAX_INITIAL_MAX_PER_ROOT_USD();
        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialCapTooHigh.selector, maximum + 1, maximum)
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: maximum + 1})
        );

        vm.expectRevert(
            abi.encodeWithSelector(GovernedTrustgraphsFactory.InitialCapBelowFee.selector, uint96(4e8), uint256(5e8))
        );
        governedFactory.createGovernedInstance{value: 1 ether}(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: EPOCH_FLOOR, maxPerRootUsd: 4e8})
        );
        vm.stopPrank();
    }

    function test_DemoHandoffMakesSafeTheScoringAuthority() public {
        TrustgraphsFactory.CreateArgs memory args = _args("demo-handoff");
        args.admin = address(zodiacHarness);
        Created memory created = _create(args);

        GnosisSafe demoSafe = _safeOwnedBy(address(zodiacHarness));
        MerkleGovModule gov =
            new MerkleGovModule(address(zodiacHarness), address(demoSafe), address(demoSafe), created.snapshot);
        SignerSyncZkModule signer = new SignerSyncZkModule(
            address(zodiacHarness),
            address(demoSafe),
            address(demoSafe),
            IZkVerifier(address(verifier)),
            IAttestationAccumulator(created.resolver),
            MerkleSnapshot(created.snapshot).paramsHash(),
            bytes32(uint256(1))
        );

        address[] memory initialSigners = new address[](1);
        initialSigners[0] = address(zodiacHarness);
        DeployZodiacSafes.SafeDeployment memory deployment = DeployZodiacSafes.SafeDeployment({
            safe: address(demoSafe),
            merkleGovModule: address(gov),
            signerSyncModule: address(signer),
            initialSigners: initialSigners,
            threshold: 1,
            modulesEnabled: true,
            fundingAmount: 0
        });

        zodiacHarness.handoff(address(zodiacHarness), deployment, TrustgraphsParamsController(created.controller));

        assertEq(TrustgraphsParamsController(created.controller).owner(), address(demoSafe));
        assertEq(signer.paramsAuthority(), address(demoSafe));
        assertEq(gov.owner(), address(demoSafe));
        assertEq(signer.owner(), address(demoSafe));
    }

    function _safeOwnedBy(address owner) internal returns (GnosisSafe safe) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            1,
            address(0),
            bytes(""),
            address(0),
            address(0),
            0,
            address(0)
        );
        safe = GnosisSafe(payable(safeFactory.createProxyWithNonce(address(safeSingleton), initializer, 12345)));
    }
}
