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
    error ExecutionDelayNotElapsed(uint256 executableAtBlock);
    error DelegateCallNotAllowed(address target);
    error ActionFailed(uint256 index);
    error SelfDelegation();
    error NotVoteDelegate(address principal, address caller);
    error VotingPowerMismatch(uint256 recorded, uint256 provided);
    error DelegateReasonTooLong(uint256 length);

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

    /// @notice A principal changed the one account allowed to cast provisional votes for them.
    /// @dev `newDelegate == address(0)` is revocation. Changing this mapping never erases a vote
    ///      already cast; only the principal can replace that vote through `castVote`.
    event VoteDelegateSet(address indexed principal, address indexed previousDelegate, address indexed newDelegate);

    /// @notice A delegate cast a provisional vote using the principal's snapshotted voting power.
    /// @dev `reason` is deliberately event-only: it is an auditable receipt, not contract state.
    event DelegateVoteCast(
        address indexed principal,
        uint256 indexed proposalId,
        address indexed delegate,
        VoteType voteType,
        uint256 votingPower,
        string reason
    );

    /// @notice The principal replaced a delegate-cast vote, making their own vote final.
    event VoteOverridden(
        address indexed principal,
        uint256 indexed proposalId,
        address indexed delegate,
        VoteType previousVoteType,
        VoteType newVoteType,
        uint256 votingPower
    );

    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    event QuorumUpdated(uint256 newQuorum);
    event VotingDelayUpdated(uint256 newDelay);
    event VotingPeriodUpdated(uint256 newPeriod);
    event ExecutionDelayUpdated(uint256 newDelay);
    event DelegateCallTargetSet(address indexed target, bool allowed);
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

    /// @notice The single account allowed to cast provisional votes for each principal.
    mapping(address principal => address delegate) public voteDelegate;

    /// @notice Whether the recorded vote is provisional because a delegate cast it.
    mapping(uint256 proposalId => mapping(address principal => bool)) public votedByDelegate;

    /// @notice Voting power recorded with a vote, needed for exact tally replacement.
    mapping(uint256 proposalId => mapping(address principal => uint256)) public votePower;

    /// @notice The delegate that cast a proposal's provisional vote (retained after override).
    mapping(uint256 proposalId => mapping(address principal => address)) public delegateVoter;

    /// @notice Governance parameters
    uint256 public votingDelay = 1; // blocks
    uint256 public votingPeriod = 50400; // ~1 week at 12s blocks
    uint256 public quorum = 4e16; // 4% in basis points (4e16 = 4% of 1e18)

    /// @notice Blocks between a proposal passing (endBlock) and becoming executable (M-4,
    ///         2026-08-13 audit). The exit window: a passed-but-hostile proposal cannot reach the
    ///         Safe's funds in the same block its voting closes. ~1 day by default; governance can
    ///         tune it, but there is deliberately no zero-delay fast path baked in.
    uint256 public executionDelay = 7200; // ~1 day at 12s blocks

    /// @notice Targets a proposal action may `DelegateCall` (M-4). A delegatecall executes
    ///         arbitrary code IN THE SAFE'S CONTEXT, bypassing any Guard and able to rewrite
    ///         module/owner storage — so it is deny-by-default and per-target allowlisted (e.g. a
    ///         reviewed MultiSendCallOnly). Checked at BOTH propose and execute time.
    mapping(address target => bool allowed) public delegateCallAllowlist;

    /// @notice The divisor for quorum calculations (quorum = QUORUM_RANGE = 100% quorum)
    uint256 public constant QUORUM_RANGE = 1e18;

    /// @notice Maximum UTF-8 byte length of the event-only delegate rationale.
    uint256 public constant MAX_DELEGATE_REASON_BYTES = 512;

    /// @notice Whether the module is initialized
    bool private _initialized;

    /// @notice Whether the initial snapshot binding has been announced (or superseded by a
    ///         rotation). Construction is deliberately SILENT: a streaming indexer discovers this
    ///         module from its factory's discovery event, and a constructor log would precede that
    ///         event inside the creating block — the exact ordering that wedged the indexer.
    ///         `publishInitialSnapshotBinding()` emits the announcement after discovery instead.
    bool public initialBindingPublished;

    /*///////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _owner, address _avatar, address _target, address _merkleSnapshot) {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        _transferOwnership(_owner);
        avatar = _avatar;
        target = _target;
        _setMerkleSnapshotContract(_merkleSnapshot, false);
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
        _setMerkleSnapshotContract(_merkleSnapshot, false);
    }

    /// @notice Announce the constructor-bound snapshot to streaming indexers. One-shot and
    ///         permissionless, mirroring the typed controllers' `publishInitialVersion()`: the
    ///         creating factory calls it AFTER its own discovery event so ordered indexers have
    ///         already materialized this module's row when the announcement arrives. A snapshot
    ///         rotation supersedes it (rotation makes its own announcement).
    function publishInitialSnapshotBinding() external {
        if (initialBindingPublished) revert AlreadyInitialized();
        initialBindingPublished = true;
        emit MerkleSnapshotContractUpdated(address(0), merkleSnapshotContract);
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

        bool alreadyVoted = hasVoted[proposalId][msg.sender];
        if (alreadyVoted && !votedByDelegate[proposalId][msg.sender]) revert AlreadyVoted();

        // Verify voter is in merkle tree (using proposal's snapshot)
        _verifyMerkleProof(msg.sender, votingPower, proposal.merkleRoot, proof);

        if (!alreadyVoted) {
            _castVote(proposalId, msg.sender, voteType, votingPower);
            return;
        }

        // Human votes are final. The sole exception is a principal replacing their own
        // delegate's provisional vote; that replacement can happen exactly once.
        _overrideDelegateVote(proposalId, msg.sender, voteType, votingPower);
    }

    /// @notice Set or revoke the one account allowed to cast provisional votes for the caller.
    /// @param delegate The delegate, or address(0) to revoke the current delegation.
    function setVoteDelegate(address delegate) external {
        if (delegate == msg.sender) revert SelfDelegation();

        address previousDelegate = voteDelegate[msg.sender];
        voteDelegate[msg.sender] = delegate;
        emit VoteDelegateSet(msg.sender, previousDelegate, delegate);
    }

    /// @notice Cast a provisional vote for a principal who delegated to the caller.
    /// @param principal The member whose merkle leaf supplies voting power.
    /// @param proposalId The proposal to vote on.
    /// @param voteType The provisional vote.
    /// @param votingPower The principal's power in the proposal-pinned root.
    /// @param proof The principal's proof against the proposal-pinned root.
    /// @param reason Human-readable analysis or rationale, emitted only in the receipt event.
    function castVoteAsDelegate(
        address principal,
        uint256 proposalId,
        VoteType voteType,
        uint256 votingPower,
        bytes32[] calldata proof,
        string calldata reason
    ) external {
        Proposal storage proposal = proposals[proposalId];
        if (state(proposalId) != ProposalState.Active) revert VotingClosed();
        if (voteDelegate[principal] != msg.sender) revert NotVoteDelegate(principal, msg.sender);
        if (hasVoted[proposalId][principal]) revert AlreadyVoted();
        if (bytes(reason).length > MAX_DELEGATE_REASON_BYTES) revert DelegateReasonTooLong(bytes(reason).length);

        _verifyMerkleProof(principal, votingPower, proposal.merkleRoot, proof);

        _castVote(proposalId, principal, voteType, votingPower);
        votedByDelegate[proposalId][principal] = true;
        delegateVoter[proposalId][principal] = msg.sender;
        emit DelegateVoteCast(principal, proposalId, msg.sender, voteType, votingPower, reason);
    }

    /// @notice Execute a successful proposal
    /// @param proposalId The proposal to execute
    /// @dev M-4: only after `executionDelay` blocks past the voting end — the exit window between
    ///      "passed" and "touching the Safe". M-8: a failed action REVERTS the whole execution
    ///      (the proposal stays Passed and retryable) instead of being silently swallowed while
    ///      the proposal is marked executed forever.
    function execute(uint256 proposalId) external {
        if (state(proposalId) != ProposalState.Passed) {
            revert ProposalNotPassed();
        }

        Proposal storage proposal = proposals[proposalId];
        uint256 executableAt = proposal.endBlock + executionDelay;
        if (block.number <= executableAt) revert ExecutionDelayNotElapsed(executableAt);

        proposal.executed = true;

        ProposalAction[] memory actions = proposalActions[proposalId];
        for (uint256 i = 0; i < actions.length; i++) {
            // Re-checked at execute time: the allowlist may have changed since propose (M-4).
            if (actions[i].operation == Operation.DelegateCall && !delegateCallAllowlist[actions[i].target]) {
                revert DelegateCallNotAllowed(actions[i].target);
            }
            bool ok = exec(actions[i].target, actions[i].value, actions[i].data, actions[i].operation);
            if (!ok) revert ActionFailed(i);
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
        // Quorum is a percentage of snapshotted totalVotingPower (e.g., 4e16 = 4%).
        // M-5 (2026-08-13 audit): abstain votes are EXCLUDED from the quorum sum. Counting them
        // let a tiny "for" minority pass a proposal whose participation was mostly abstentions —
        // quorum must measure decisive (yes/no) participation.
        uint256 decisiveVotes = proposal.yesVotes + proposal.noVotes;
        uint256 quorumThreshold = Math.mulDiv(proposal.totalVotingPower, proposal.quorumFraction, QUORUM_RANGE);
        if (decisiveVotes >= quorumThreshold && proposal.yesVotes > proposal.noVotes) {
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

    /// @notice Update the execution delay (M-4). Zero is allowed but is an explicit governance
    ///         decision to give up the exit window, never a default.
    function setExecutionDelay(uint256 newDelay) external onlyOwner {
        executionDelay = newDelay;
        emit ExecutionDelayUpdated(newDelay);
    }

    /// @notice Allow or revoke a `DelegateCall` target for proposal actions (M-4).
    function setDelegateCallTarget(address target_, bool allowed) external onlyOwner {
        if (target_ == address(0)) revert InvalidAddress();
        delegateCallAllowlist[target_] = allowed;
        emit DelegateCallTargetSet(target_, allowed);
    }

    /// @notice Update merkle snapshot contract
    function setMerkleSnapshotContract(address newContract) external onlyOwner {
        // A rotation announces itself; a later "initial" announcement would be stale and
        // out of order, so the one-shot publisher is consumed here too.
        initialBindingPublished = true;
        _setMerkleSnapshotContract(newContract, true);
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

        // M-4: DelegateCall runs in the Safe's context and bypasses any Guard — deny at the door
        // unless the target is explicitly allowlisted (re-checked at execute time).
        for (uint256 i = 0; i < targets.length; i++) {
            if (operations[i] == Operation.DelegateCall && !delegateCallAllowlist[targets[i]]) {
                revert DelegateCallNotAllowed(targets[i]);
            }
        }

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
        votePower[proposalId][voter] = votingPower;

        _addToTally(proposal, voteType, votingPower);

        emit VoteCast(voter, proposalId, voteType, votingPower);
    }

    /// @dev Replace one provisional vote without minting or burning voting power. The power must
    ///      equal the amount recorded from the same proposal-pinned root; rejecting an anomalous
    ///      duplicate leaf is safer than letting a replacement change total turnout.
    function _overrideDelegateVote(uint256 proposalId, address principal, VoteType newVoteType, uint256 votingPower)
        internal
    {
        uint256 recordedPower = votePower[proposalId][principal];
        if (recordedPower != votingPower) revert VotingPowerMismatch(recordedPower, votingPower);

        Proposal storage proposal = proposals[proposalId];
        VoteType previousVoteType = votes[proposalId][principal];
        address delegate = delegateVoter[proposalId][principal];

        _subtractFromTally(proposal, previousVoteType, recordedPower);
        _addToTally(proposal, newVoteType, recordedPower);

        votes[proposalId][principal] = newVoteType;
        votedByDelegate[proposalId][principal] = false;

        emit VoteOverridden(principal, proposalId, delegate, previousVoteType, newVoteType, recordedPower);
    }

    function _addToTally(Proposal storage proposal, VoteType voteType, uint256 votingPower) internal {
        if (voteType == VoteType.Yes) {
            proposal.yesVotes += votingPower;
        } else if (voteType == VoteType.No) {
            proposal.noVotes += votingPower;
        } else {
            proposal.abstainVotes += votingPower;
        }
    }

    function _subtractFromTally(Proposal storage proposal, VoteType voteType, uint256 votingPower) internal {
        if (voteType == VoteType.Yes) {
            proposal.yesVotes -= votingPower;
        } else if (voteType == VoteType.No) {
            proposal.noVotes -= votingPower;
        } else {
            proposal.abstainVotes -= votingPower;
        }
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
    /// @param emitEvent False only during construction/setUp: the state is bound and pulled
    ///        silently, and `publishInitialSnapshotBinding()` emits the announcement after the
    ///        factory's discovery event (discovery before children — see the field's docs).
    function _setMerkleSnapshotContract(address newContract, bool emitEvent) internal {
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
        if (emitEvent) emit MerkleSnapshotContractUpdated(previousContract, newContract);
    }
}
