// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PV_Verifier is IZkVerifier {
    function verify(bytes calldata, bytes32) external pure {}
}

contract PV_Usdc is ERC20 {
    constructor() ERC20("u", "u") {}
}

contract PV_Feed is IEthUsdFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(3_000e8), block.timestamp, block.timestamp, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

/// @notice A `CompositionSourceAccumulator`-shaped accumulator: `leafCount` is the CONSTANT source
///         count, while an explicit capture nonce models a changed frozen source manifest.
contract PV_ComposeAcc is IAttestationAccumulator {
    uint64 public constant SOURCES = 3;
    Checkpoint[] internal cps;
    address public snapshot;
    uint64 public captureNonce;

    function bind(address s) external {
        snapshot = s;
    }

    function advance() external {
        captureNonce++;
    }

    function acc() external view returns (bytes32) {
        return sha256(abi.encodePacked(captureNonce));
    }

    function leafCount() external pure returns (uint64) {
        return SOURCES;
    }

    function checkpoint() external returns (uint256 id) {
        require(msg.sender == snapshot, "not snapshot");
        id = cps.length;
        cps.push(
            Checkpoint({
                acc: sha256(abi.encodePacked(captureNonce)), leafCount: SOURCES, blockNumber: uint64(block.number)
            })
        );
        emit InputsCheckpointed(id, cps[id].acc, SOURCES, uint64(block.number));
    }

    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return cps[id];
    }

    function checkpointCount() external view returns (uint256) {
        return cps.length;
    }
}

contract OmegaPassB_ProvingVaultStatement is Test {
    bytes32 internal constant INSTANCE = keccak256("compose-instance");
    bytes32 internal constant PROGRAM = keccak256("trust-compose");

    InstanceRegistry internal registry;
    ProvingVault internal vault;
    MerkleSnapshot internal snap;
    PV_ComposeAcc internal acc;
    PV_Usdc internal usdc;

    address internal admin = address(this); // constitutional + operational + fee setter
    address internal proverA = address(0xA1);
    address internal proverB = address(0xB2);

    function setUp() public {
        vm.deal(address(this), 100 ether);
        registry = new InstanceRegistry(admin);
        usdc = new PV_Usdc();
        vault = new ProvingVault(
            IInstanceRegistry(address(registry)),
            IERC20(address(usdc)),
            IEthUsdFeed(address(new PV_Feed())),
            1 days,
            100e8,
            100_000e8,
            admin,
            admin
        );

        acc = new PV_ComposeAcc();
        snap = new MerkleSnapshot(
            IZkVerifier(address(new PV_Verifier())),
            keccak256("compose-params"),
            IAttestationAccumulator(address(acc)),
            admin,
            admin
        );
        acc.bind(address(snap));

        registry.register(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snap),
                verifier: address(0xdead),
                registryOrAccumulator: address(acc),
                paramsHash: keccak256("compose-params")
            })
        );

        vault.setFeePerRootUsd(PROGRAM, 3, 25e8); // $25 per root, band 3 (flat-banded program)
        vault.depositETH{value: 10 ether}(INSTANCE);
        vault.setPolicy(INSTANCE, 0, 100e8); // no cadence, $100 cap
    }

    receive() external payable {}

    function _args(uint256 cp, bytes32 root, address recipient)
        internal
        pure
        returns (IProvingVault.SubmitArgs memory a)
    {
        a.checkpointId = cp;
        a.outputRoot = root;
        a.ipfsHash = bytes32(uint256(1));
        a.ipfsHashCid = "cid";
        a.totalValue = 1_000;
        a.skippedDigest = bytes32(0);
        a.recipient = recipient;
        a.proof = "";
        a.minPayoutUsd = 0;
    }

    /// FINDING: for any instance whose accumulator reports a CONSTANT `leafCount`
    /// (`CompositionSourceAccumulator.leafCount() == _policy.length`), two consecutive checkpoints
    /// over unchanged sources produce the identical composed `outputRoot`. `_terms` then derives
    /// the SAME `statement`, and `_requireUnpaidStatement` REVERTS inside `_settle` — which is
    /// called AFTER `snapshot.submitProof(...)`, so the whole transaction (including the root
    /// acceptance) is rolled back. The root cannot be landed through the vault at all.
    function test_DuplicateStatementRevertsAndRollsBackTheRoot() public {
        acc.advance();
        uint256 cp0 = snap.trigger();
        bytes32 root = keccak256("composed-allocation");
        vm.prank(proverA);
        vault.submitAndClaim(INSTANCE, _args(cp0, root, proverA));
        assertGt(vault.creditOf(proverA, address(0)), 0, "first root paid");

        // The captured source manifest moved, so `trigger()` mints checkpoint 1 — but the
        // composed allocation is byte-identical.
        acc.advance();
        uint256 cp1 = snap.trigger();
        assertEq(cp1, 1);

        vm.prank(proverB);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, _statement(root)));
        vault.submitAndClaim(INSTANCE, _args(cp1, root, proverB));

        // The revert took the ROOT with it: checkpoint 1 was never applied.
        assertEq(snap.lastAppliedCheckpoint(), cp0, "checkpoint 1 could not land through the vault");
    }

    function _statement(bytes32 root) internal view returns (bytes32) {
        return keccak256(abi.encode(address(snap), uint64(3), uint64(0), root));
    }

    /// FINDING: `claim(instanceId, checkpointId)` builds the anti-double-pay `statement` from
    /// `snapshot.getLatestState().root` — the root of the NEWEST accepted checkpoint, not the root
    /// the named checkpoint produced. Claiming an older, still-unpaid checkpoint therefore burns
    /// the statement slot belonging to the newest checkpoint, and the newest checkpoint's own
    /// prover can never be paid.
    function test_ClaimOfOldCheckpointBurnsTheNewestCheckpointsBounty() public {
        acc.advance();
        uint256 cp0 = snap.trigger();
        bytes32 r0 = keccak256("root-0");
        snap.submitProof(cp0, r0, bytes32(uint256(1)), "cid", 1_000, bytes32(0), proverA, "");

        acc.advance();
        uint256 cp1 = snap.trigger();
        bytes32 r1 = keccak256("root-1");
        snap.submitProof(cp1, r1, bytes32(uint256(2)), "cid", 1_000, bytes32(0), proverB, "");

        // Anyone may pay the gas for the OLD checkpoint first.
        vault.claim(INSTANCE, cp0);
        assertGt(vault.creditOf(proverA, address(0)), 0, "old checkpoint paid");

        // …and its statement was computed from r1, so the newer checkpoint is now unpayable.
        assertEq(_statement(r1), _statement(r1));
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, _statement(r1)));
        vault.claim(INSTANCE, cp1);
        assertEq(vault.creditOf(proverB, address(0)), 0, "newest prover permanently unpaid");
    }
}
