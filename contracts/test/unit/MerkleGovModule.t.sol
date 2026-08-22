// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

// Safe contracts
import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

// Zodiac
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";

// Our contracts
import {MerkleGovModule} from "../../src/zodiac/MerkleGovModule.sol";
import {MerkleTreeHelper} from "../merkle-governance/MerkleTreeHelper.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";

contract MerkleGovModuleTest is Test {
    // Core contracts
    GnosisSafe public safeSingleton;
    GnosisSafeProxyFactory public safeFactory;
    GnosisSafe public safe;
    MerkleGovModule public govModule;
    MerkleTreeHelper public merkleHelper;
    MockMerkleSnapshot public merkleSnapshot;

    // Test accounts
    address public owner = address(0x1111111111111111111111111111111111111111);
    address public alice = address(0x2222222222222222222222222222222222222222);
    address public bob = address(0x3333333333333333333333333333333333333333);
    address public charlie = address(0x4444444444444444444444444444444444444444);
    address public dave = address(0x5555555555555555555555555555555555555555);
    address public eve = address(0x6666666666666666666666666666666666666666);

    // Merkle tree data
    bytes32 public merkleRoot;
    MerkleTreeHelper.AccountData[] public accounts;
    mapping(address => bytes32[]) public proofs;
    mapping(address => uint256) public votingPowers;
    uint256 public initialTotalVotingPower;
    bytes32 public initialIpfsHash;
    string public initialIpfsHashCid;

    // Events
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        string title,
        string description,
        uint256 startBlock,
        uint256 endBlock,
        bytes32 merkleRoot,
        uint256 totalVotingPower
    );
    event VoteCast(
        address indexed voter, uint256 indexed proposalId, MerkleGovModule.VoteType voteType, uint256 votingPower
    );
    event VoteDelegateSet(address indexed principal, address indexed previousDelegate, address indexed newDelegate);
    event DelegateVoteCast(
        address indexed principal,
        uint256 indexed proposalId,
        address indexed delegate,
        MerkleGovModule.VoteType voteType,
        uint256 votingPower,
        string reason
    );
    event VoteOverridden(
        address indexed principal,
        uint256 indexed proposalId,
        address indexed delegate,
        MerkleGovModule.VoteType previousVoteType,
        MerkleGovModule.VoteType newVoteType,
        uint256 votingPower
    );
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);

    function setUp() public {
        // Deploy Safe infrastructure
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();

        // Setup initial signers for Safe
        address[] memory signers = new address[](3);
        signers[0] = owner;
        signers[1] = alice;
        signers[2] = bob;

        // Deploy Safe proxy
        bytes memory setupData = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            signers,
            2, // threshold
            address(0), // to
            "", // data
            address(0), // fallback handler
            address(0), // payment token
            0, // payment
            address(0) // payment receiver
        );

        address safeProxy = address(
            safeFactory.createProxyWithNonce(
                address(safeSingleton),
                setupData,
                uint256(keccak256(abi.encodePacked("merkle-gov-test", block.timestamp)))
            )
        );

        safe = GnosisSafe(payable(safeProxy));

        // Deploy merkle helper
        merkleHelper = new MerkleTreeHelper();

        // Setup merkle tree (build root/proofs before deploying gov module)
        _setupMerkleTree();

        // Deploy mock MerkleSnapshot with an initial latest state
        initialIpfsHash = bytes32(uint256(0x1234));
        initialIpfsHashCid = "ipfs://test";
        merkleSnapshot = new MockMerkleSnapshot(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: merkleRoot,
                ipfsHash: initialIpfsHash,
                ipfsHashCid: initialIpfsHashCid,
                totalValue: initialTotalVotingPower
            })
        );

        // Deploy governance module pointing at the snapshot (constructor should pull getLatestState())
        govModule = new MerkleGovModule(owner, address(safe), address(safe), address(merkleSnapshot));

        // Enable module on Safe (in practice, this would require multi-sig)
        vm.prank(address(safe));
        safe.enableModule(address(govModule));

        // Fund the safe for test transactions
        vm.deal(address(safe), 100 ether);
    }

    function _setupMerkleTree() internal {
        // Create voting power distribution
        accounts.push(MerkleTreeHelper.AccountData({account: alice, votingPower: 100e18}));
        accounts.push(MerkleTreeHelper.AccountData({account: bob, votingPower: 200e18}));
        accounts.push(MerkleTreeHelper.AccountData({account: charlie, votingPower: 150e18}));
        accounts.push(MerkleTreeHelper.AccountData({account: dave, votingPower: 50e18}));
        accounts.push(MerkleTreeHelper.AccountData({account: eve, votingPower: 75e18}));

        // Build merkle tree
        (merkleRoot,) = merkleHelper.buildMerkleTree(accounts);

        // Generate and store proofs for each account
        for (uint256 i = 0; i < accounts.length; i++) {
            proofs[accounts[i].account] = merkleHelper.generateProof(accounts, i);
            votingPowers[accounts[i].account] = accounts[i].votingPower;
        }

        // Calculate total voting power (100 + 200 + 150 + 50 + 75 = 575)
        initialTotalVotingPower = 575e18;
    }

    function _updateMerkleRoot(bytes32 root, bytes32 ipfsHash, uint256 totalValue) internal {
        // Update snapshot state and execute hook
        merkleSnapshot.setLatestState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: ipfsHash,
                ipfsHashCid: "ipfs://test",
                totalValue: totalValue
            })
        );
        vm.expectEmit(true, false, false, true);
        emit IMerkleSnapshot.MerkleRootUpdated(root, ipfsHash, "ipfs://test", totalValue);
        merkleSnapshot.pushUpdate(address(govModule));
    }

    function test_ModuleSetup() public view {
        assertEq(govModule.avatar(), address(safe));
        assertEq(govModule.target(), address(safe));
        assertEq(govModule.owner(), owner);
        assertEq(govModule.merkleSnapshotContract(), address(merkleSnapshot));
        assertEq(govModule.currentMerkleRoot(), merkleRoot);
        assertEq(govModule.ipfsHash(), initialIpfsHash);
        assertEq(govModule.ipfsHashCid(), initialIpfsHashCid);
        assertEq(govModule.totalVotingPower(), initialTotalVotingPower);
        assertEq(govModule.votingDelay(), 1);
        assertEq(govModule.votingPeriod(), 50400);
        assertEq(govModule.quorum(), 4e16);
    }

    function test_ProposalCreation() public {
        // Create proposal data
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 1 ether;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        // Create proposal
        vm.expectEmit(true, true, false, true);
        emit ProposalCreated(
            1,
            alice,
            "Send 1 ETH",
            "Proposal to send 1 ETH",
            block.number + 1,
            block.number + 1 + 50400,
            merkleRoot,
            575e18
        );

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Send 1 ETH",
            "Proposal to send 1 ETH",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        assertEq(proposalId, 1);
        assertEq(govModule.proposalCount(), 1);
        assertEq(uint256(govModule.state(proposalId)), uint256(MerkleGovModule.ProposalState.Pending));

        // Check proposal details
        (
            uint256 id,
            address proposer,,,
            uint256 startBlock,
            uint256 endBlock,
            uint256 yesVotes,
            uint256 noVotes,
            uint256 abstainVotes,
            bool executed,
            bool cancelled,,
            uint256 totalVotingPower,
        ) = govModule.proposals(proposalId);

        assertEq(id, proposalId);
        assertEq(proposer, alice);
        assertEq(startBlock, block.number + 1);
        assertEq(endBlock, block.number + 1 + 50400);
        assertEq(yesVotes, 0);
        assertEq(noVotes, 0);
        assertEq(abstainVotes, 0);
        assertFalse(executed);
        assertFalse(cancelled);
        assertEq(totalVotingPower, 575e18);
    }

    function test_VotingFlow() public {
        // Create proposal
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 1 ether;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Send 1 ETH",
            "Proposal to send 1 ETH",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Move to voting period
        vm.roll(block.number + 2);
        assertEq(uint256(govModule.state(proposalId)), uint256(MerkleGovModule.ProposalState.Active));

        // Alice votes For
        vm.expectEmit(true, true, false, true);
        emit VoteCast(alice, proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice]);

        vm.prank(alice);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);

        // Bob votes Against
        vm.expectEmit(true, true, false, true);
        emit VoteCast(bob, proposalId, MerkleGovModule.VoteType.No, votingPowers[bob]);

        vm.prank(bob);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.No, votingPowers[bob], proofs[bob]);

        // Charlie abstains
        vm.expectEmit(true, true, false, true);
        emit VoteCast(charlie, proposalId, MerkleGovModule.VoteType.Abstain, votingPowers[charlie]);

        vm.prank(charlie);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Abstain, votingPowers[charlie], proofs[charlie]);

        // Check vote tallies
        (,,,,,, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes,,,,,) = govModule.proposals(proposalId);
        assertEq(yesVotes, votingPowers[alice]);
        assertEq(noVotes, votingPowers[bob]);
        assertEq(abstainVotes, votingPowers[charlie]);

        // Check voting status
        assertTrue(govModule.hasVoted(proposalId, alice));
        assertTrue(govModule.hasVoted(proposalId, bob));
        assertTrue(govModule.hasVoted(proposalId, charlie));
        assertFalse(govModule.hasVoted(proposalId, dave));
    }

    function test_CannotVoteTwice() public {
        // Create proposal
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 0;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Test proposal",
            "Test proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Move to voting period
        vm.roll(block.number + 2);

        // First vote succeeds
        vm.prank(alice);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);

        // Second vote fails
        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.AlreadyVoted.selector);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);
    }

    function test_ProposalExecution() public {
        // Create a test contract to call
        TestTarget testTarget = new TestTarget();

        // Create proposal
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(testTarget);
        values[0] = 0;
        calldatas[0] = abi.encodeWithSignature("setValue(uint256)", 42);
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Set value to 42",
            "Set the test target value to 42",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Move to voting period
        vm.roll(block.number + 2);

        // Get enough votes to pass (need >= 4% quorum and more for than against)
        // Total voting power = 575e18, so need >= 23e18 total votes (4% of 575e18 = 23e18)
        vm.prank(alice);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]); // 100e18

        vm.prank(bob);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob]); // 200e18

        // Move past voting period
        vm.roll(block.number + 50401);

        // Check proposal succeeded
        assertEq(uint256(govModule.state(proposalId)), uint256(MerkleGovModule.ProposalState.Passed));

        // M-4: execution only opens after the execution delay past the voting end.
        vm.roll(block.number + govModule.executionDelay() + 1);

        // Execute proposal
        vm.expectEmit(true, false, false, true);
        emit ProposalExecuted(proposalId);

        govModule.execute(proposalId);

        // Verify execution
        assertEq(testTarget.value(), 42);
        assertEq(uint256(govModule.state(proposalId)), uint256(MerkleGovModule.ProposalState.Executed));
    }

    function test_ProposalCancellation() public {
        // Create proposal
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 0;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Test proposal",
            "Test proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Owner can cancel
        vm.expectEmit(true, false, false, true);
        emit ProposalCancelled(proposalId);

        vm.prank(owner);
        govModule.cancel(proposalId);

        // Proposer cannot cancel (only owner or avatar)
        vm.prank(alice);
        uint256 proposalId2 = govModule.propose(
            "Test proposal 2",
            "Test proposal 2 description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.NotAuthorized.selector);
        govModule.cancel(proposalId2);

        assertEq(uint256(govModule.state(proposalId)), uint256(MerkleGovModule.ProposalState.Cancelled));
    }

    function test_OnlyOwnerCanUpdateParameters() public {
        // Non-owner cannot update parameters
        vm.prank(alice);
        vm.expectRevert();
        govModule.setQuorum(5e16);

        vm.prank(alice);
        vm.expectRevert();
        govModule.setVotingDelay(10);

        vm.prank(alice);
        vm.expectRevert();
        govModule.setVotingPeriod(100000);

        vm.prank(alice);
        vm.expectRevert();
        govModule.setMerkleSnapshotContract(address(0x1234)); // also reverts due to onlyOwner

        // Owner can update parameters
        vm.prank(owner);
        govModule.setQuorum(5e16);
        assertEq(govModule.quorum(), 5e16);

        vm.prank(owner);
        govModule.setVotingDelay(10);
        assertEq(govModule.votingDelay(), 10);

        vm.prank(owner);
        govModule.setVotingPeriod(100000);
        assertEq(govModule.votingPeriod(), 100000);

        MockMerkleSnapshot newSnapshot = new MockMerkleSnapshot(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: bytes32(uint256(0xbeef)),
                ipfsHash: bytes32(uint256(0x5678)),
                ipfsHashCid: "ipfs://new",
                totalValue: 999e18
            })
        );
        vm.prank(owner);
        govModule.setMerkleSnapshotContract(address(newSnapshot));
        assertEq(govModule.merkleSnapshotContract(), address(newSnapshot));
    }

    /// Helper: create an action-less proposal from `alice` (enough for state()-only assertions).
    function _proposeEmpty() internal returns (uint256 proposalId) {
        address[] memory targets = new address[](0);
        uint256[] memory values = new uint256[](0);
        bytes[] memory calldatas = new bytes[](0);
        Operation[] memory operations = new Operation[](0);
        string[] memory actionDescriptions = new string[](0);
        vm.prank(alice);
        proposalId = govModule.propose(
            "t", "d", targets, values, calldatas, operations, actionDescriptions, votingPowers[alice], proofs[alice]
        );
    }

    /// Roll into a proposal's active window (just past its startBlock), read from the proposal itself.
    function _rollToActive(uint256 proposalId) internal {
        (MerkleGovModule.Proposal memory p,,) = govModule.getProposal(proposalId);
        vm.roll(p.startBlock + 1);
    }

    /// Roll just past a proposal's endBlock so it becomes decided.
    function _rollPastEnd(uint256 proposalId) internal {
        (MerkleGovModule.Proposal memory p,,) = govModule.getProposal(proposalId);
        vm.roll(p.endBlock + 1);
    }

    /// M-1: the quorum fraction is snapshotted per proposal at creation. A later `setQuorum` must not
    /// retroactively flip a decided proposal, and only affects proposals created after it.
    function test_QuorumIsSnapshottedPerProposal() public {
        // P1 under the default 4% quorum (threshold 23e18 of 575e18); alice's 100e18 Yes clears it.
        uint256 p1 = _proposeEmpty();
        _rollToActive(p1);
        vm.prank(alice);
        govModule.castVote(p1, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);
        _rollPastEnd(p1);
        assertEq(uint256(govModule.state(p1)), uint256(MerkleGovModule.ProposalState.Passed));

        // Raising the quorum to 50% must NOT flip the already-decided P1 (its snapshot is honored).
        vm.prank(owner);
        govModule.setQuorum(5e17); // 50%
        assertEq(uint256(govModule.state(p1)), uint256(MerkleGovModule.ProposalState.Passed));

        // A NEW proposal P2 snapshots the new 50% quorum (threshold 287.5e18); 100e18 can't clear it.
        uint256 p2 = _proposeEmpty();
        _rollToActive(p2);
        vm.prank(alice);
        govModule.castVote(p2, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);
        _rollPastEnd(p2);
        assertEq(uint256(govModule.state(p2)), uint256(MerkleGovModule.ProposalState.Rejected));
    }

    function test_NonMemberCannotPropose() public {
        // Create proposal data
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 0;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        // Non-member with fake proof should fail
        address nonMember = address(0x7777777777777777777777777777777777777777);
        bytes32[] memory fakeProof = new bytes32[](1);
        fakeProof[0] = bytes32(uint256(0xdead));

        vm.prank(nonMember);
        vm.expectRevert(MerkleGovModule.InvalidMerkleProof.selector);
        govModule.propose(
            "Unauthorized proposal",
            "Unauthorized proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            100e18,
            fakeProof
        );

        // Member with wrong voting power should fail
        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.InvalidMerkleProof.selector);
        govModule.propose(
            "Wrong power proposal",
            "Wrong power proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            999e18, // Wrong voting power
            proofs[alice]
        );
    }

    function test_InvalidMerkleProof() public {
        // Create proposal
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 0;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Test proposal",
            "Test proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Move to voting period
        vm.roll(block.number + 2);

        // Try to vote with wrong voting power
        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.InvalidMerkleProof.selector);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, 500e18, proofs[alice]); // Wrong amount

        // Try to vote with wrong proof
        bytes32[] memory wrongProof = new bytes32[](1);
        wrongProof[0] = bytes32(uint256(0xdead));

        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.InvalidMerkleProof.selector);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], wrongProof);
    }

    function test_ProposalWithMultipleActions() public {
        TestTarget testTarget1 = new TestTarget();
        TestTarget testTarget2 = new TestTarget();

        // Create proposal with multiple actions
        address[] memory targets = new address[](3);
        uint256[] memory values = new uint256[](3);
        bytes[] memory calldatas = new bytes[](3);
        Operation[] memory operations = new Operation[](3);
        string[] memory actionDescriptions = new string[](3);

        targets[0] = address(testTarget1);
        values[0] = 0;
        calldatas[0] = abi.encodeWithSignature("setValue(uint256)", 100);
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        targets[1] = address(testTarget2);
        values[1] = 0;
        calldatas[1] = abi.encodeWithSignature("setValue(uint256)", 200);
        operations[1] = Operation.Call;
        actionDescriptions[1] = "";

        targets[2] = address(0x8888);
        values[2] = 2 ether;
        calldatas[2] = "";
        operations[2] = Operation.Call;
        actionDescriptions[2] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Multiple actions",
            "Proposal with multiple actions",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Vote and pass
        vm.roll(block.number + 2);

        vm.prank(alice);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);

        vm.prank(bob);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob]);

        // Execute (M-4: past the voting end AND the execution delay)
        vm.roll(block.number + 50401 + govModule.executionDelay() + 1);

        uint256 balanceBefore = address(0x8888).balance;
        govModule.execute(proposalId);

        // Verify all actions executed
        assertEq(testTarget1.value(), 100);
        assertEq(testTarget2.value(), 200);
        assertEq(address(0x8888).balance, balanceBefore + 2 ether);
    }

    function test_OnlyMerkleSnapshotCanUpdate() public {
        // Non-merkleSnapshot address cannot call onMerkleUpdate
        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.OnlyMerkleSnapshot.selector);
        govModule.onMerkleUpdate(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: bytes32(uint256(0xbeef)),
                ipfsHash: bytes32(uint256(0x5678)),
                ipfsHashCid: "ipfs://test",
                totalValue: 575e18
            })
        );

        // A proven root with totalValue == 0 (empty / fully-revoked graph) is legitimate and must be
        // tolerated, not reverted: reverting here would bubble up and brick MerkleSnapshot.submitProof
        // for every consumer. The hook records the root and zeroes the voting power.
        merkleSnapshot.setLatestState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: bytes32(uint256(0xd00d)),
                ipfsHash: bytes32(uint256(0x5678)),
                ipfsHashCid: "ipfs://test",
                totalValue: 0
            })
        );
        merkleSnapshot.pushUpdate(address(govModule));
        assertEq(govModule.currentMerkleRoot(), bytes32(uint256(0xd00d)));
        assertEq(govModule.totalVotingPower(), 0);
    }

    function test_MerkleRootUpdateDuringVoting() public {
        // Create proposal with initial merkle root
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 0;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Test proposal",
            "Test proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Move to voting period
        vm.roll(block.number + 2);

        // Alice votes with current merkle root
        vm.prank(alice);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);

        // Update merkle root (simulating new distribution)
        bytes32 newRoot = bytes32(uint256(0xbeef));
        _updateMerkleRoot(newRoot, bytes32(uint256(0x5678)), 575e18);

        // Bob can still vote because the proposal uses the snapshot from creation
        vm.prank(bob);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob]);

        // New proposal would use the new merkle root - old proofs should fail
        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.InvalidMerkleProof.selector);
        govModule.propose(
            "New proposal",
            "New proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );
    }

    function test_ProposalNotFound() public {
        // Non-existent proposal ID should revert
        vm.expectRevert(MerkleGovModule.ProposalNotFound.selector);
        govModule.state(0);

        vm.expectRevert(MerkleGovModule.ProposalNotFound.selector);
        govModule.state(999);

        // Cancel non-existent proposal should revert
        vm.prank(owner);
        vm.expectRevert(MerkleGovModule.ProposalNotFound.selector);
        govModule.cancel(0);

        vm.prank(owner);
        vm.expectRevert(MerkleGovModule.ProposalNotFound.selector);
        govModule.cancel(999);
    }

    function test_CannotCancelTwice() public {
        // Create proposal
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 0;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Test proposal",
            "Test proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // First cancel succeeds
        vm.prank(owner);
        govModule.cancel(proposalId);

        // Second cancel fails
        vm.prank(owner);
        vm.expectRevert(MerkleGovModule.ProposalAlreadyCancelled.selector);
        govModule.cancel(proposalId);
    }

    function test_SnapshotTotalVotingPowerUsedForQuorum() public {
        // Create proposal with current totalVotingPower = 575e18
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 0;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Test proposal",
            "Test proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Move to voting period
        vm.roll(block.number + 2);

        // Alice votes Yes (100e18) - this alone meets 4% quorum of 575e18 (23e18)
        vm.prank(alice);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);

        // Simulate merkle root update that increases totalVotingPower significantly
        // If quorum used current totalVotingPower, the proposal would fail
        // But since we snapshot, it should still pass
        bytes32 newRoot = bytes32(uint256(0xbeef));
        merkleSnapshot.setLatestState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: newRoot,
                ipfsHash: bytes32(uint256(0x5678)),
                ipfsHashCid: "ipfs://test",
                totalValue: 10000e18 // 10x increase - 4% would be 400e18
            })
        );
        merkleSnapshot.pushUpdate(address(govModule));

        // Move past voting period
        vm.roll(block.number + 50401);

        // Proposal should still be Passed because it uses snapshotted totalVotingPower (575e18)
        // 100e18 votes >= 4% of 575e18 (23e18), and yesVotes > noVotes
        assertEq(uint256(govModule.state(proposalId)), uint256(MerkleGovModule.ProposalState.Passed));
    }

    function test_GetProposal() public {
        // Create proposal with multiple actions
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        Operation[] memory operations = new Operation[](2);
        string[] memory actionDescriptions = new string[](2);

        targets[0] = address(0x9999);
        values[0] = 1 ether;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        targets[1] = address(0x8888);
        values[1] = 2 ether;
        calldatas[1] = abi.encodeWithSignature("setValue(uint256)", 42);
        operations[1] = Operation.Call;
        actionDescriptions[1] = "";

        vm.prank(alice);
        uint256 proposalId = govModule.propose(
            "Test proposal",
            "Test proposal description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice]
        );

        // Get proposal using the new getProposal function
        (
            MerkleGovModule.Proposal memory proposal,
            MerkleGovModule.ProposalState proposalState,
            MerkleGovModule.ProposalAction[] memory actions
        ) = govModule.getProposal(proposalId);

        // Verify proposal data
        assertEq(proposal.id, proposalId);
        assertEq(proposal.proposer, alice);
        assertEq(proposal.startBlock, block.number + 1);
        assertEq(proposal.endBlock, block.number + 1 + 50400);
        assertEq(proposal.yesVotes, 0);
        assertEq(proposal.noVotes, 0);
        assertEq(proposal.abstainVotes, 0);
        assertFalse(proposal.executed);
        assertFalse(proposal.cancelled);
        assertEq(proposal.merkleRoot, merkleRoot);
        assertEq(proposal.totalVotingPower, 575e18);

        // Verify state
        assertEq(uint256(proposalState), uint256(MerkleGovModule.ProposalState.Pending));

        // Verify actions
        assertEq(actions.length, 2);
        assertEq(actions[0].target, address(0x9999));
        assertEq(actions[0].value, 1 ether);
        assertEq(actions[0].data, "");
        assertEq(uint256(actions[0].operation), uint256(Operation.Call));

        assertEq(actions[1].target, address(0x8888));
        assertEq(actions[1].value, 2 ether);
        assertEq(actions[1].data, abi.encodeWithSignature("setValue(uint256)", 42));
        assertEq(uint256(actions[1].operation), uint256(Operation.Call));

        // Test that getProposal reverts for non-existent proposal
        vm.expectRevert(MerkleGovModule.ProposalNotFound.selector);
        govModule.getProposal(999);

        vm.expectRevert(MerkleGovModule.ProposalNotFound.selector);
        govModule.getProposal(0);
    }

    function test_ConstructorUpdatesMerkleStateFromSnapshot() public view {
        // These should be pulled from merkleSnapshot.getLatestState() during construction
        assertEq(govModule.currentMerkleRoot(), merkleRoot);
        assertEq(govModule.ipfsHash(), initialIpfsHash);
        assertEq(govModule.ipfsHashCid(), initialIpfsHashCid);
        assertEq(govModule.totalVotingPower(), initialTotalVotingPower);
    }

    function test_SetMerkleSnapshotContractUpdatesMerkleStateFromNewSnapshot() public {
        bytes32 newRoot = bytes32(uint256(0xaaaa));
        bytes32 newIpfsHash = bytes32(uint256(0xbbbb));
        string memory newCid = "ipfs://new-snapshot";
        uint256 newTotal = 1234e18;

        MockMerkleSnapshot newSnapshot = new MockMerkleSnapshot(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: newRoot,
                ipfsHash: newIpfsHash,
                ipfsHashCid: newCid,
                totalValue: newTotal
            })
        );

        vm.prank(owner);
        govModule.setMerkleSnapshotContract(address(newSnapshot));

        assertEq(govModule.merkleSnapshotContract(), address(newSnapshot));
        assertEq(govModule.currentMerkleRoot(), newRoot);
        assertEq(govModule.ipfsHash(), newIpfsHash);
        assertEq(govModule.ipfsHashCid(), newCid);
        assertEq(govModule.totalVotingPower(), newTotal);
    }

    function test_ConstructorGracefullyHandlesNoMerkleStates() public {
        MockMerkleSnapshotNoStates emptySnapshot = new MockMerkleSnapshotNoStates();

        MerkleGovModule freshGov = new MerkleGovModule(owner, address(safe), address(safe), address(emptySnapshot));

        assertEq(freshGov.merkleSnapshotContract(), address(emptySnapshot));
        assertEq(freshGov.currentMerkleRoot(), bytes32(0));
        assertEq(freshGov.ipfsHash(), bytes32(0));
        assertEq(freshGov.ipfsHashCid(), "");
        assertEq(freshGov.totalVotingPower(), 0);
    }

    function test_ConstructionIsSilentAndInitialBindingPublishesExactlyOnce() public {
        vm.recordLogs();
        MerkleGovModule freshGov = new MerkleGovModule(owner, address(safe), address(safe), address(merkleSnapshot));
        Vm.Log[] memory constructionLogs = vm.getRecordedLogs();
        // Ownable's OwnershipTransferred is the one construction log, and no indexer handler
        // subscribes to it. Nothing an indexer consumes may be emitted before discovery — above
        // all not the snapshot-binding announcement.
        bytes32 ownership = keccak256("OwnershipTransferred(address,address)");
        for (uint256 i = 0; i < constructionLogs.length; i++) {
            if (constructionLogs[i].emitter != address(freshGov)) continue;
            assertEq(
                constructionLogs[i].topics[0],
                ownership,
                "construction must emit nothing an indexer could dispatch pre-discovery"
            );
        }
        // The binding and state pull still happened silently.
        assertEq(freshGov.merkleSnapshotContract(), address(merkleSnapshot));
        assertEq(freshGov.currentMerkleRoot(), merkleRoot);
        assertFalse(freshGov.initialBindingPublished());

        // Anyone may publish, once, and the announcement carries previous = address(0).
        vm.expectEmit(true, true, false, true, address(freshGov));
        emit MerkleGovModule.MerkleSnapshotContractUpdated(address(0), address(merkleSnapshot));
        vm.prank(address(0xD15C));
        freshGov.publishInitialSnapshotBinding();
        assertTrue(freshGov.initialBindingPublished());

        vm.expectRevert(MerkleGovModule.AlreadyInitialized.selector);
        freshGov.publishInitialSnapshotBinding();
    }

    function test_SnapshotRotationSupersedesTheInitialBindingAnnouncement() public {
        MerkleGovModule freshGov = new MerkleGovModule(owner, address(safe), address(safe), address(merkleSnapshot));
        MockMerkleSnapshotNoStates emptySnapshot = new MockMerkleSnapshotNoStates();

        vm.expectEmit(true, true, false, true, address(freshGov));
        emit MerkleGovModule.MerkleSnapshotContractUpdated(address(merkleSnapshot), address(emptySnapshot));
        vm.prank(owner);
        freshGov.setMerkleSnapshotContract(address(emptySnapshot));

        // A later "initial" announcement would be stale and out of order; rotation consumed it.
        vm.expectRevert(MerkleGovModule.AlreadyInitialized.selector);
        freshGov.publishInitialSnapshotBinding();
    }

    function test_SetMerkleSnapshotContractGracefullyHandlesNoMerkleStates() public {
        // First ensure we have non-empty state
        assertEq(govModule.currentMerkleRoot(), merkleRoot);
        assertGt(govModule.totalVotingPower(), 0);

        MockMerkleSnapshotNoStates emptySnapshot = new MockMerkleSnapshotNoStates();

        vm.prank(owner);
        govModule.setMerkleSnapshotContract(address(emptySnapshot));

        assertEq(govModule.merkleSnapshotContract(), address(emptySnapshot));
        assertEq(govModule.currentMerkleRoot(), bytes32(0));
        assertEq(govModule.ipfsHash(), bytes32(0));
        assertEq(govModule.ipfsHashCid(), "");
        assertEq(govModule.totalVotingPower(), 0);
    }

    function test_ProposeWithVote() public {
        // Create proposal data
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 1 ether;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        // Expect both ProposalCreated and VoteCast events
        vm.expectEmit(true, true, false, true);
        emit ProposalCreated(
            1,
            alice,
            "Send 1 ETH",
            "Proposal to send 1 ETH",
            block.number + 1,
            block.number + 1 + 50400,
            merkleRoot,
            575e18
        );

        vm.expectEmit(true, true, false, true);
        emit VoteCast(alice, 1, MerkleGovModule.VoteType.Yes, votingPowers[alice]);

        // Create proposal and vote in one transaction
        vm.prank(alice);
        uint256 proposalId = govModule.proposeWithVote(
            "Send 1 ETH",
            "Proposal to send 1 ETH",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[alice],
            proofs[alice],
            MerkleGovModule.VoteType.Yes
        );

        assertEq(proposalId, 1);
        assertEq(govModule.proposalCount(), 1);

        // Check proposal details - should have alice's vote already recorded
        (
            uint256 id,
            address proposer,,,
            uint256 startBlock,
            uint256 endBlock,
            uint256 yesVotes,
            uint256 noVotes,
            uint256 abstainVotes,
            bool executed,
            bool cancelled,,
            uint256 totalVotingPower,
        ) = govModule.proposals(proposalId);

        assertEq(id, proposalId);
        assertEq(proposer, alice);
        assertEq(startBlock, block.number + 1);
        assertEq(endBlock, block.number + 1 + 50400);
        assertEq(yesVotes, votingPowers[alice]); // Alice's vote already counted
        assertEq(noVotes, 0);
        assertEq(abstainVotes, 0);
        assertFalse(executed);
        assertFalse(cancelled);
        assertEq(totalVotingPower, 575e18);

        // Verify alice has voted
        assertTrue(govModule.hasVoted(proposalId, alice));
        assertEq(uint256(govModule.votes(proposalId, alice)), uint256(MerkleGovModule.VoteType.Yes));

        // Alice cannot vote again
        vm.roll(block.number + 2); // Move to active period
        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.AlreadyVoted.selector);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.No, votingPowers[alice], proofs[alice]);

        // Bob can still vote
        vm.prank(bob);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob]);

        // Check updated vote tallies
        (,,,,,, yesVotes, noVotes, abstainVotes,,,,,) = govModule.proposals(proposalId);
        assertEq(yesVotes, votingPowers[alice] + votingPowers[bob]);
        assertEq(noVotes, 0);
        assertEq(abstainVotes, 0);
    }

    function test_ProposeWithVoteNo() public {
        // Test proposeWithVote with a No vote
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 1 ether;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(bob);
        uint256 proposalId = govModule.proposeWithVote(
            "Test No Vote",
            "Test No Vote description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[bob],
            proofs[bob],
            MerkleGovModule.VoteType.No
        );

        // Check that No vote is recorded
        (,,,,,, uint256 yesVotes, uint256 noVotes,,,,,,) = govModule.proposals(proposalId);
        assertEq(yesVotes, 0);
        assertEq(noVotes, votingPowers[bob]);

        assertEq(uint256(govModule.votes(proposalId, bob)), uint256(MerkleGovModule.VoteType.No));
    }

    function test_ProposeWithVoteAbstain() public {
        // Test proposeWithVote with an Abstain vote
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);

        targets[0] = address(0x9999);
        values[0] = 1 ether;
        calldatas[0] = "";
        operations[0] = Operation.Call;
        actionDescriptions[0] = "";

        vm.prank(charlie);
        uint256 proposalId = govModule.proposeWithVote(
            "Test Abstain Vote",
            "Test Abstain Vote description",
            targets,
            values,
            calldatas,
            operations,
            actionDescriptions,
            votingPowers[charlie],
            proofs[charlie],
            MerkleGovModule.VoteType.Abstain
        );

        // Check that Abstain vote is recorded
        (,,,,,, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes,,,,,) = govModule.proposals(proposalId);
        assertEq(yesVotes, 0);
        assertEq(noVotes, 0);
        assertEq(abstainVotes, votingPowers[charlie]);

        assertEq(uint256(govModule.votes(proposalId, charlie)), uint256(MerkleGovModule.VoteType.Abstain));
    }

    /*//////////////////////////////////////////////////////////////
            2026-08-13 AUDIT REGRESSIONS (M-4, M-5, M-8)
    //////////////////////////////////////////////////////////////*/

    /// Helper: a one-action proposal from `alice` targeting `target_` with `data` and `op`.
    function _proposeAction(address target_, bytes memory data, Operation op) internal returns (uint256 proposalId) {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);
        targets[0] = target_;
        calldatas[0] = data;
        operations[0] = op;
        actionDescriptions[0] = "";
        vm.prank(alice);
        proposalId = govModule.propose(
            "t", "d", targets, values, calldatas, operations, actionDescriptions, votingPowers[alice], proofs[alice]
        );
    }

    /// Pass a proposal with alice's Yes vote and roll just past its end (NOT past the delay).
    function _passWithAliceYes(uint256 proposalId) internal {
        _rollToActive(proposalId);
        vm.prank(alice);
        govModule.castVote(proposalId, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice]);
        _rollPastEnd(proposalId);
        assertEq(uint256(govModule.state(proposalId)), uint256(MerkleGovModule.ProposalState.Passed));
    }

    /// M-4 regression: a passed proposal cannot reach the Safe in the block its voting closes —
    /// execution opens only after `executionDelay` more blocks (the exit window).
    function test_M4_ExecutionDelayGatesExecute() public {
        TestTarget target_ = new TestTarget();
        uint256 pid = _proposeAction(address(target_), abi.encodeWithSignature("setValue(uint256)", 7), Operation.Call);
        _passWithAliceYes(pid);

        (MerkleGovModule.Proposal memory p,,) = govModule.getProposal(pid);
        uint256 executableAt = p.endBlock + govModule.executionDelay();

        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.ExecutionDelayNotElapsed.selector, executableAt));
        govModule.execute(pid);

        // Still gated AT the boundary (strictly-after semantics).
        vm.roll(executableAt);
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.ExecutionDelayNotElapsed.selector, executableAt));
        govModule.execute(pid);

        vm.roll(executableAt + 1);
        govModule.execute(pid);
        assertEq(target_.value(), 7);
    }

    /// M-4 regression: DelegateCall runs in the Safe's context and bypasses any Guard — it is
    /// deny-by-default at propose time, allowlisted per target by the owner, and RE-CHECKED at
    /// execute time so a revoked target cannot slip through a passed proposal.
    function test_M4_DelegateCallDenyByDefaultAndRecheckedAtExecute() public {
        TestTarget target_ = new TestTarget();
        bytes memory data = abi.encodeWithSignature("setValue(uint256)", 1);

        // Deny at the door.
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory actionDescriptions = new string[](1);
        targets[0] = address(target_);
        calldatas[0] = data;
        operations[0] = Operation.DelegateCall;
        actionDescriptions[0] = "";
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.DelegateCallNotAllowed.selector, address(target_)));
        govModule.propose(
            "t", "d", targets, values, calldatas, operations, actionDescriptions, votingPowers[alice], proofs[alice]
        );

        // Allowlisted: proposable.
        vm.prank(owner);
        govModule.setDelegateCallTarget(address(target_), true);
        uint256 pid = _proposeAction(address(target_), data, Operation.DelegateCall);
        _passWithAliceYes(pid);
        (MerkleGovModule.Proposal memory p,,) = govModule.getProposal(pid);
        vm.roll(p.endBlock + govModule.executionDelay() + 1);

        // Revoked between propose and execute: the execute-time re-check refuses.
        vm.prank(owner);
        govModule.setDelegateCallTarget(address(target_), false);
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.DelegateCallNotAllowed.selector, address(target_)));
        govModule.execute(pid);
    }

    /// M-5 regression: abstain votes are excluded from the quorum sum. Pre-fix, a proposal whose
    /// participation was mostly abstentions passed on a tiny "for" minority.
    function test_M5_AbstainDoesNotCountTowardQuorum() public {
        // Raise quorum to 50% of 575e18 = 287.5e18 for a clean separation.
        vm.prank(owner);
        govModule.setQuorum(5e17);

        uint256 pid = _proposeEmpty();
        _rollToActive(pid);
        // bob Yes (200e18); charlie + eve Abstain (150e18 + 75e18).
        vm.prank(bob);
        govModule.castVote(pid, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob]);
        vm.prank(charlie);
        govModule.castVote(pid, MerkleGovModule.VoteType.Abstain, votingPowers[charlie], proofs[charlie]);
        vm.prank(eve);
        govModule.castVote(pid, MerkleGovModule.VoteType.Abstain, votingPowers[eve], proofs[eve]);
        _rollPastEnd(pid);

        // Pre-fix: yes+no+abstain = 425e18 >= 287.5e18 and yes > no => Passed on a 200e18 "for"
        // minority. Post-fix: decisive (yes+no) = 200e18 < 287.5e18 => Rejected.
        assertEq(
            uint256(govModule.state(pid)),
            uint256(MerkleGovModule.ProposalState.Rejected),
            "REGRESSION: abstain-stuffed quorum passed a minority proposal"
        );

        // Control: the same decisive turnout WITH quorum met still passes.
        uint256 pid2 = _proposeEmpty();
        _rollToActive(pid2);
        vm.prank(bob);
        govModule.castVote(pid2, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob]);
        vm.prank(charlie);
        govModule.castVote(pid2, MerkleGovModule.VoteType.Yes, votingPowers[charlie], proofs[charlie]);
        _rollPastEnd(pid2);
        assertEq(uint256(govModule.state(pid2)), uint256(MerkleGovModule.ProposalState.Passed));
    }

    /// M-8 regression: a failed action reverts the whole execution — the proposal stays Passed
    /// and retryable — instead of being silently swallowed while the proposal is marked executed.
    function test_M8_FailedActionRevertsInsteadOfSilentlyExecuting() public {
        FlakyTarget flaky = new FlakyTarget();
        uint256 pid = _proposeAction(address(flaky), abi.encodeWithSignature("go()"), Operation.Call);
        _passWithAliceYes(pid);
        (MerkleGovModule.Proposal memory p,,) = govModule.getProposal(pid);
        vm.roll(p.endBlock + govModule.executionDelay() + 1);

        // The action fails (not armed): execute must revert, naming the failing index.
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.ActionFailed.selector, 0));
        govModule.execute(pid);
        assertEq(
            uint256(govModule.state(pid)),
            uint256(MerkleGovModule.ProposalState.Passed),
            "REGRESSION: proposal marked executed despite the action failing"
        );
        assertFalse(flaky.done());

        // Once the target works, the same proposal executes.
        flaky.arm();
        govModule.execute(pid);
        assertTrue(flaky.done());
        assertEq(uint256(govModule.state(pid)), uint256(MerkleGovModule.ProposalState.Executed));
    }

    /*//////////////////////////////////////////////////////////////
              AGENT DELEGATION + PRINCIPAL OVERRIDE (ISSUE 38)
    //////////////////////////////////////////////////////////////*/

    function test_VoteDelegateSetChangeRevokeAndRejectSelf() public {
        vm.expectEmit(true, true, true, true);
        emit VoteDelegateSet(alice, address(0), bob);
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        assertEq(govModule.voteDelegate(alice), bob);

        vm.expectEmit(true, true, true, true);
        emit VoteDelegateSet(alice, bob, charlie);
        vm.prank(alice);
        govModule.setVoteDelegate(charlie);
        assertEq(govModule.voteDelegate(alice), charlie);

        vm.expectEmit(true, true, true, true);
        emit VoteDelegateSet(alice, charlie, address(0));
        vm.prank(alice);
        govModule.setVoteDelegate(address(0));
        assertEq(govModule.voteDelegate(alice), address(0));

        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.SelfDelegation.selector);
        govModule.setVoteDelegate(alice);
    }

    function test_DelegateVoteRecordsPrincipalPowerAndReasonReceipt() public {
        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        _rollToActive(pid);

        vm.expectEmit(true, true, false, true);
        emit VoteCast(alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice]);
        vm.expectEmit(true, true, true, true);
        emit DelegateVoteCast(
            alice, pid, bob, MerkleGovModule.VoteType.Yes, votingPowers[alice], "meets the published budget"
        );
        vm.prank(bob);
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "meets the published budget"
        );

        assertTrue(govModule.hasVoted(pid, alice));
        assertTrue(govModule.votedByDelegate(pid, alice));
        assertEq(govModule.delegateVoter(pid, alice), bob);
        assertEq(govModule.votePower(pid, alice), votingPowers[alice]);
        assertEq(uint256(govModule.votes(pid, alice)), uint256(MerkleGovModule.VoteType.Yes));
        (,,,,,, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes,,,,,) = govModule.proposals(pid);
        assertEq(yesVotes, votingPowers[alice]);
        assertEq(noVotes, 0);
        assertEq(abstainVotes, 0);
        assertFalse(govModule.hasVoted(pid, bob), "delegate must not spend its own vote");
    }

    function test_OnlyCurrentDelegateCanVoteAndRevocationPreempts() public {
        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        vm.prank(alice);
        govModule.setVoteDelegate(charlie);
        _rollToActive(pid);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.NotVoteDelegate.selector, alice, bob));
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "stale delegate"
        );

        vm.prank(alice);
        govModule.setVoteDelegate(address(0));
        vm.prank(charlie);
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.NotVoteDelegate.selector, alice, charlie));
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "revoked"
        );
    }

    function test_PrincipalPreemptionIsFinalAndDelegateCannotOverwrite() public {
        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        _rollToActive(pid);

        vm.prank(alice);
        govModule.castVote(pid, MerkleGovModule.VoteType.No, votingPowers[alice], proofs[alice]);

        vm.prank(bob);
        vm.expectRevert(MerkleGovModule.AlreadyVoted.selector);
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "too late"
        );
        assertFalse(govModule.votedByDelegate(pid, alice));
        assertEq(uint256(govModule.votes(pid, alice)), uint256(MerkleGovModule.VoteType.No));
    }

    function test_DelegateCannotVoteTwiceOrChangeItsVote() public {
        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        _rollToActive(pid);

        vm.prank(bob);
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "first"
        );

        vm.prank(bob);
        vm.expectRevert(MerkleGovModule.AlreadyVoted.selector);
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.No, votingPowers[alice], proofs[alice], "overwrite"
        );
    }

    function test_DelegateReasonIsBoundedForIndexerSafety() public {
        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        _rollToActive(pid);
        string memory oversized = new string(govModule.MAX_DELEGATE_REASON_BYTES() + 1);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.DelegateReasonTooLong.selector, bytes(oversized).length));
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], oversized
        );
        assertFalse(govModule.hasVoted(pid, alice));
    }

    function test_DelegateMustUsePrincipalsProposalPinnedProof() public {
        uint256 pid = _proposeEmpty();
        vm.prank(charlie);
        govModule.setVoteDelegate(bob);

        // A later graph update does not change the root pinned into this proposal.
        _updateMerkleRoot(bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)), 1);
        _rollToActive(pid);

        vm.prank(bob);
        vm.expectRevert(MerkleGovModule.InvalidMerkleProof.selector);
        govModule.castVoteAsDelegate(
            charlie, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "wrong principal"
        );

        vm.prank(bob);
        govModule.castVoteAsDelegate(
            charlie, pid, MerkleGovModule.VoteType.Yes, votingPowers[charlie], proofs[charlie], "old root is pinned"
        );
        assertEq(govModule.votePower(pid, charlie), votingPowers[charlie]);
    }

    function test_DelegateVoteRespectsVotingWindow() public {
        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);

        vm.prank(bob);
        vm.expectRevert(MerkleGovModule.VotingClosed.selector);
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "too early"
        );

        _rollPastEnd(pid);
        vm.prank(bob);
        vm.expectRevert(MerkleGovModule.VotingClosed.selector);
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "too late"
        );
    }

    function test_RevokingAfterDelegateVoteDoesNotEraseItAndPrincipalCanOverride() public {
        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        _rollToActive(pid);
        vm.prank(bob);
        govModule.castVoteAsDelegate(
            alice, pid, MerkleGovModule.VoteType.Yes, votingPowers[alice], proofs[alice], "provisional"
        );

        vm.prank(alice);
        govModule.setVoteDelegate(address(0));
        (,,,,,, uint256 yesBefore,,,,,,,) = govModule.proposals(pid);
        assertEq(yesBefore, votingPowers[alice]);

        vm.expectEmit(true, true, true, true);
        emit VoteOverridden(
            alice, pid, bob, MerkleGovModule.VoteType.Yes, MerkleGovModule.VoteType.Abstain, votingPowers[alice]
        );
        vm.prank(alice);
        govModule.castVote(pid, MerkleGovModule.VoteType.Abstain, votingPowers[alice], proofs[alice]);

        (,,,,,, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes,,,,,) = govModule.proposals(pid);
        assertEq(yesVotes, 0);
        assertEq(noVotes, 0);
        assertEq(abstainVotes, votingPowers[alice]);
        assertFalse(govModule.votedByDelegate(pid, alice));
        assertEq(govModule.delegateVoter(pid, alice), bob, "original delegate remains auditable");

        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.AlreadyVoted.selector);
        govModule.castVote(pid, MerkleGovModule.VoteType.No, votingPowers[alice], proofs[alice]);
    }

    function testFuzz_PrincipalOverridePreservesExactlyOneVotesPower(uint8 delegatedRaw, uint8 principalRaw) public {
        MerkleGovModule.VoteType delegatedVote =
            MerkleGovModule.VoteType(bound(uint256(delegatedRaw), 0, uint256(MerkleGovModule.VoteType.Abstain)));
        MerkleGovModule.VoteType principalVote =
            MerkleGovModule.VoteType(bound(uint256(principalRaw), 0, uint256(MerkleGovModule.VoteType.Abstain)));

        uint256 pid = _proposeEmpty();
        vm.prank(alice);
        govModule.setVoteDelegate(bob);
        _rollToActive(pid);
        vm.prank(bob);
        govModule.castVoteAsDelegate(alice, pid, delegatedVote, votingPowers[alice], proofs[alice], "provisional");
        vm.prank(alice);
        govModule.castVote(pid, principalVote, votingPowers[alice], proofs[alice]);

        (,,,,,, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes,,,,,) = govModule.proposals(pid);
        assertEq(yesVotes + noVotes + abstainVotes, votingPowers[alice], "override changed turnout");
        assertEq(yesVotes, principalVote == MerkleGovModule.VoteType.Yes ? votingPowers[alice] : 0);
        assertEq(noVotes, principalVote == MerkleGovModule.VoteType.No ? votingPowers[alice] : 0);
        assertEq(abstainVotes, principalVote == MerkleGovModule.VoteType.Abstain ? votingPowers[alice] : 0);
        assertEq(uint256(govModule.votes(pid, alice)), uint256(principalVote));
        assertFalse(govModule.votedByDelegate(pid, alice));
    }

    function test_DelegatedVotesCountIdenticallyForQuorumAndOverrideRecomputesIt() public {
        vm.prank(owner);
        govModule.setQuorum(5e17); // 287.5e18 decisive power required
        uint256 pid = _proposeEmpty();
        vm.prank(bob);
        govModule.setVoteDelegate(eve);
        _rollToActive(pid);

        vm.prank(eve);
        govModule.castVoteAsDelegate(bob, pid, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob], "yes");
        vm.prank(charlie);
        govModule.castVote(pid, MerkleGovModule.VoteType.Yes, votingPowers[charlie], proofs[charlie]);
        _rollPastEnd(pid);
        assertEq(uint256(govModule.state(pid)), uint256(MerkleGovModule.ProposalState.Passed));

        // Control on another active proposal: replacing the same 200 power with No changes the
        // majority, not turnout or quorum participation.
        uint256 pid2 = _proposeEmpty();
        _rollToActive(pid2);
        vm.prank(eve);
        govModule.castVoteAsDelegate(bob, pid2, MerkleGovModule.VoteType.Yes, votingPowers[bob], proofs[bob], "yes");
        vm.prank(charlie);
        govModule.castVote(pid2, MerkleGovModule.VoteType.Yes, votingPowers[charlie], proofs[charlie]);
        vm.prank(bob);
        govModule.castVote(pid2, MerkleGovModule.VoteType.No, votingPowers[bob], proofs[bob]);
        _rollPastEnd(pid2);
        assertEq(uint256(govModule.state(pid2)), uint256(MerkleGovModule.ProposalState.Rejected));
    }
}

contract MockMerkleSnapshot is IMerkleSnapshot {
    IMerkleSnapshot.MerkleState private _latest;

    constructor(IMerkleSnapshot.MerkleState memory initialState) {
        _latest = initialState;
    }

    function setLatestState(IMerkleSnapshot.MerkleState memory newState) external {
        _latest = newState;
    }

    function getLatestState() external view override returns (IMerkleSnapshot.MerkleState memory) {
        return _latest;
    }

    function pushUpdate(address hook) external {
        IMerkleSnapshotHook(hook).onMerkleUpdate(_latest);
    }
}

contract MockMerkleSnapshotNoStates is IMerkleSnapshot {
    function getLatestState() external pure override returns (IMerkleSnapshot.MerkleState memory) {
        revert IMerkleSnapshot.NoMerkleStates();
    }
}

// Helper contract for testing execution
contract TestTarget {
    uint256 public value;

    function setValue(uint256 _value) external {
        value = _value;
    }
}

/// M-8 helper: fails until armed, so a failed execution can be retried after the fix.
contract FlakyTarget {
    bool public armed;
    bool public done;

    function arm() external {
        armed = true;
    }

    function go() external {
        require(armed, "not armed");
        done = true;
    }
}
