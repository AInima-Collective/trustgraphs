// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";

/// @title MerkleFundDistributor
/// @notice A contract for distributing funds from a merkle tree.
/// @dev Expiry + sweep (resolved): each distribution may carry a `claimDeadline`
///      (0 = no expiry, the original behavior — such distributions can never be
///      swept). Claims are accepted while `block.timestamp <= claimDeadline`;
///      once `block.timestamp > claimDeadline` claims revert and anyone may call
///      `sweep(distributionIndex)` to return the unclaimed remainder
///      (`amountFunded - feeAmount - amountDistributed`, which also captures
///      per-claim rounding dust) to the round funder (`distribution.distributor`).
///      Claims closing strictly before sweeping opens makes a sweep-vs-late-claim
///      race structurally impossible.
/// @dev Open claim (resolved): `claim` is deliberately callable by anyone, but
///      funds always pay the leaf's `account` — they cannot be redirected. This
///      keeps claims relayable and works naturally for contributors that are
///      contracts (Safes, splitters): the distributor pays `account` directly,
///      which is how teams should claim shared work (or split via shares at
///      claim time).
contract MerkleFundDistributor is IMerkleFundDistributor, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /* CONSTANTS */

    /// @notice The range of the fee percentage.
    /// @dev 1e18 = 100%
    /// @dev 1e17 = 10%
    /// @dev 1e16 = 1%
    /// @dev 1e15 = 0.1%
    uint64 public constant FEE_RANGE = 1e18;

    /* STORAGE */

    /// @notice Address of the MerkleSnapshot contract to query for merkle state
    address public merkleSnapshot;

    /// @notice The address that can update the distribution parameters.
    address public owner;

    /// @notice The pending owner address (for 2-step ownership transfer).
    address public pendingOwner;

    /// @notice The fee recipient address.
    address public feeRecipient;

    /// @notice The fee percentage taken from the distributed amount.
    uint256 public feePercentage;

    /// @notice Whether the distributor allowlist is enabled.
    bool public allowlistEnabled;

    /// @notice The addresses allowed to distribute funds (if allowlist is enabled).
    EnumerableSet.AddressSet private _allowlist;

    /// @notice The distributions.
    DistributionState[] public distributions;

    /// @notice The `amount` claimed by `account` for a given distribution.
    mapping(uint256 distributionIndex => mapping(address account => uint256 amount)) public claimed;

    /* MODIFIERS */

    /// @notice Reverts if the caller is not the owner.
    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner();
        }
        _;
    }

    /// @notice Reverts if the caller cannot distribute funds.
    modifier onlyDistributor() {
        if (allowlistEnabled && !_allowlist.contains(msg.sender)) {
            revert CannotDistribute();
        }
        _;
    }

    /* CONSTRUCTOR */

    /**
     * @notice Initialize the contract
     * @param owner_ The owner of the contract
     * @param merkleSnapshot_ The MerkleSnapshot contract address
     * @param feeRecipient_ The fee recipient address
     * @param feePercentage_ The fee percentage taken from the distributed amount
     * @param allowlistEnabled_ Whether the distributor allowlist is enabled.
     */
    constructor(
        address owner_,
        address merkleSnapshot_,
        address feeRecipient_,
        uint256 feePercentage_,
        bool allowlistEnabled_
    ) {
        // Bootstrap ownership DIRECTLY, without the 2-step handshake. Two-step transfer exists to
        // stop a live owner from handing the contract to an address that cannot act; at
        // construction there is no live owner to protect, and the deployer is frequently a
        // factory or a script that must not linger as owner (`TrustgraphsFactory` deploys this in
        // the same transaction that hands the instance to its creator — a pending transfer would
        // leave the factory owning every community's distributor until each one remembered to
        // call `acceptOwnership`). `transferOwnership` after deployment is unchanged: still
        // 2-step. See research/DEVIATIONS.md.
        if (owner_ == address(0)) {
            revert InvalidAddress();
        }
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);

        _setMerkleSnapshot(merkleSnapshot_);
        _setFeeRecipient(feeRecipient_);
        _setFeePercentage(feePercentage_);
        _setAllowlistEnabled(allowlistEnabled_);
    }

    /* VIEW */

    /// @notice Gets a distribution by index.
    /// @param distributionIndex The index of the distribution.
    /// @return distribution The distribution.
    function getDistribution(uint256 distributionIndex) external view returns (DistributionState memory) {
        return distributions[distributionIndex];
    }

    /// @notice Gets paginated distributions.
    /// @param offset The offset to start from.
    /// @param limit The number of distributions to return.
    /// @return result The distributions.
    function getDistributions(uint256 offset, uint256 limit) external view returns (DistributionState[] memory) {
        if (offset >= distributions.length) {
            return new DistributionState[](0);
        }

        uint256 end = offset + limit;
        if (end > distributions.length) {
            end = distributions.length;
        }

        DistributionState[] memory result = new DistributionState[](end - offset);
        for (uint256 i = offset; i < end;) {
            result[i - offset] = distributions[i];
            unchecked {
                ++i;
            }
        }

        return result;
    }

    /// @notice Returns the total number of distributions.
    /// @return total The total number of distributions.
    function getDistributionCount() external view returns (uint256 total) {
        return distributions.length;
    }

    /// @notice Checks if an address is in the allowlist.
    /// @param distributor The address to check.
    /// @return True if the address is in the allowlist.
    function isAllowlisted(address distributor) external view returns (bool) {
        return _allowlist.contains(distributor);
    }

    /// @notice Returns the number of addresses in the allowlist.
    /// @return The allowlist length.
    function getAllowlistLength() external view returns (uint256) {
        return _allowlist.length();
    }

    /// @notice Returns the address at a given index in the allowlist.
    /// @param index The index to query.
    /// @return The address at the index.
    function getAllowlistAt(uint256 index) external view returns (address) {
        return _allowlist.at(index);
    }

    /// @notice Returns all addresses in the allowlist.
    /// @return All allowlisted addresses.
    function getAllowlist() external view returns (address[] memory) {
        return _allowlist.values();
    }

    /// @notice Returns paginated addresses in the allowlist.
    /// @param offset The offset to start from.
    /// @param limit The number of addresses to return.
    /// @return result The allowlisted addresses.
    function getAllowlistPaginated(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 length = _allowlist.length();
        if (offset >= length) {
            return new address[](0);
        }

        uint256 end = offset + limit;
        if (end > length) {
            end = length;
        }

        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end;) {
            result[i - offset] = _allowlist.at(i);
            unchecked {
                ++i;
            }
        }

        return result;
    }

    /* EXTERNAL */

    /// @notice Starts 2-step ownership transfer to `newOwner`.
    /// @param newOwner The new owner of the contract.
    function transferOwnership(address newOwner) external onlyOwner {
        _transferOwnership(newOwner);
    }

    /// @notice Accepts the ownership transfer.
    /// @dev Only the pending owner can accept the ownership transfer.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) {
            revert NotPendingOwner();
        }
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    /// @notice Sets the `feeRecipient` of the contract to `newFeeRecipient`.
    /// @param newFeeRecipient The new fee recipient address.
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        _setFeeRecipient(newFeeRecipient);
    }

    /// @notice Sets the `feePercentage` of the contract to `newFeePercentage`.
    /// @param newFeePercentage The new fee percentage.
    function setFeePercentage(uint256 newFeePercentage) external onlyOwner {
        _setFeePercentage(newFeePercentage);
    }

    /// @notice Sets the `merkleSnapshot` of the contract to `newMerkleSnapshot`.
    /// @param newMerkleSnapshot The new merkle snapshot contract address.
    function setMerkleSnapshot(address newMerkleSnapshot) external onlyOwner {
        _setMerkleSnapshot(newMerkleSnapshot);
    }

    /// @notice Sets the `allowlistEnabled` of the contract to `allowlistEnabled_`.
    /// @param allowlistEnabled_ Whether the distributor allowlist is enabled.
    function setAllowlistEnabled(bool allowlistEnabled_) external onlyOwner {
        _setAllowlistEnabled(allowlistEnabled_);
    }

    /// @notice Updates a distributor's ability to distribute funds.
    /// @param distributor The distributor address.
    /// @param canDistribute_ The distributor's ability to distribute funds.
    function updateDistributorAllowance(address distributor, bool canDistribute_) external onlyOwner {
        if (canDistribute_) {
            _allowlist.add(distributor);
        } else {
            _allowlist.remove(distributor);
        }
        emit DistributorAllowanceUpdated(distributor, canDistribute_);
    }

    /// @notice Pauses the contract.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses the contract.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Distributes funds with no claim deadline (claims stay open forever, never sweepable).
    /// @param token The token to distribute.
    /// @param amount The amount of token to distribute.
    /// @param expectedRoot The expected root of the merkle tree to add an additional layer of security (pass 0 to skip).
    /// @dev Only distributors can distribute funds.
    /// @return distributionIndex The index of the distribution.
    function distribute(address token, uint256 amount, bytes32 expectedRoot)
        external
        payable
        onlyDistributor
        nonReentrant
        whenNotPaused
        returns (uint256 distributionIndex)
    {
        return _distribute(token, amount, expectedRoot, 0);
    }

    /// @notice Distributes funds with a claim deadline.
    /// @param token The token to distribute.
    /// @param amount The amount of token to distribute.
    /// @param expectedRoot The expected root of the merkle tree to add an additional layer of security (pass 0 to skip).
    /// @param claimDeadline The timestamp after which claims close and the unclaimed remainder can be swept back to the funder (0 = no expiry).
    /// @dev Only distributors can distribute funds.
    /// @return distributionIndex The index of the distribution.
    function distribute(address token, uint256 amount, bytes32 expectedRoot, uint64 claimDeadline)
        external
        payable
        onlyDistributor
        nonReentrant
        whenNotPaused
        returns (uint256 distributionIndex)
    {
        if (claimDeadline != 0 && claimDeadline <= block.timestamp) {
            revert InvalidClaimDeadline();
        }

        return _distribute(token, amount, expectedRoot, claimDeadline);
    }

    /// @dev Creates a distribution and moves the funds. Shared by both `distribute` overloads.
    function _distribute(address token, uint256 amount, bytes32 expectedRoot, uint64 claimDeadline)
        internal
        returns (uint256 distributionIndex)
    {
        // Fetch the latest merkle state.
        IMerkleSnapshot.MerkleState memory merkleState = IMerkleSnapshot(merkleSnapshot).getLatestState();

        if (merkleState.root == bytes32(0) || merkleState.totalValue == 0) {
            revert InvalidMerkleState();
        }

        if (expectedRoot != bytes32(0) && merkleState.root != expectedRoot) {
            revert UnexpectedMerkleRoot(expectedRoot, merkleState.root);
        }

        bool isNativeToken = _isNativeToken(token);

        // Move the funds in FIRST, then book what the contract actually received. All distributions
        // of a given token share one balance, so booking the requested `amount` for a fee-on-transfer
        // or deflationary token would let this distribution's claims/sweep draw on sibling
        // distributions' funds. `funded` is the measured balance delta (exact for native ETH).
        uint256 funded;
        if (isNativeToken) {
            // Ensure the native token amount sent is correct.
            if (msg.value != amount) {
                revert InvalidNativeTokenTransferAmount();
            }
            funded = amount;
        } else {
            // Ensure no native token is sent along with the ERC20 token.
            if (msg.value > 0) {
                revert InvalidNativeTokenTransfer();
            }

            // Transfer ERC20 from the sender to this distributor contract, measuring the delta so a
            // fee-on-transfer/deflationary token books only what actually arrived.
            uint256 balanceBefore = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            funded = IERC20(token).balanceOf(address(this)) - balanceBefore;
        }

        // Calculate the fee amount from the funded (received) amount, not the requested amount.
        uint256 feeAmount = Math.mulDiv(funded, feePercentage, FEE_RANGE);

        // Create new distribution.
        distributionIndex = distributions.length;
        distributions.push(
            DistributionState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: merkleState.root,
                ipfsHash: merkleState.ipfsHash,
                ipfsHashCid: merkleState.ipfsHashCid,
                totalMerkleValue: merkleState.totalValue,
                distributor: msg.sender,
                token: token,
                amountFunded: funded,
                amountDistributed: 0,
                feeRecipient: feeRecipient,
                feeAmount: feeAmount,
                claimDeadline: claimDeadline,
                sweptAmount: 0
            })
        );

        // Pay the fee. Skip a zero-value transfer so a revert-on-zero token can't block distribution.
        if (feeAmount > 0) {
            if (isNativeToken) {
                (bool success, bytes memory data) = payable(feeRecipient).call{value: feeAmount}("");
                if (!success) {
                    revert FailedToTransferFee(data);
                }
            } else {
                IERC20(token).safeTransfer(feeRecipient, feeAmount);
            }
        }

        emit Distributed(distributionIndex, msg.sender, token, funded, feeAmount);
    }

    /// @notice Claims tokens for a given distribution.
    /// @param distributionIndex The index of the distribution to claim tokens for.
    /// @param account The address to claim tokens for.
    /// @param value The merkle tree value.
    /// @param proof The merkle proof that validates this claim.
    /// @return claimedAmount The amount of tokens claimed.
    /// @dev Anyone can claim tokens on behalf of an account.
    function claim(uint256 distributionIndex, address account, uint256 value, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 claimedAmount)
    {
        if (distributionIndex >= distributions.length) {
            revert DistributionNotFound();
        }

        if (account == address(0)) {
            revert InvalidAddress();
        }

        // Fetch the distribution.
        DistributionState storage distribution = distributions[distributionIndex];
        bytes32 root = distribution.root;
        if (root == bytes32(0)) {
            revert DistributionNotFound();
        }

        // Claims close strictly after the deadline (deadline 0 = no expiry).
        uint64 claimDeadline = distribution.claimDeadline;
        if (claimDeadline != 0 && block.timestamp > claimDeadline) {
            revert ClaimWindowClosed();
        }

        // Verify the account has not already claimed tokens for this distribution.
        if (claimed[distributionIndex][account] > 0) {
            revert AlreadyClaimed();
        }

        // Verify the merkle proof.
        if (!MerkleProof.verifyCalldata(proof, root, keccak256(bytes.concat(keccak256(abi.encode(account, value)))))) {
            revert InvalidMerkleProof();
        }

        uint256 totalDistributable = distribution.amountFunded - distribution.feeAmount;

        // Calculate the amount of distributable tokens to claim (proportional to value / total merkle value).
        claimedAmount = Math.mulDiv(totalDistributable, value, distribution.totalMerkleValue);

        if (claimedAmount == 0) {
            revert NoFundsToClaim();
        }

        claimed[distributionIndex][account] = claimedAmount;
        distribution.amountDistributed += claimedAmount;

        // Transfer tokens to the account.
        if (_isNativeToken(distribution.token)) {
            (bool success, bytes memory data) = payable(account).call{value: claimedAmount}("");
            if (!success) {
                revert FailedToTransferTokens(data);
            }
        } else {
            IERC20(distribution.token).safeTransfer(account, claimedAmount);
        }

        emit Claimed(
            distributionIndex, account, distribution.token, claimedAmount, value, distribution.amountDistributed
        );
    }

    /// @notice Sweeps the unclaimed remainder of an expired distribution back to the round funder.
    /// @param distributionIndex The index of the distribution to sweep.
    /// @return sweptAmount The amount of unclaimed funds returned to the funder.
    /// @dev Permissionless: anyone may trigger the sweep, but funds always go to
    ///      `distribution.distributor` (the round funder). Only callable once the
    ///      claim window has closed (`claimDeadline != 0 && block.timestamp > claimDeadline`),
    ///      so a sweep can never race a valid claim.
    function sweep(uint256 distributionIndex) external nonReentrant whenNotPaused returns (uint256 sweptAmount) {
        if (distributionIndex >= distributions.length) {
            revert DistributionNotFound();
        }

        // Fetch the distribution.
        DistributionState storage distribution = distributions[distributionIndex];
        if (distribution.root == bytes32(0)) {
            revert DistributionNotFound();
        }

        // Distributions without a deadline can never be swept.
        uint64 claimDeadline = distribution.claimDeadline;
        if (claimDeadline == 0) {
            revert NoClaimDeadline();
        }

        // The claim window must be closed (claims are accepted while timestamp <= deadline).
        if (block.timestamp <= claimDeadline) {
            revert ClaimWindowNotClosed();
        }

        // Only sweep once.
        if (distribution.sweptAmount != 0) {
            revert AlreadySwept();
        }

        // Unclaimed remainder, including per-claim rounding dust.
        sweptAmount = distribution.amountFunded - distribution.feeAmount - distribution.amountDistributed;
        if (sweptAmount == 0) {
            revert NothingToSweep();
        }

        distribution.sweptAmount = sweptAmount;
        address to = distribution.distributor;

        // Transfer the unclaimed funds back to the round funder.
        if (_isNativeToken(distribution.token)) {
            (bool success, bytes memory data) = payable(to).call{value: sweptAmount}("");
            if (!success) {
                revert FailedToTransferTokens(data);
            }
        } else {
            IERC20(distribution.token).safeTransfer(to, sweptAmount);
        }

        emit Swept(distributionIndex, to, sweptAmount);
    }

    /* INTERNAL */

    /// @dev Starts 2-step ownership transfer to `newOwner`.
    function _transferOwnership(address newOwner) internal {
        if (newOwner == address(0)) {
            revert InvalidAddress();
        }

        pendingOwner = newOwner;
        emit OwnershipTransferStarted(newOwner);
    }

    /// @dev Sets the `feeRecipient` of the contract to `newFeeRecipient`.
    function _setFeeRecipient(address newFeeRecipient) internal {
        if (newFeeRecipient == address(0)) {
            revert InvalidAddress();
        }

        address previousFeeRecipient = feeRecipient;
        feeRecipient = newFeeRecipient;
        emit FeeRecipientSet(previousFeeRecipient, newFeeRecipient);
    }

    /// @dev Sets the `feePercentage` of the contract to `newFeePercentage`.
    function _setFeePercentage(uint256 newFeePercentage) internal {
        if (newFeePercentage > FEE_RANGE) {
            revert FeePercentageTooHigh();
        }

        uint256 previousFeePercentage = feePercentage;
        feePercentage = newFeePercentage;
        emit FeePercentageSet(previousFeePercentage, newFeePercentage);
    }

    /// @dev Sets the `merkleSnapshot` of the contract to `newMerkleSnapshot`.
    function _setMerkleSnapshot(address newMerkleSnapshot) internal {
        if (newMerkleSnapshot == address(0)) {
            revert InvalidAddress();
        }

        address previousMerkleSnapshot = merkleSnapshot;
        merkleSnapshot = newMerkleSnapshot;
        emit MerkleSnapshotUpdated(previousMerkleSnapshot, newMerkleSnapshot);
    }

    /// @dev Sets the `allowlistEnabled` of the contract to `allowlistEnabled_`.
    function _setAllowlistEnabled(bool allowlistEnabled_) internal {
        allowlistEnabled = allowlistEnabled_;
        emit DistributorAllowlistUpdated(allowlistEnabled_);
    }

    /// @dev Whether or not the token is a native token.
    function _isNativeToken(address token) internal pure returns (bool) {
        return token == address(0);
    }
}
