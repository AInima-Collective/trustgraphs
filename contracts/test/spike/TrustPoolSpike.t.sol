// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Governor, IGovernor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorCountingFractional} from "@openzeppelin/contracts/governance/extensions/GovernorCountingFractional.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// Spike: can a pooled "TrustPool" contract cast per-delegate fractional votes on an
/// OZ-5.4 GovernorCountingFractional governor (the module Gitcoin's governor uses),
/// with each delegate's weight derived at VOTE TIME from a merkle proof against the
/// root that was current at the proposal SNAPSHOT (MerkleSnapshot-style history)?
///
/// Answers under test:
///  A1. rolling partial casts from one voter (the pool) accumulate across delegates
///  A2. the governor itself caps total casts at the pool's snapshot weight
///  A3. proofs verify against the historical root at the snapshot, not the latest root
///  A4. stale scores are inexpressible (old-root proofs fail once a newer root governs)
///  A5. per-delegate double-voting is blocked pool-side
///  A6. gas per delegate vote

// ---------------------------------------------------------------------------
// Harness contracts
// ---------------------------------------------------------------------------

contract SpikeToken is ERC20Votes {
    constructor() ERC20("Spike", "SPK") EIP712("Spike", "1") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SpikeGovernor is Governor, GovernorCountingFractional, GovernorVotes {
    constructor(IVotes _token) Governor("SpikeGovernor") GovernorVotes(_token) {}

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

/// Mimics MerkleSnapshot's state history: (blockNumber, root, totalValue),
/// looked up at-or-before a given block, exactly like getStateAtBlock.
contract MockSnapshotHistory {
    struct State {
        uint256 blockNumber;
        bytes32 root;
        uint256 totalValue;
    }

    State[] public states;

    function record(bytes32 root, uint256 totalValue) external {
        states.push(State(block.number, root, totalValue));
    }

    function stateAtBlock(uint256 blockNumber) external view returns (bytes32 root, uint256 totalValue) {
        for (uint256 i = states.length; i > 0; i--) {
            if (states[i - 1].blockNumber <= blockNumber) {
                return (states[i - 1].root, states[i - 1].totalValue);
            }
        }
        revert("no state at block");
    }
}

/// The PoC manager: holds pool GTC-analog, self-delegates, and casts fractional
/// votes per delegate, with weight derived from a snapshot-root merkle proof.
contract TrustPool {
    error AlreadyVoted();
    error InvalidProof();
    error BadSupport();

    SpikeToken public immutable token;
    SpikeGovernor public immutable governor;
    MockSnapshotHistory public immutable snapshot;
    uint256 public immutable poolCap;

    mapping(uint256 => mapping(address => bool)) public delegateVoted;

    constructor(SpikeToken _token, SpikeGovernor _governor, MockSnapshotHistory _snapshot, uint256 _poolCap) {
        token = _token;
        governor = _governor;
        snapshot = _snapshot;
        poolCap = _poolCap;
        _token.delegate(address(this));
    }

    /// @notice Delegate votes with weight poolCap * score / totalScore, where score is
    ///         proven against the root that was current at the proposal's snapshot.
    function vote(
        uint256 proposalId,
        uint256 score,
        uint8 support, // 0 = Against, 1 = For, 2 = Abstain (Bravo order)
        bytes32[] calldata proof
    )
        external
        returns (uint256 weight)
    {
        if (delegateVoted[proposalId][msg.sender]) revert AlreadyVoted();
        delegateVoted[proposalId][msg.sender] = true;

        uint256 snapshotBlock = governor.proposalSnapshot(proposalId);
        (bytes32 root, uint256 totalScore) = snapshot.stateAtBlock(snapshotBlock);

        // Same double-hashed leaf encoding as MerkleSnapshot._verifyProof
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, score))));
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) {
            revert InvalidProof();
        }

        weight = (poolCap * score) / totalScore;
        governor.castVoteWithReasonAndParams(
            proposalId,
            255, // VOTE_TYPE_FRACTIONAL
            "",
            _fractionalParams(support, weight)
        );
    }

    /// Test-only escape hatch: attempt an arbitrary fractional cast, to show the
    /// GOVERNOR (not the pool) enforces the snapshot-weight ceiling.
    function debugCast(uint256 proposalId, uint256 forWeight) external {
        governor.castVoteWithReasonAndParams(proposalId, 255, "", _fractionalParams(1, forWeight));
    }

    function _fractionalParams(uint8 support, uint256 weight) internal pure returns (bytes memory) {
        uint128 w = uint128(weight);
        if (support == 0) return abi.encodePacked(w, uint128(0), uint128(0));
        if (support == 1) return abi.encodePacked(uint128(0), w, uint128(0));
        if (support == 2) return abi.encodePacked(uint128(0), uint128(0), w);
        revert BadSupport();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

contract TrustPoolSpikeTest is Test {
    SpikeToken internal token;
    SpikeGovernor internal governor;
    MockSnapshotHistory internal snap;
    TrustPool internal pool;

    address internal alice = makeAddr("alice"); // score 600 in root1, 100 in root2
    address internal bob = makeAddr("bob"); // score 300
    address internal carol = makeAddr("carol"); // score 90
    address internal dave = makeAddr("dave"); // score 10

    uint256 internal constant POOL_CAP = 900_000e18;
    uint256 internal constant TOTAL_SCORE = 1000;

    bytes32 internal root1;
    bytes32 internal root2;

    function setUp() public {
        token = new SpikeToken();
        governor = new SpikeGovernor(token);
        snap = new MockSnapshotHistory();

        // The pool self-delegates in its constructor; later mints are checkpointed
        // to that delegate by ERC20Votes.
        pool = new TrustPool(token, governor, snap, POOL_CAP);
        token.mint(address(pool), 1_000_000e18);

        root1 = _buildRoot(600, 300, 90, 10);
        root2 = _buildRoot(100, 300, 90, 10); // alice's score collapsed

        vm.roll(block.number + 1); // let the pool's delegation checkpoint settle
        snap.record(root1, TOTAL_SCORE);
    }

    // --- merkle helpers: 4-leaf tree, OZ commutative pair hashing ---

    function _leaf(address a, uint256 s) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, s))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _leaves(uint256 sa, uint256 sb, uint256 sc, uint256 sd) internal view returns (bytes32[4] memory l) {
        l[0] = _leaf(alice, sa);
        l[1] = _leaf(bob, sb);
        l[2] = _leaf(carol, sc);
        l[3] = _leaf(dave, sd);
    }

    function _buildRoot(uint256 sa, uint256 sb, uint256 sc, uint256 sd) internal view returns (bytes32) {
        bytes32[4] memory l = _leaves(sa, sb, sc, sd);
        return _pair(_pair(l[0], l[1]), _pair(l[2], l[3]));
    }

    /// proof for leaf index i in the 4-leaf tree
    function _proofFor(uint256 i, uint256 sa, uint256 sb, uint256 sc, uint256 sd)
        internal
        view
        returns (bytes32[] memory proof)
    {
        bytes32[4] memory l = _leaves(sa, sb, sc, sd);
        proof = new bytes32[](2);
        if (i == 0) (proof[0], proof[1]) = (l[1], _pair(l[2], l[3]));
        if (i == 1) (proof[0], proof[1]) = (l[0], _pair(l[2], l[3]));
        if (i == 2) (proof[0], proof[1]) = (l[3], _pair(l[0], l[1]));
        if (i == 3) (proof[0], proof[1]) = (l[2], _pair(l[0], l[1]));
    }

    function _propose(string memory desc) internal returns (uint256 proposalId) {
        address[] memory targets = new address[](1);
        targets[0] = address(0xbeef);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = "";
        proposalId = governor.propose(targets, values, calldatas, desc);
        vm.roll(block.number + governor.votingDelay() + 1); // into Active
    }

    // --- A1: rolling partial casts across delegates accumulate correctly ---

    function test_rollingFractionalCasts_tallyPerDelegate() public {
        uint256 pid = _propose("p1");

        vm.prank(alice);
        uint256 wA = pool.vote(pid, 600, 1, _proofFor(0, 600, 300, 90, 10));

        vm.prank(bob);
        uint256 wB = pool.vote(pid, 300, 0, _proofFor(1, 600, 300, 90, 10));

        vm.prank(carol);
        uint256 wC = pool.vote(pid, 90, 2, _proofFor(2, 600, 300, 90, 10));

        assertEq(wA, (POOL_CAP * 600) / TOTAL_SCORE);
        assertEq(wB, (POOL_CAP * 300) / TOTAL_SCORE);
        assertEq(wC, (POOL_CAP * 90) / TOTAL_SCORE);

        (uint256 against, uint256 forVotes, uint256 abstain) = governor.proposalVotes(pid);
        assertEq(forVotes, wA);
        assertEq(against, wB);
        assertEq(abstain, wC);
        assertEq(governor.usedVotes(pid, address(pool)), wA + wB + wC);
    }

    // --- A2: the governor enforces the pool's snapshot-weight ceiling ---

    function test_governorCapsPoolAtSnapshotWeight() public {
        uint256 pid = _propose("p2");

        vm.prank(alice);
        pool.vote(pid, 600, 1, _proofFor(0, 600, 300, 90, 10));

        // Pool's checkpointed weight is 1_000_000e18; try to cast beyond the remainder.
        uint256 remaining = 1_000_000e18 - governor.usedVotes(pid, address(pool));
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernorCountingFractional.GovernorExceedRemainingWeight.selector,
                address(pool),
                remaining + 1,
                remaining
            )
        );
        pool.debugCast(pid, remaining + 1);

        // ...but exactly the remainder is fine: the ceiling is the token checkpoint.
        pool.debugCast(pid, remaining);
    }

    // --- A3: proofs verify against the root AT THE SNAPSHOT, not the latest root ---

    function test_snapshotRootGoverns_evenAfterNewerRootLands() public {
        uint256 pid = _propose("p3");
        // A newer root lands AFTER the proposal snapshot...
        snap.record(root2, TOTAL_SCORE);

        // ...but carol still votes with her root1 proof, because root1 was
        // current at the snapshot block. History lookup, exactly like
        // MerkleSnapshot.getStateAtBlock.
        vm.prank(carol);
        uint256 w = pool.vote(pid, 90, 1, _proofFor(2, 600, 300, 90, 10));
        assertEq(w, (POOL_CAP * 90) / TOTAL_SCORE);
    }

    // --- A4: stale scores are inexpressible once a newer root governs the snapshot ---

    function test_staleScoreInexpressible() public {
        snap.record(root2, TOTAL_SCORE); // alice is now 100, BEFORE the proposal
        uint256 pid = _propose("p4");

        // Old (higher) score + old proof: rejected, that root no longer governs.
        vm.prank(alice);
        vm.expectRevert(TrustPool.InvalidProof.selector);
        pool.vote(pid, 600, 1, _proofFor(0, 600, 300, 90, 10));

        // Current score verifies, and the weight is arithmetically smaller.
        vm.prank(alice);
        uint256 w = pool.vote(pid, 100, 1, _proofFor(0, 100, 300, 90, 10));
        assertEq(w, (POOL_CAP * 100) / TOTAL_SCORE);
    }

    // --- A5: per-delegate double vote blocked pool-side ---

    function test_delegateCannotDoubleVote() public {
        uint256 pid = _propose("p5");

        vm.prank(bob);
        pool.vote(pid, 300, 1, _proofFor(1, 600, 300, 90, 10));

        vm.prank(bob);
        vm.expectRevert(TrustPool.AlreadyVoted.selector);
        pool.vote(pid, 300, 1, _proofFor(1, 600, 300, 90, 10));
    }

    // --- A6: gas per delegate vote through the pool ---

    function test_gasPerDelegateVote() public {
        uint256 pid = _propose("p6");
        bytes32[] memory proof = _proofFor(0, 600, 300, 90, 10);

        vm.prank(alice);
        uint256 g0 = gasleft();
        pool.vote(pid, 600, 1, proof);
        uint256 used = g0 - gasleft();
        emit log_named_uint("gas: first pool vote on proposal", used);

        proof = _proofFor(1, 600, 300, 90, 10);
        vm.prank(bob);
        g0 = gasleft();
        pool.vote(pid, 300, 0, proof);
        used = g0 - gasleft();
        emit log_named_uint("gas: subsequent pool vote", used);

        assertLt(used, 200_000);
    }
}
