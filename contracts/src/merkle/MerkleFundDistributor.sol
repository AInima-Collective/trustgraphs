// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
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
contract MerkleFundDistributor is IMerkleFundDistributor, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /* CONSTANTS */

    /// @notice The range of the fee percentage.
    /// @dev 1e18 = 100%
    /// @dev 1e17 = 10%
    /// @dev 1e16 = 1%
    /// @dev 1e15 = 0.1%
    uint64 public constant FEE_RANGE = 1e18;

    /// @notice Delay before a scheduled fee-percentage INCREASE takes effect (M-7, 2026-08-13
    ///         audit): the owner could `setFeePercentage(100%)` in front of a funder's
    ///         `distribute` and capture the whole round. Increases now announce themselves and
    ///         wait; decreases and recipient changes stay immediate (they cannot take a funder's
    ///         money). Funders wanting a per-round guarantee also have the guarded `distribute`
    ///         overload with `maxFeeAmount` / `expectedFeeRecipient`.
    uint64 public constant FEE_INCREASE_DELAY = 3 days;

    /* STORAGE */

    /// @notice Address of the MerkleSnapshot contract to query for merkle state
    address public merkleSnapshot;

    /// @notice The fee recipient address.
    address public feeRecipient;

    /// @notice The fee percentage taken from the distributed amount.
    uint256 public feePercentage;

    /// @notice A scheduled fee-percentage increase (M-7). Zero `pendingFeeEffectiveAt` = none.
    uint256 public pendingFeePercentage;
    uint64 public pendingFeeEffectiveAt;

    /// @notice Whether the distributor allowlist is enabled.
    bool public allowlistEnabled;

    /// @notice The addresses allowed to distribute funds (if allowlist is enabled).
    EnumerableSet.AddressSet private _allowlist;

    /// @notice The distributions.
    DistributionState[] public distributions;

    /// @notice The `amount` claimed by `account` for a given distribution.
    mapping(uint256 distributionIndex => mapping(address account => uint256 amount)) public claimed;

    /* MODIFIERS */

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
    ) Ownable(owner_) {
        // Ownership bootstraps DIRECTLY (`Ownable(owner_)`), without the 2-step handshake.
        // Two-step transfer exists to stop a live owner from handing the contract to an address
        // that cannot act; at construction there is no live owner to protect, and the deployer is
        // frequently a factory that must not linger as owner (`TrustgraphsFactory` deploys this
        // in the same transaction that hands the instance to its creator). Post-deploy
        // `transferOwnership` remains 2-step via `Ownable2Step`.
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

    /// @notice Returns all addresses in the allowlist.
    /// @return All allowlisted addresses.
    function getAllowlist() external view returns (address[] memory) {
        return _allowlist.values();
    }

    /* EXTERNAL */

    /// @notice Renouncing is disabled: fee, pause, and allowlist authority must always exist.
    function renounceOwnership() public view override onlyOwner {
        revert InvalidAddress();
    }

    /// @notice Sets the `feeRecipient` of the contract to `newFeeRecipient`.
    /// @param newFeeRecipient The new fee recipient address.
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        _setFeeRecipient(newFeeRecipient);
    }

    /// @notice Sets the `feePercentage` of the contract to `newFeePercentage`.
    /// @param newFeePercentage The new fee percentage.
    /// @dev M-7: a DECREASE applies immediately (it cannot take a funder's money); an INCREASE is
    ///      only scheduled here — it becomes claimable via `applyFeePercentageIncrease` after
    ///      `FEE_INCREASE_DELAY`, so a funder always has time to see it coming.
    function setFeePercentage(uint256 newFeePercentage) external onlyOwner {
        if (newFeePercentage <= feePercentage) {
            // Cancels any scheduled increase too: the owner has picked a lower fee.
            pendingFeePercentage = 0;
            pendingFeeEffectiveAt = 0;
            _setFeePercentage(newFeePercentage);
        } else {
            if (newFeePercentage > FEE_RANGE) {
                revert FeePercentageTooHigh();
            }
            pendingFeePercentage = newFeePercentage;
            pendingFeeEffectiveAt = uint64(block.timestamp) + FEE_INCREASE_DELAY;
            emit FeePercentageIncreaseScheduled(newFeePercentage, pendingFeeEffectiveAt);
        }
    }

    /// @notice Applies a scheduled fee-percentage increase once its delay has elapsed (M-7).
    ///         Callable by anyone — the schedule, not the caller, is the authority.
    function applyFeePercentageIncrease() external {
        uint64 effectiveAt = pendingFeeEffectiveAt;
        if (effectiveAt == 0) {
            revert NoScheduledFeeIncrease();
        }
        if (block.timestamp < effectiveAt) {
            revert FeeIncreaseNotYetEffective(effectiveAt);
        }
        uint256 newFeePercentage = pendingFeePercentage;
        pendingFeePercentage = 0;
        pendingFeeEffectiveAt = 0;
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

    /// @notice Pauses new distributions and claims.
    /// @dev Expired sweeps remain available so pausing cannot remove a funder's only exit.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses the contract.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Distributes funds against fully pinned state. Every guard is mandatory: the round
    ///         reverts unless the root, the payout denominator, the fee recipient and the fee the
    ///         funder was shown are all still exactly what they were when the funder decided.
    /// @dev There is deliberately no unguarded overload. A funder always reads the state it is
    ///      funding against, so "skip this check" is an option with no legitimate caller and one
    ///      obvious wrong caller: the convenient one. `feeRecipient` can never be zero
    ///      (`_setFeeRecipient`), so a zero `expectedFeeRecipient` is a caller that forgot rather
    ///      than a caller that opted out, and is rejected as such.
    /// @param token The token to distribute.
    /// @param amount The amount of token to distribute.
    /// @param expectedRoot The merkle root the funder is funding against.
    /// @param expectedTotalMerkleValue The payout denominator committed by that root.
    /// @param claimDeadline The timestamp after which claims close (0 = no expiry, never sweepable).
    /// @param maxFeeAmount The most the funder will pay in fees, in token units.
    /// @param expectedFeeRecipient The fee recipient the funder is agreeing to pay.
    /// @return distributionIndex The index of the distribution.
    function distribute(
        address token,
        uint256 amount,
        bytes32 expectedRoot,
        uint256 expectedTotalMerkleValue,
        uint64 claimDeadline,
        uint256 maxFeeAmount,
        address expectedFeeRecipient
    ) external payable onlyDistributor nonReentrant whenNotPaused returns (uint256 distributionIndex) {
        if (claimDeadline != 0 && claimDeadline <= block.timestamp) {
            revert InvalidClaimDeadline();
        }
        if (expectedFeeRecipient == address(0) || feeRecipient != expectedFeeRecipient) {
            revert UnexpectedFeeRecipient(expectedFeeRecipient, feeRecipient);
        }
        // Pre-check against the requested amount (covers native exactly; for fee-on-transfer
        // tokens the funded amount can only be LOWER, so the real fee can only be lower too).
        uint256 wouldPay = Math.mulDiv(amount, feePercentage, FEE_RANGE);
        if (wouldPay > maxFeeAmount) {
            revert FeeExceedsFunderCap(wouldPay, maxFeeAmount);
        }

        return _distribute(token, amount, expectedRoot, expectedTotalMerkleValue, claimDeadline);
    }

    /// @dev Creates a distribution and moves the funds. Both state pins are unconditional: a live
    ///      root is never zero (`InvalidMerkleState` above), so a zero `expectedRoot` fails the
    ///      equality check rather than skipping it.
    function _distribute(
        address token,
        uint256 amount,
        bytes32 expectedRoot,
        uint256 expectedTotalMerkleValue,
        uint64 claimDeadline
    ) internal returns (uint256 distributionIndex) {
        // Fetch the latest merkle state.
        IMerkleSnapshot.MerkleState memory merkleState = IMerkleSnapshot(merkleSnapshot).getLatestState();

        if (merkleState.root == bytes32(0) || merkleState.totalValue == 0) {
            revert InvalidMerkleState();
        }

        if (merkleState.root != expectedRoot) {
            revert UnexpectedMerkleRoot(expectedRoot, merkleState.root);
        }

        if (merkleState.totalValue != expectedTotalMerkleValue) {
            revert UnexpectedMerkleTotalValue(expectedTotalMerkleValue, merkleState.totalValue);
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

        // A malformed or malicious (root, totalValue) pair must never let this round spend funds
        // booked for a sibling round of the same token. `distribute` already pins the pair, so this
        // cap is the backstop for the case the pin cannot cover: a compromised snapshot source that
        // reports a consistent-but-wrong pair to funder and contract alike.
        uint256 amountDistributed = distribution.amountDistributed;
        uint256 remainingBudget = amountDistributed >= totalDistributable ? 0 : totalDistributable - amountDistributed;
        if (claimedAmount > remainingBudget) {
            revert ClaimExceedsRoundBudget(claimedAmount, remainingBudget);
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
    function sweep(uint256 distributionIndex) external nonReentrant returns (uint256 sweptAmount) {
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

        // Unclaimed remainder, including per-claim rounding dust. Claims enforce the same
        // per-round budget, and the explicit comparison keeps this path free of checked-arithmetic
        // underflow even if an impossible over-distributed state is encountered.
        uint256 totalDistributable = distribution.amountFunded - distribution.feeAmount;
        if (distribution.amountDistributed >= totalDistributable) {
            revert NothingToSweep();
        }
        sweptAmount = totalDistributable - distribution.amountDistributed;

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
