// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IMerkleFundDistributor {
    /// @notice A distribution state.
    struct DistributionState {
        /// @notice The block number of the distribution creation.
        uint256 blockNumber;
        /// @notice The timestamp of the distribution creation.
        uint256 timestamp;
        /// @notice The merkle root of this distribution.
        bytes32 root;
        /// @notice The ipfs hash containing metadata about the root (e.g. the merkle tree itself).
        bytes32 ipfsHash;
        /// @notice The ipfs hash CID containing metadata about the root (e.g. the merkle tree itself).
        string ipfsHashCid;
        /// @notice The total value of the merkle tree.
        uint256 totalMerkleValue;
        /// @notice The distributor address.
        address distributor;
        /// @notice The token to distribute (0 for native token, otherwise an ERC20 token address).
        address token;
        /// @notice The total amount of the token funded.
        uint256 amountFunded;
        /// @notice The amount of the token distributed so far (excluding fee).
        uint256 amountDistributed;
        /// @notice The fee recipient address.
        address feeRecipient;
        /// @notice The amount of the token retained as a fee.
        uint256 feeAmount;
        /// @notice The timestamp after which claims close and sweeping opens (0 = no expiry; claims stay open forever and the distribution can never be swept).
        uint64 claimDeadline;
        /// @notice The amount of the token returned to the round funder by `sweep` (0 = not swept yet).
        uint256 sweptAmount;
    }

    /// @notice Emitted when owner starts 2-step ownership transfer to `pendingOwner`.
    /// @param pendingOwner The pending owner of the contract.
    event OwnershipTransferStarted(address indexed pendingOwner);

    /// @notice Emitted when the owner of the contract is set.
    /// @param previousOwner The previous owner of the contract.
    /// @param newOwner The new owner of the contract.
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    /// @notice Emitted when the fee recipient is set.
    /// @param previousFeeRecipient The previous fee recipient address.
    /// @param newFeeRecipient The new fee recipient address.
    event FeeRecipientSet(
        address indexed previousFeeRecipient,
        address indexed newFeeRecipient
    );

    /// @notice Emitted when the fee percentage is set.
    /// @param previousFeePercentage The previous fee percentage.
    /// @param newFeePercentage The new fee percentage.
    event FeePercentageSet(
        uint256 indexed previousFeePercentage,
        uint256 indexed newFeePercentage
    );

    /// @notice Emitted when the merkle snapshot contract is updated.
    /// @param previousContract The previous merkle snapshot contract address.
    /// @param newContract The new merkle snapshot contract address.
    event MerkleSnapshotUpdated(
        address indexed previousContract,
        address indexed newContract
    );

    /// @notice Emitted when a distributor's ability to distribute funds is updated.
    /// @param distributor The distributor address.
    /// @param canDistribute The distributor's ability to distribute funds.
    event DistributorAllowanceUpdated(
        address indexed distributor,
        bool indexed canDistribute
    );

    /// @notice Emitted when the distributor allowlist is enabled/disabled.
    /// @param enabled The distributor's allowlist status.
    event DistributorAllowlistUpdated(bool indexed enabled);

    /// @notice Emitted when funds are distributed.
    /// @param distributionIndex The index of the distribution.
    /// @param distributor The distributor address.
    /// @param token The token distributed.
    /// @param amountFunded The amount of token funded.
    /// @param feeAmount The amount of token retained as a fee.
    event Distributed(
        uint256 indexed distributionIndex,
        address indexed distributor,
        address indexed token,
        uint256 amountFunded,
        uint256 feeAmount
    );

    /// @notice Emitted when tokens are claimed.
    /// @param distributionIndex The index of the distribution.
    /// @param account The address that claimed the tokens.
    /// @param token The token claimed.
    /// @param amount The amount of token claimed.
    /// @param value The merkle tree value.
    /// @param newAmountDistributed The new total amount of tokens distributed after the claim.
    event Claimed(
        uint256 indexed distributionIndex,
        address indexed account,
        address indexed token,
        uint256 amount,
        uint256 value,
        uint256 newAmountDistributed
    );

    /// @notice Emitted when unclaimed funds are swept back to the round funder after the claim deadline.
    /// @param distributionIndex The index of the distribution swept.
    /// @param to The address that received the unclaimed funds (the round funder).
    /// @param amount The amount of unclaimed funds swept.
    event Swept(
        uint256 indexed distributionIndex,
        address indexed to,
        uint256 amount
    );

    error NotOwner();
    error NotPendingOwner();
    error InvalidAddress();
    error CannotDistribute();
    error InvalidNativeTokenTransfer();
    error InvalidNativeTokenTransferAmount();
    error AlreadyClaimed();
    error FailedToTransferFee(bytes data);
    error FailedToTransferTokens(bytes data);
    error InvalidMerkleState();
    error DistributionNotFound();
    error InvalidMerkleProof();
    error NoFundsToClaim();
    error FeePercentageTooHigh();
    error UnexpectedMerkleRoot(bytes32 expected, bytes32 actual);
    error InvalidClaimDeadline();
    error ClaimWindowClosed();
    error ClaimWindowNotClosed();
    error NoClaimDeadline();
    error AlreadySwept();
    error NothingToSweep();
}
