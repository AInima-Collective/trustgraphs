// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Vm} from "forge-std/Vm.sol";

import {GovernedTrustGraphFactory} from "contracts/factory/GovernedTrustGraphFactory.sol";
import {TrustGraphFactory} from "contracts/factory/TrustGraphFactory.sol";
import {TrustGraphParamsController} from "contracts/factory/TrustGraphParamsController.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleGovModule} from "contracts/zodiac/MerkleGovModule.sol";
import {SignerSyncZkModule} from "contracts/zodiac/SignerSyncZkModule.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {DeployZodiacSafes} from "script/DeployZodiacSafes.s.sol";
import {TrustGraphFactoryBase} from "test/unit/factory/TrustGraphFactoryBase.sol";

contract DeployZodiacSafesHarness is DeployZodiacSafes {
    function handoff(address deployer, SafeDeployment memory deployment, TrustGraphParamsController controller)
        external
    {
        _handoffScoringAuthority(deployer, deployment, controller);
    }
}

contract GovernedTrustGraphFactoryTest is TrustGraphFactoryBase {
    GovernedTrustGraphFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    DeployZodiacSafesHarness internal zodiacHarness;

    address internal creator = address(0xA11CE);

    function setUp() public override {
        super.setUp();
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        governedFactory = new GovernedTrustGraphFactory(factory, safeFactory, address(safeSingleton));
        zodiacHarness = new DeployZodiacSafesHarness();
    }

    function test_CreateGovernedInstanceMakesSafeTheAuthorityFromGenesis() public {
        TrustGraphFactory.CreateArgs memory args = _args("member-owned");
        args.admin = address(0xBAD); // ignored: governed creation is never EOA-administered
        args.withDistributor = true;
        args.salt = bytes32(uint256(7));

        vm.recordLogs();
        vm.prank(creator);
        (bytes32 instanceId, address safe, address module, address snapshot) =
            governedFactory.createGovernedInstance(args);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        CreatedEvent memory created = _decodeCreated(logs);
        address controller = _decodeController(logs, instanceId);

        assertEq(created.creator, safe, "the Safe must be the canonical factory caller");
        assertEq(created.admin, safe, "the Safe must hold every instance authority");
        assertEq(factory.computeInstanceId(safe, args.name, args.salt), instanceId, "instance id creator mismatch");
        assertEq(created.snapshot, snapshot, "wrapper discovered the wrong snapshot");

        assertEq(TrustGraphParamsController(controller).owner(), safe, "Safe must own scoring controller");
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

    function test_CreateGovernedInstanceForwardsPrepayThroughSafe() public {
        TrustGraphFactory.CreateArgs memory args = _args("member-funded");
        vm.deal(creator, 3 ether);

        vm.prank(creator);
        (bytes32 instanceId, address safe,,) = governedFactory.createGovernedInstance{value: 3 ether}(args);

        IProvingVault.Account memory account = vault.accountOf(instanceId);
        assertEq(account.ethBalance, 3 ether, "the instance tank must receive the full prepay");
        assertEq(address(vault).balance, 3 ether, "the governed wrapper must retain nothing");
        assertEq(safe.balance, 0, "the bootstrap Safe must retain nothing");
        assertEq(address(governedFactory).balance, 0, "the wrapper must retain nothing");
    }

    function test_DemoHandoffMakesSafeTheScoringAuthority() public {
        TrustGraphFactory.CreateArgs memory args = _args("demo-handoff");
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

        zodiacHarness.handoff(address(zodiacHarness), deployment, TrustGraphParamsController(created.controller));

        assertEq(TrustGraphParamsController(created.controller).owner(), address(demoSafe));
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
