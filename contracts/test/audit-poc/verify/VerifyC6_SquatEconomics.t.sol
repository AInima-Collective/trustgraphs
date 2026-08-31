// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract VerifyC6EconomicsSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("verify-c6-economics-signer");

    function verify(bytes calldata, bytes32) external pure {}
}

contract VerifyC6_SquatEconomics is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal gf;
    GnosisSafe internal singleton;
    GnosisSafeProxyFactory internal proxyFactory;

    address internal victim = address(0xA11CE);
    address internal squatter = address(0x5D0A7);

    function setUp() public override {
        super.setUp();
        singleton = new GnosisSafe();
        proxyFactory = new GnosisSafeProxyFactory();
        VerifyC6EconomicsSignerVerifier signerVerifier = new VerifyC6EconomicsSignerVerifier();
        gf = new GovernedTrustgraphsFactory(
            factory,
            proxyFactory,
            address(singleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            signerVerifier,
            signerVerifier.programVKey()
        );
    }

    function _init() internal view returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = address(gf);
        return abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            uint256(1),
            address(0),
            bytes(""),
            address(0),
            address(0),
            uint256(0),
            address(0)
        );
    }

    function _noSigner() internal pure returns (GovernedFactoryBase.SignerSyncConfig memory) {
        return GovernedFactoryBase.SignerSyncConfig(false, 0, 0, 0);
    }

    function test_SquatNoLongerWastesVictimGas() public {
        TrustgraphsFactory.CreateArgs memory args = _args("acme");
        args.salt = bytes32(uint256(7));
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, victim, args.name, args.salt)));

        uint256 g0 = gasleft();
        vm.prank(squatter);
        proxyFactory.createProxyWithNonce(address(singleton), _init(), nonce);
        uint256 squatGas = g0 - gasleft();

        uint256 g1 = gasleft();
        vm.prank(victim);
        (, address safe,,) = gf.createGovernedInstance(args, GovernedFactoryBase.InitialPolicy(0, 0), _noSigner());
        uint256 victimGas = g1 - gasleft();

        emit log_named_uint("attacker squat gas", squatGas);
        emit log_named_uint("victim wasted gas ", victimGas);
        assertTrue(GnosisSafe(payable(safe)).isOwner(victim), "front-run Safe must be adopted and graduated");

        // Same name, brand-new salt -> succeeds if the squatter does not front-run again.
        args.salt = bytes32(uint256(8));
        vm.prank(victim);
        (, address freshSafe,,) = gf.createGovernedInstance(args, GovernedFactoryBase.InitialPolicy(0, 0), _noSigner());
        assertTrue(freshSafe != address(0), "a fresh salt succeeds when not front-run");
    }
}
