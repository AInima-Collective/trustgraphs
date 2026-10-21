// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Governor, IGovernor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorCountingFractional} from "@openzeppelin/contracts/governance/extensions/GovernorCountingFractional.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {TrustPool} from "src/governance/TrustPool.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";

interface IFractionalGovernor is IGovernor {
    function proposalVotes(uint256 proposalId) external view returns (uint256, uint256, uint256);
    function usedVotes(uint256 proposalId, address account) external view returns (uint256);
}

/// @notice `MerkleSnapshot.getStateAtBlock` semantics (latest state at or before a block, the
///         last write in a block wins) without the proving pipeline.
contract MockStateHistory {
    IMerkleSnapshot.MerkleState[] internal states;

    function record(bytes32 root, uint256 totalValue) external {
        recordAt(block.number, root, totalValue);
    }

    /// @dev File a state at an earlier (input-freeze) block, as a late proof does.
    function recordAt(uint256 blockNumber, bytes32 root, uint256 totalValue) public {
        states.push(IMerkleSnapshot.MerkleState(blockNumber, block.timestamp, root, bytes32(0), "", totalValue));
    }

    function getStateAtBlock(uint256 blockNumber) external view returns (IMerkleSnapshot.MerkleState memory) {
        for (uint256 i = states.length; i > 0; i--) {
            if (states[i - 1].blockNumber <= blockNumber) return states[i - 1];
        }
        revert("no state at block");
    }
}

/// @notice The cases, run against an OZ harness (always) and the live Gitcoin governor (fork).
abstract contract TrustPoolCases is Test {
    uint256 internal constant POOL_VOTES = 900_000e18;
    uint256 internal constant TOTAL_SCORE = 1000;

    IFractionalGovernor internal governor;
    MockStateHistory internal snap;
    TrustPool internal pool;

    address internal kevin = makeAddr("kevin"); // delegates POOL_VOTES to the pool
    address internal alice = makeAddr("alice"); // score 600 in root1, 100 in root2
    address internal bob = makeAddr("bob"); // 300
    address internal carol = makeAddr("carol"); // 90
    address internal dave = makeAddr("dave"); // 10

    /// @dev Set `governor`, deploy `pool` against `snap`, and have kevin delegate POOL_VOTES to it.
    function _setUpGovernance() internal virtual;

    function _proposer() internal view virtual returns (address);

    function setUp() public virtual {
        snap = new MockStateHistory();
        _setUpGovernance();
        vm.roll(block.number + 1);
        snap.record(_root(600, 300, 90, 10), TOTAL_SCORE);
    }

    function test_sharesTallyPerVoter() public {
        uint256 pid = _propose("shares");

        uint256 wA = _vote(alice, pid, 1, 600, _proof(0, 600, 300, 90, 10));
        uint256 wB = _vote(bob, pid, 0, 300, _proof(1, 600, 300, 90, 10));
        uint256 wC = _vote(carol, pid, 2, 90, _proof(2, 600, 300, 90, 10));

        assertEq(wA, POOL_VOTES * 600 / TOTAL_SCORE);
        assertEq(wB, POOL_VOTES * 300 / TOTAL_SCORE);
        assertEq(wC, POOL_VOTES * 90 / TOTAL_SCORE);
        (uint256 against, uint256 forVotes, uint256 abstain) = governor.proposalVotes(pid);
        assertEq(forVotes, wA);
        assertEq(against, wB);
        assertEq(abstain, wC);
        assertEq(governor.usedVotes(pid, address(pool)), wA + wB + wC);
    }

    function test_governorCapsPoolAtSnapshotWeight() public {
        uint256 pid = _propose("cap");
        _vote(alice, pid, 1, 600, _proof(0, 600, 300, 90, 10));

        uint256 remaining = POOL_VOTES - governor.usedVotes(pid, address(pool));
        vm.prank(address(pool));
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernorCountingFractional.GovernorExceedRemainingWeight.selector,
                address(pool),
                remaining + 1,
                remaining
            )
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        governor.castVoteWithReasonAndParams(
            pid, 255, "", abi.encodePacked(uint128(0), uint128(remaining + 1), uint128(0))
        );
    }

    function test_snapshotRootGoverns_evenAfterNewerRootLands() public {
        uint256 pid = _propose("history");
        snap.record(_root(100, 300, 90, 10), TOTAL_SCORE);

        uint256 w = _vote(alice, pid, 1, 600, _proof(0, 600, 300, 90, 10));
        assertEq(w, POOL_VOTES * 600 / TOTAL_SCORE);
    }

    function test_lateProofCannotReshareAProposalMidVote() public {
        uint256 pid = _propose("late");
        _vote(alice, pid, 1, 600, _proof(0, 600, 300, 90, 10));

        // A checkpoint frozen at the snapshot block is proven after voting opened: the snapshot
        // now reads root2, but the proposal stays on the root its first vote met.
        snap.recordAt(governor.proposalSnapshot(pid), _root(100, 300, 90, 10), TOTAL_SCORE);
        uint256 w = _vote(bob, pid, 0, 300, _proof(1, 600, 300, 90, 10));

        assertEq(w, POOL_VOTES * 300 / TOTAL_SCORE);
        (bytes32 root, uint256 totalValue) = pool.proposalBasis(pid);
        assertEq(root, _root(600, 300, 90, 10));
        assertEq(totalValue, TOTAL_SCORE);
    }

    function test_votedCarriesReason() public {
        uint256 pid = _propose("reason");
        bytes32[] memory proof = _proof(3, 600, 300, 90, 10);
        vm.expectEmit(address(pool));
        emit TrustPool.Voted(pid, dave, 1, 10, POOL_VOTES * 10 / TOTAL_SCORE, "trusted");
        vm.prank(dave);
        pool.vote(pid, 1, 10, proof, "trusted");
    }

    function test_staleScoreInexpressible() public {
        snap.record(_root(100, 300, 90, 10), TOTAL_SCORE);
        uint256 pid = _propose("stale");

        bytes32[] memory oldProof = _proof(0, 600, 300, 90, 10);
        vm.prank(alice);
        vm.expectRevert(TrustPool.InvalidProof.selector);
        pool.vote(pid, 1, 600, oldProof, "");

        uint256 w = _vote(alice, pid, 1, 100, _proof(0, 100, 300, 90, 10));
        assertEq(w, POOL_VOTES * 100 / TOTAL_SCORE);
    }

    function test_cannotDoubleVote() public {
        uint256 pid = _propose("double");
        _vote(bob, pid, 1, 300, _proof(1, 600, 300, 90, 10));

        bytes32[] memory proof = _proof(1, 600, 300, 90, 10);
        vm.prank(bob);
        vm.expectRevert(TrustPool.AlreadyVoted.selector);
        pool.vote(pid, 0, 300, proof, "");
    }

    // --- helpers ---

    function _vote(address voter, uint256 pid, uint8 support, uint256 score, bytes32[] memory proof)
        internal
        returns (uint256)
    {
        vm.prank(voter);
        return pool.vote(pid, support, score, proof, "");
    }

    function _propose(string memory description) internal returns (uint256 pid) {
        address[] memory targets = new address[](1);
        targets[0] = address(0xbeef);
        vm.prank(_proposer());
        pid = governor.propose(targets, new uint256[](1), new bytes[](1), description);
        vm.roll(block.number + governor.votingDelay() + 1);
    }

    function _leaf(address a, uint256 s) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, s))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _leaves(uint256 sa, uint256 sb, uint256 sc, uint256 sd) internal view returns (bytes32[4] memory l) {
        (l[0], l[1], l[2], l[3]) = (_leaf(alice, sa), _leaf(bob, sb), _leaf(carol, sc), _leaf(dave, sd));
    }

    function _root(uint256 sa, uint256 sb, uint256 sc, uint256 sd) internal view returns (bytes32) {
        bytes32[4] memory l = _leaves(sa, sb, sc, sd);
        return _pair(_pair(l[0], l[1]), _pair(l[2], l[3]));
    }

    function _proof(uint256 i, uint256 sa, uint256 sb, uint256 sc, uint256 sd)
        internal
        view
        returns (bytes32[] memory proof)
    {
        bytes32[4] memory l = _leaves(sa, sb, sc, sd);
        proof = new bytes32[](2);
        proof[0] = l[i ^ 1];
        proof[1] = i < 2 ? _pair(l[2], l[3]) : _pair(l[0], l[1]);
    }
}

contract HarnessToken is ERC20Votes {
    constructor() ERC20("Harness", "HRN") EIP712("Harness", "1") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract HarnessGovernor is Governor, GovernorCountingFractional, GovernorVotes {
    constructor(IVotes token_) Governor("HarnessGovernor") GovernorVotes(token_) {}

    function votingDelay() public pure override returns (uint256) {
        return 10;
    }

    function votingPeriod() public pure override returns (uint256) {
        return 100;
    }

    function quorum(uint256) public pure override returns (uint256) {
        return 1_000e18;
    }
}

contract TrustPoolTest is TrustPoolCases {
    function _setUpGovernance() internal override {
        HarnessToken token = new HarnessToken();
        governor = IFractionalGovernor(address(new HarnessGovernor(token)));
        pool = new TrustPool(governor, MerkleSnapshot(address(snap)));
        token.mint(kevin, POOL_VOTES);
        vm.prank(kevin);
        token.delegate(address(pool));
    }

    function _proposer() internal pure override returns (address) {
        return address(0xCAFE);
    }
}

/// @notice The same cases on a mainnet fork against Gitcoin Governor Charlie and GTC, with kevin's
///         GTC delegated to the pool exactly as a holder (or a Franchiser position) would.
///         Set MAINNET_FORK_RPC_URL to run.
contract TrustPoolGitcoinForkTest is TrustPoolCases {
    address internal constant CHARLIE = 0xef41CbD211076E8b1901e214Bf751d404cf06638;
    address internal constant GTC = 0xDe30da39c46104798bB5aA3fe8B9e0e1F348163F;
    address internal constant TIMELOCK = 0x57a8865cfB1eCEf7253c27da6B4BC3dAEE5Be518;
    address internal proposer = makeAddr("proposer");

    function setUp() public override {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        super.setUp();
    }

    function _setUpGovernance() internal override {
        governor = IFractionalGovernor(CHARLIE);
        pool = new TrustPool(governor, MerkleSnapshot(address(snap)));
        vm.startPrank(TIMELOCK);
        assertTrue(IERC20(GTC).transfer(kevin, POOL_VOTES));
        assertTrue(IERC20(GTC).transfer(proposer, governor.proposalThreshold()));
        vm.stopPrank();
        vm.prank(kevin);
        IVotes(GTC).delegate(address(pool));
        vm.prank(proposer);
        IVotes(GTC).delegate(proposer);
    }

    function _proposer() internal view override returns (address) {
        return proposer;
    }
}
