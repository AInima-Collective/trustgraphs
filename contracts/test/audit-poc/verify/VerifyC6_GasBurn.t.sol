// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract VerifyC6GasSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("verify-c6-gas-signer");

    function verify(bytes calldata, bytes32) external pure {}
}

contract VerifyC6_GasBurn is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal gf;
    GnosisSafe internal singleton;
    GnosisSafeProxyFactory internal proxyFactory;

    address internal victim = address(0xA11CE);
    address internal squatter = address(0x5D0A7);

    function setUp() public override {
        super.setUp();
        singleton = new GnosisSafe();
        proxyFactory = new GnosisSafeProxyFactory();
        VerifyC6GasSignerVerifier signerVerifier = new VerifyC6GasSignerVerifier();
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

    function _noSigner() internal pure returns (GovernedTrustgraphsFactory.SignerSyncConfig memory) {
        return GovernedTrustgraphsFactory.SignerSyncConfig(false, 0, 0, 0);
    }

    function test_HonestCostThenFrontRunAdoption() public {
        TrustgraphsFactory.CreateArgs memory args = _args("acme");
        args.salt = bytes32(uint256(7));

        // 1. What an honest governed creation costs (so we know the gas limit a real user sends).
        uint256 snap = vm.snapshotState();
        uint256 g = gasleft();
        vm.prank(victim);
        gf.createGovernedInstance(args, GovernedTrustgraphsFactory.InitialPolicy(0, 0), _noSigner());
        uint256 honest = g - gasleft();
        emit log_named_uint("honest createGovernedInstance gas", honest);
        vm.revertToState(snap);

        // 2. The squat.
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, victim, args.name, args.salt)));
        uint256 g2 = gasleft();
        vm.prank(squatter);
        proxyFactory.createProxyWithNonce(address(singleton), _init(), nonce);
        uint256 squat = g2 - gasleft();
        emit log_named_uint("attacker squat gas", squat);

        // 3. The victim resubmits with a realistic gas limit (honest cost + 20% headroom) and
        //    confirms the CREATE2 collision is handled without a gas-burning revert.
        uint256 limit = (honest * 120) / 100;
        bytes memory data = abi.encodeCall(
            GovernedTrustgraphsFactory.createGovernedInstance,
            (args, GovernedTrustgraphsFactory.InitialPolicy(0, 0), _noSigner())
        );
        uint256 g3 = gasleft();
        vm.prank(victim);
        (bool ok,) = address(gf).call{gas: limit}(data);
        uint256 used = g3 - gasleft();
        assertTrue(ok, "victim must adopt the exact bootstrap Safe");
        emit log_named_uint("victim gas limit    ", limit);
        emit log_named_uint("victim gas used     ", used);
    }
}
