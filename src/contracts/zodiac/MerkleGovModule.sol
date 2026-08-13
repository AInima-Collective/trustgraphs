// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Module} from "@gnosis-guild/zodiac-core/core/Module.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";

/// @title MerkleGovModule - Zodiac module for merkle-based governance
/// @notice Combines merkle voting verification with Zodiac's execution capabilities
/// TODO: should the onlyOwner modifier be onlyAvatar instead? voting config (quorum, delay, period) should be set by the DAO probably, not owner.
contract MerkleGovModule is Module, IMerkleSnapshotHook {
    /*///////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error AlreadyInitialized();
    error NoMerkleRootSet();
    error InvalidProposalData();
    error InvalidMerkleProof();
    error VotingClosed();
    error AlreadyVoted();
    error ProposalNotPassed();
    error NotAuthorized();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyCancelled();
    error ProposalNotFound();
    error InvalidQuorum();
    error InvalidVotingPeriod();
    error InvalidAddress();
    error OnlyMerkleSnapshot();

    /*///////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum ProposalState {
        Pending,
        Active,
        Rejected,
        Passed,
        Executed,
        Cancelled
    }

    enum VoteType {
        No,
        Yes,
        Abstain
    }

    struct ProposalAction {
        address target;
        uint256 value;
        bytes data;
        Operation operation;
        string description;
    }

    struct Proposal {
        uint256 id;
        address proposer;
        string title;
        string description;
        uint256 startBlock;
        uint256 endBlock;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 abstainVotes;
        bool executed;
        bool cancelled;
        bytes32 merkleRoot; // Snapshot of merkle root at proposal creation (startBlock)
        uint256 totalVotingPower; // Snapshot of total voting power at proposal creation (startBlock)
        uint256 quorumFraction; // Snapshot of the quorum fraction at proposal creation (startBlock)
    }

    /*///////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

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

    event VoteCast(address indexed voter, uint256 indexed proposalId, VoteType voteType, uint256 votingPower);

    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    event QuorumUpdated(uint256 newQuorum);
    event VotingDelayUpdated(uint256 newDelay);
    event VotingPeriodUpdated(uint256 newPeriod);
    event MerkleSnapshotContractUpdated(address indexed previousContract, address indexed newContract);

    /*///////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Address of the MerkleSnapshot contract that can update merkle state
    address public merkleSnapshotContract;

    /// @notice Current merkle root for voting power verification
    bytes32 public currentMerkleRoot;

    /// @notice IPFS hash for current merkle root metadata
    bytes32 public ipfsHash;

    /// @notice The optional ipfs hash CID containing metadata about the root (e.g. the merkle tree itself).
    string public ipfsHashCid;

    /// @notice Total voting power across all accounts in the merkle tree
    uint256 public totalVotingPower;

    /// @notice Proposal counter
    uint256 public proposalCount;

    /// @notice Proposals mapping
    mapping(uint256 => Proposal) public proposals;

    /// @notice Proposal actions mapping
    mapping(uint256 => ProposalAction[]) public proposalActions;

    /// @notice Tracks whether an address has voted on a proposal
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;

    /// @notice Tracks the vote type for each voter on a proposal
    mapping(uint256 proposalId => mapping(address voter => VoteType)) public votes;

    /// @notice Governance parameters
    uint256 public votingDelay = 1; // blocks
    uint256 public votingPeriod = 50400; // ~1 week at 12s blocks
    uint256 public quorum = 4e16; // 4% in basis points (4e16 = 4% of 1e18)

    /// @notice The divisor for quorum calculations (quorum = QUORUM_RANGE = 100% quorum)
    uint256 public constant QUORUM_RANGE = 1e18;

    /// @notice Whether the module is initialized
    bool private _initialized;

    /*///////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _owner, address _avatar, address _target, address _merkleSnapshot) {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        _transferOwnership(_owner);
        avatar = _avatar;
        target = _target;
        _setMerkleSnapshotContract(_merkleSnapshot);
    }

    /// @notice Sets up the module for factory deployment
    function setUp(bytes memory initializeParams) public override {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        (address _owner, address _avatar, address _target, address _merkleSnapshot) =
            abi.decode(initializeParams, (address, address, address, address));

        _transferOwnership(_owner);
        avatar = _avatar;
        target = _target;
        _setMerkleSnapshotContract(_merkleSnapshot);
    }

    /*///////////////////////////////////////////////////////////////
                            PROPOSAL LOGIC
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a new proposal
    /// @param title The title of the proposal
    /// @param description The description of the proposal
    /// @param targets Array of target addresses
    /// @param values Array of ETH values
    /// @param calldatas Array of encoded function calls
    /// @param operations Array of operation types
    /// @param actionDescriptions Array of action descriptions
    /// @param votingPower The claimed voting power (for merkle proof verification)
    /// @param proof Merkle proof for membership verification
    function propose(
        string memory title,
        string memory description,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        Operation[] memory operations,
        string[] memory actionDescriptions,
        uint256 votingPower,
        bytes32[] calldata proof
    ) external returns (uint256 proposalId) {
        proposalId = _propose(
            title, description, targets, values, calldatas, operations, actionDescriptions, votingPower, proof
        );
    }

    /// @notice Create a new proposal and cast the proposer's vote in one transaction
    /// @param title The title of the proposal
    /// @param description The description of the proposal
    /// @param targets Array of target addresses
    /// @param values Array of ETH values
    /// @param calldatas Array of encoded function calls
    /// @param operations Array of operation types
    /// @param actionDescriptions Array of action descriptions
    /// @param votingPower The claimed voting power (for merkle proof verification)
    /// @param proof Merkle proof for membership verification
    /// @param voteType The type of vote to cast (No, Yes, Abstain)
    function proposeWithVote(
        string memory title,
        string memory description,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        Operation[] memory operations,
        string[] memory actionDescriptions,
        uint256 votingPower,
        bytes32[] calldata proof,
        VoteType voteType
    ) external returns (uint256 proposalId) {
        proposalId = _propose(
            title, description, targets, values, calldatas, operations, actionDescriptions, votingPower, proof
        );

        // Record the proposer's vote immediately
        // The proof was already verified in _propose, so we can record the vote directly
        _castVote(proposalId, msg.sender, voteType, votingPower);
    }

    /// @notice Cast a vote with merkle proof verification
    /// @param proposalId The proposal to vote on
    /// @param voteType The type of vote (No, Yes, Abstain)
    /// @param votingPower The claimed voting power
    /// @param proof Merkle proof for voting power
    function castVote(uint256 proposalId, VoteType voteType, uint256 votingPower, bytes32[] calldata proof) external {
        Proposal storage proposal = proposals[proposalId];
        if (state(proposalId) != ProposalState.Active) revert VotingClosed();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        // Verify voter is in merkle tree (using proposal's snapshot)
        _verifyMerkleProof(msg.sender, votingPower, proposal.merkleRoot, proof);

        _castVote(proposalId, msg.sender, voteType, votingPower);
    }

    /// @notice Execute a successful proposal
    /// @param proposalId The proposal to execute
    function execute(uint256 proposalId) external {
        if (state(proposalId) != ProposalState.Passed) {
            revert ProposalNotPassed();
        }

        Proposal storage proposal = proposals[proposalId];
        proposal.executed = true;

        ProposalAction[] memory actions = proposalActions[proposalId];
        for (uint256 i = 0; i < actions.length; i++) {
            exec(actions[i].target, actions[i].value, actions[i].data, actions[i].operation);
        }

        emit ProposalExecuted(proposalId);
    }

    /// @notice Cancel a proposal
    /// @param proposalId The proposal to cancel
    /// @dev Only the owner or avatar can cancel a proposal
    function cancel(uint256 proposalId) external {
        if (proposalId == 0 || proposalId > proposalCount) {
            revert ProposalNotFound();
        }

        Proposal storage proposal = proposals[proposalId];
        if (msg.sender != owner() && msg.sender != avatar) {
            revert NotAuthorized();
        }
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.cancelled) revert ProposalAlreadyCancelled();

        proposal.cancelled = true;
        emit ProposalCancelled(proposalId);
    }

    /*///////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Get the state of a proposal
    /// @dev Reverts if proposal does not exist
    function state(uint256 proposalId) public view returns (ProposalState) {
        if (proposalId == 0 || proposalId > proposalCount) {
            revert ProposalNotFound();
        }

        Proposal storage proposal = proposals[proposalId];

        if (proposal.cancelled) return ProposalState.Cancelled;
        if (proposal.executed) return ProposalState.Executed;

        uint256 currentBlock = block.number;

        if (currentBlock < proposal.startBlock) return ProposalState.Pending;
        if (currentBlock <= proposal.endBlock) return ProposalState.Active;

        // Check if proposal passed
        // Quorum is a percentage of snapshotted totalVotingPower (e.g., 4e16 = 4%)
        uint256 totalVotes = proposal.yesVotes + proposal.noVotes + proposal.abstainVotes;
        uint256 quorumThreshold = Math.mulDiv(proposal.totalVotingPower, proposal.quorumFraction, QUORUM_RANGE);
        if (totalVotes >= quorumThreshold && proposal.yesVotes > proposal.noVotes) {
            return ProposalState.Passed;
        }

        return ProposalState.Rejected;
    }

    /// @notice Get a proposal with its state and actions
    /// @param proposalId The proposal ID to query
    /// @return proposal The proposal data
    /// @return proposalState The current state of the proposal
    /// @return actions The proposal actions
    function getProposal(uint256 proposalId)
        external
        view
        returns (Proposal memory proposal, ProposalState proposalState, ProposalAction[] memory actions)
    {
        if (proposalId == 0 || proposalId > proposalCount) {
            revert ProposalNotFound();
        }

        proposal = proposals[proposalId];
        proposalState = state(proposalId);
        actions = proposalActions[proposalId];
    }

    /// @notice Get proposal actions
    function getActions(uint256 proposalId) external view returns (ProposalAction[] memory) {
        return proposalActions[proposalId];
    }

    // Note: hasVoted(proposalId, voter) and votes(proposalId, voter) are auto-generated
    // by the public mappings declared in storage

    /*///////////////////////////////////////////////////////////////
                            ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Update quorum requirement
    function setQuorum(uint256 newQuorum) external onlyOwner {
        if (newQuorum == 0 || newQuorum > QUORUM_RANGE) revert InvalidQuorum();
        quorum = newQuorum;
        emit QuorumUpdated(newQuorum);
    }

    /// @notice Update voting delay
    function setVotingDelay(uint256 newDelay) external onlyOwner {
        votingDelay = newDelay;
        emit VotingDelayUpdated(newDelay);
    }

    /// @notice Update voting period
    function setVotingPeriod(uint256 newPeriod) external onlyOwner {
        if (newPeriod == 0) revert InvalidVotingPeriod();
        votingPeriod = newPeriod;
        emit VotingPeriodUpdated(newPeriod);
    }

    /// @notice Update merkle snapshot contract
    function setMerkleSnapshotContract(address newContract) external onlyOwner {
        _setMerkleSnapshotContract(newContract);
    }

    /*///////////////////////////////////////////////////////////////
                        MERKLE SNAPSHOT HOOK
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMerkleSnapshotHook
    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory state_) external {
        if (msg.sender != merkleSnapshotContract) revert OnlyMerkleSnapshot();

        // A proven root with `totalValue == 0` (an empty / fully-revoked graph) is legitimate and
        // MUST NOT be rejected here: reverting would bubble up through MerkleSnapshot.submitProof and
        // brick all future root submission for every consumer. We store it as-is; with zero voting
        // power the quorum threshold is unreachable and `propose` refuses (currentMerkleRoot == 0),
        // so no proposal can be created or pass against an empty root.
        currentMerkleRoot = state_.root;
        ipfsHash = state_.ipfsHash;
        ipfsHashCid = state_.ipfsHashCid;
        totalVotingPower = state_.totalValue;
        emit IMerkleSnapshot.MerkleRootUpdated(state_.root, state_.ipfsHash, state_.ipfsHashCid, state_.totalValue);
    }

    /*///////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Internal function to create a proposal
    /// @param title The title of the proposal
    /// @param description The description of the proposal
    /// @param targets Array of target addresses
    /// @param values Array of ETH values
    /// @param calldatas Array of encoded function calls
    /// @param operations Array of operation types
    /// @param actionDescriptions Array of action descriptions
    /// @param votingPower The claimed voting power (for merkle proof verification)
    /// @param proof Merkle proof for membership verification
    function _propose(
        string memory title,
        string memory description,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        Operation[] memory operations,
        string[] memory actionDescriptions,
        uint256 votingPower,
        bytes32[] calldata proof
    ) internal returns (uint256 proposalId) {
        if (currentMerkleRoot == bytes32(0)) revert NoMerkleRootSet();
        if (
            targets.length != values.length || targets.length != calldatas.length || targets.length != operations.length
                || targets.length != actionDescriptions.length
        ) revert InvalidProposalData();

        // Verify proposer is in merkle tree
        _verifyMerkleProof(msg.sender, votingPower, currentMerkleRoot, proof);

        proposalId = ++proposalCount;
        Proposal storage proposal = proposals[proposalId];

        proposal.id = proposalId;
        proposal.proposer = msg.sender;
        proposal.title = title;
        proposal.description = description;
        proposal.startBlock = block.number + votingDelay;
        proposal.endBlock = proposal.startBlock + votingPeriod;
        proposal.merkleRoot = currentMerkleRoot;
        proposal.totalVotingPower = totalVotingPower;
        // Snapshot the quorum fraction alongside the total, so a later `setQuorum` cannot
        // retroactively re-decide a proposal whose voting window has already opened/closed.
        proposal.quorumFraction = quorum;

        // Store actions
        for (uint256 i = 0; i < targets.length; i++) {
            proposalActions[proposalId].push(
                ProposalAction({
                    target: targets[i],
                    value: values[i],
                    data: calldatas[i],
                    operation: operations[i],
                    description: actionDescriptions[i]
                })
            );
        }

        emit ProposalCreated(
            proposalId,
            msg.sender,
            proposal.title,
            proposal.description,
            proposal.startBlock,
            proposal.endBlock,
            proposal.merkleRoot,
            proposal.totalVotingPower
        );
    }

    /// @notice Internal function to record a vote
    /// @param proposalId The proposal to vote on
    /// @param voter The address casting the vote
    /// @param voteType The type of vote (No, Yes, Abstain)
    /// @param votingPower The voting power to apply
    function _castVote(uint256 proposalId, address voter, VoteType voteType, uint256 votingPower) internal {
        Proposal storage proposal = proposals[proposalId];

        hasVoted[proposalId][voter] = true;
        votes[proposalId][voter] = voteType;

        if (voteType == VoteType.Yes) {
            proposal.yesVotes += votingPower;
        } else if (voteType == VoteType.No) {
            proposal.noVotes += votingPower;
        } else {
            proposal.abstainVotes += votingPower;
        }

        emit VoteCast(voter, proposalId, voteType, votingPower);
    }

    /// @notice Verifies a merkle proof for an account's voting power
    /// @param account The account to verify
    /// @param votingPower The claimed voting power
    /// @param merkleRoot The merkle root to verify against
    /// @param proof The merkle proof
    function _verifyMerkleProof(address account, uint256 votingPower, bytes32 merkleRoot, bytes32[] calldata proof)
        internal
        pure
    {
        // forge-lint-disable-next-line asm-keccak256
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, votingPower))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) {
            revert InvalidMerkleProof();
        }
    }

    /// @notice Internal function to set the merkle snapshot contract and update the relevant state
    function _setMerkleSnapshotContract(address newContract) internal {
        if (newContract == address(0)) revert InvalidAddress();

        address previousContract = merkleSnapshotContract;
        merkleSnapshotContract = newContract;

        // Pull latest merkle state from the snapshot contract.
        // If the snapshot has no states yet, gracefully initialize fields to empty.
        try IMerkleSnapshot(newContract).getLatestState() returns (IMerkleSnapshot.MerkleState memory merkleState) {
            currentMerkleRoot = merkleState.root;
            ipfsHash = merkleState.ipfsHash;
            ipfsHashCid = merkleState.ipfsHashCid;
            totalVotingPower = merkleState.totalValue;
        } catch (bytes memory reason) {
            // Custom errors encode as: selector (4 bytes) + args.
            // NoMerkleStates has no args, so revert data is just the selector.
            if (reason.length == 4 && bytes4(reason) == IMerkleSnapshot.NoMerkleStates.selector) {
                currentMerkleRoot = bytes32(0);
                ipfsHash = bytes32(0);
                ipfsHashCid = "";
                totalVotingPower = 0;
            } else {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        emit MerkleSnapshotContractUpdated(previousContract, newContract);
    }
}
