// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {RoundPins} from "test/helpers/RoundPins.sol";
import {MerkleFundDistributor} from "../../src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract MerkleFundDistributorTest is Test {
    MerkleFundDistributor public distributor;
    MockMerkleSnapshot public mockMerkleSnapshot;
    MockERC20 public mockToken;

    // Test addresses
    address public owner = address(0x1);
    address public feeRecipient = address(0x2);
    address public alice = address(0x3);
    address public bob = address(0x4);
    address public charlie = address(0x5);

    // Test constants
    uint256 public constant DEFAULT_FEE_PERCENTAGE = 1e16; // 1%
    uint256 public constant FEE_RANGE = 1e18;

    // Test merkle data
    bytes32 public constant TEST_ROOT = bytes32(uint256(0x1234567890abcdef));
    bytes32 public constant TEST_IPFS_HASH = bytes32(uint256(0x1111111111111111));
    string public constant TEST_IPFS_CID = "QmTest1";
    uint256 public constant TEST_TOTAL_VALUE = 1000;

    function setUp() public {
        mockMerkleSnapshot = new MockMerkleSnapshot();
        mockToken = new MockERC20("Test Token", "TEST");

        // Set up default merkle state
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: TEST_ROOT,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: TEST_TOTAL_VALUE
            })
        );

        vm.prank(owner);
        distributor = new MerkleFundDistributor(
            owner,
            address(mockMerkleSnapshot),
            feeRecipient,
            DEFAULT_FEE_PERCENTAGE,
            false // allowlist disabled
        );

        // Fund test accounts
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);
        mockToken.mint(alice, 1000 ether);
        mockToken.mint(bob, 1000 ether);
    }

    /* ========== CONSTRUCTOR TESTS ========== */

    function test_Constructor_InitializesWithDeployerAsOwner() public {
        vm.prank(alice);
        MerkleFundDistributor newDistributor = new MerkleFundDistributor(
            alice, // same as deployer
            address(mockMerkleSnapshot),
            feeRecipient,
            DEFAULT_FEE_PERCENTAGE,
            false
        );
        assertEq(newDistributor.owner(), alice);
        assertEq(newDistributor.pendingOwner(), address(0));
    }

    /// Bootstrap ownership is DIRECT, not a 2-step handshake: a factory (or script) that deploys a
    /// distributor on someone else's behalf must not linger as its owner. Post-deployment
    /// `transferOwnership` is still 2-step — see `test_TransferOwnership_*`.
    function test_Constructor_SetsOwnerDirectlyWhenOwnerDiffersFromDeployer() public {
        vm.prank(alice);
        MerkleFundDistributor newDistributor = new MerkleFundDistributor(
            bob, // different from deployer (alice)
            address(mockMerkleSnapshot),
            feeRecipient,
            DEFAULT_FEE_PERCENTAGE,
            false
        );
        assertEq(newDistributor.owner(), bob); // bob owns it outright
        assertEq(newDistributor.pendingOwner(), address(0)); // nothing left pending
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MerkleFundDistributor(address(0), address(mockMerkleSnapshot), feeRecipient, DEFAULT_FEE_PERCENTAGE, false);
    }

    function test_Constructor_RevertsOnZeroMerkleSnapshot() public {
        vm.expectRevert(IMerkleFundDistributor.InvalidAddress.selector);
        new MerkleFundDistributor(owner, address(0), feeRecipient, DEFAULT_FEE_PERCENTAGE, false);
    }

    function test_Constructor_RevertsOnZeroFeeRecipient() public {
        vm.expectRevert(IMerkleFundDistributor.InvalidAddress.selector);
        new MerkleFundDistributor(owner, address(mockMerkleSnapshot), address(0), DEFAULT_FEE_PERCENTAGE, false);
    }

    function test_Constructor_RevertsOnFeePercentageTooHigh() public {
        vm.expectRevert(IMerkleFundDistributor.FeePercentageTooHigh.selector);
        new MerkleFundDistributor(owner, address(mockMerkleSnapshot), feeRecipient, FEE_RANGE + 1, false);
    }

    function test_Constructor_SetsAllParameters() public view {
        assertEq(distributor.owner(), owner);
        assertEq(distributor.merkleSnapshot(), address(mockMerkleSnapshot));
        assertEq(distributor.feeRecipient(), feeRecipient);
        assertEq(distributor.feePercentage(), DEFAULT_FEE_PERCENTAGE);
        assertEq(distributor.allowlistEnabled(), false);
    }

    /* ========== OWNERSHIP TESTS ========== */

    function test_TransferOwnership_SetsNewPendingOwner() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit Ownable2Step.OwnershipTransferStarted(owner, alice);
        distributor.transferOwnership(alice);

        assertEq(distributor.pendingOwner(), alice);
        assertEq(distributor.owner(), owner); // owner unchanged
    }

    function test_TransferOwnership_RevertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.transferOwnership(bob);
    }

    function test_TransferOwnership_ToZeroCancelsThePendingHandshake() public {
        vm.prank(owner);
        distributor.transferOwnership(alice);
        vm.prank(owner);
        distributor.transferOwnership(address(0));
        assertEq(distributor.pendingOwner(), address(0));
        assertEq(distributor.owner(), owner);
    }

    function test_RenounceOwnership_IsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(IMerkleFundDistributor.InvalidAddress.selector);
        distributor.renounceOwnership();
    }

    function test_AcceptOwnership_TransfersOwnership() public {
        vm.prank(owner);
        distributor.transferOwnership(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, false);
        emit Ownable.OwnershipTransferred(owner, alice);
        distributor.acceptOwnership();

        assertEq(distributor.owner(), alice);
        assertEq(distributor.pendingOwner(), address(0));
    }

    function test_AcceptOwnership_RevertsIfNotPendingOwner() public {
        vm.prank(owner);
        distributor.transferOwnership(alice);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        distributor.acceptOwnership();
    }

    /* ========== ADMIN SETTER TESTS ========== */

    function test_SetFeeRecipient_UpdatesValue() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit IMerkleFundDistributor.FeeRecipientSet(feeRecipient, alice);
        distributor.setFeeRecipient(alice);

        assertEq(distributor.feeRecipient(), alice);
    }

    function test_SetFeeRecipient_RevertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setFeeRecipient(bob);
    }

    function test_SetFeeRecipient_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(IMerkleFundDistributor.InvalidAddress.selector);
        distributor.setFeeRecipient(address(0));
    }

    function test_SetFeePercentage_IncreaseIsScheduledThenApplied() public {
        // M-7: an INCREASE is scheduled, not immediate — the owner cannot front-run a funder.
        uint256 newFee = 5e16; // 5%
        uint64 delay = distributor.FEE_INCREASE_DELAY();
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IMerkleFundDistributor.FeePercentageIncreaseScheduled(newFee, uint64(block.timestamp) + delay);
        distributor.setFeePercentage(newFee);
        assertEq(distributor.feePercentage(), DEFAULT_FEE_PERCENTAGE, "increase must not be immediate");
        assertEq(distributor.pendingFeePercentage(), newFee);

        // Not yet effective.
        vm.expectRevert(
            abi.encodeWithSelector(
                IMerkleFundDistributor.FeeIncreaseNotYetEffective.selector, uint64(block.timestamp) + delay
            )
        );
        distributor.applyFeePercentageIncrease();

        // After the delay anyone can apply it.
        vm.warp(block.timestamp + delay);
        vm.expectEmit(true, true, false, false);
        emit IMerkleFundDistributor.FeePercentageSet(DEFAULT_FEE_PERCENTAGE, newFee);
        distributor.applyFeePercentageIncrease();
        assertEq(distributor.feePercentage(), newFee);
        assertEq(distributor.pendingFeeEffectiveAt(), 0, "schedule consumed");
    }

    function test_SetFeePercentage_DecreaseIsImmediateAndCancelsPending() public {
        // M-7: a decrease cannot take a funder's money, so it applies at once — and it cancels
        // any scheduled increase (the owner picked a lower fee).
        vm.startPrank(owner);
        distributor.setFeePercentage(5e16); // scheduled increase
        assertEq(distributor.pendingFeePercentage(), 5e16);

        uint256 lower = 5e15; // 0.5% < current 1%
        vm.expectEmit(true, true, false, false);
        emit IMerkleFundDistributor.FeePercentageSet(DEFAULT_FEE_PERCENTAGE, lower);
        distributor.setFeePercentage(lower);
        vm.stopPrank();
        assertEq(distributor.feePercentage(), lower);
        assertEq(distributor.pendingFeePercentage(), 0, "pending increase cancelled");
        assertEq(distributor.pendingFeeEffectiveAt(), 0);

        vm.expectRevert(IMerkleFundDistributor.NoScheduledFeeIncrease.selector);
        distributor.applyFeePercentageIncrease();
    }

    /// M-7 regression: the exact audit exploit — owner sets 100% fee in front of a funder's
    /// distribute. The increase is only scheduled, so the round pays the OLD fee.
    function test_M7_OwnerCannotFrontRunDistributeWithFeeHike() public {
        vm.prank(owner);
        distributor.setFeePercentage(FEE_RANGE); // "100%" — front-running attempt

        uint256 amount = 100 ether;
        _createERC20Distribution(alice, amount);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(
            dist.feeAmount,
            Math.mulDiv(amount, DEFAULT_FEE_PERCENTAGE, FEE_RANGE),
            "REGRESSION: the scheduled hike must not touch this round"
        );
    }

    /// M-7: the funder-guarded overload rejects a fee above the funder's cap or an unexpected
    /// recipient, and passes when the terms are as agreed.
    /// The unguarded overloads are gone, and so are the "pass 0 to skip" escapes inside the one
    /// remaining form. A live root is never zero and `feeRecipient` can never be zero, so a zero in
    /// either slot is a caller that forgot rather than one that opted out.
    function test_Distribute_RejectsZeroRootInsteadOfSkippingTheCheck() public {
        uint256 amount = 100 ether;
        vm.startPrank(alice);
        mockToken.approve(address(distributor), amount);
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.UnexpectedMerkleRoot.selector, bytes32(0), TEST_ROOT)
        );
        distributor.distribute(
            address(mockToken), amount, bytes32(0), TEST_TOTAL_VALUE, 0, type(uint256).max, feeRecipient
        );
        vm.stopPrank();
    }

    function test_Distribute_RejectsZeroFeeRecipientInsteadOfSkippingTheCheck() public {
        uint256 amount = 100 ether;
        vm.startPrank(alice);
        mockToken.approve(address(distributor), amount);
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.UnexpectedFeeRecipient.selector, address(0), feeRecipient)
        );
        distributor.distribute(
            address(mockToken), amount, TEST_ROOT, TEST_TOTAL_VALUE, 0, type(uint256).max, address(0)
        );
        vm.stopPrank();
    }

    function test_M7_FunderGuardedDistribute() public {
        uint256 amount = 100 ether;
        uint256 expectedFee = Math.mulDiv(amount, DEFAULT_FEE_PERCENTAGE, FEE_RANGE);

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 3 * amount);

        // Fee above the funder's cap.
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.FeeExceedsFunderCap.selector, expectedFee, expectedFee - 1)
        );
        distributor.distribute(
            address(mockToken), amount, TEST_ROOT, TEST_TOTAL_VALUE, 0, expectedFee - 1, feeRecipient
        );

        // Wrong fee recipient.
        vm.expectRevert(
            abi.encodeWithSelector(
                IMerkleFundDistributor.UnexpectedFeeRecipient.selector, address(0xD00D), feeRecipient
            )
        );
        distributor.distribute(address(mockToken), amount, TEST_ROOT, TEST_TOTAL_VALUE, 0, expectedFee, address(0xD00D));

        // As agreed: passes and books the expected fee.
        distributor.distribute(address(mockToken), amount, TEST_ROOT, TEST_TOTAL_VALUE, 0, expectedFee, feeRecipient);
        vm.stopPrank();
        assertEq(distributor.getDistribution(0).feeAmount, expectedFee);
    }

    /// H-3 regression: the guarded overload pins the payout denominator as well as the root.
    /// A snapshot owner cannot mirror the expected root while shrinking only `totalValue`.
    function test_H3_FunderGuardedDistributePinsTotalMerkleValue() public {
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: TEST_ROOT,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 600
            })
        );

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMerkleFundDistributor.UnexpectedMerkleTotalValue.selector, TEST_TOTAL_VALUE, uint256(600)
            )
        );
        distributor.distribute(address(mockToken), 100 ether, TEST_ROOT, TEST_TOTAL_VALUE, 0, 1 ether, feeRecipient);
        vm.stopPrank();

        assertEq(distributor.getDistributionCount(), 0, "mismatched denominator must not create a round");
    }

    function test_H3_FunderGuardedDistributeCannotSkipTotalMerkleValuePin() public {
        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMerkleFundDistributor.UnexpectedMerkleTotalValue.selector, uint256(0), TEST_TOTAL_VALUE
            )
        );
        distributor.distribute(address(mockToken), 100 ether, TEST_ROOT, 0, 0, 1 ether, feeRecipient);
        vm.stopPrank();
    }

    function test_SetFeePercentage_RevertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setFeePercentage(5e16);
    }

    function test_SetFeePercentage_RevertsIfTooHigh() public {
        vm.prank(owner);
        vm.expectRevert(IMerkleFundDistributor.FeePercentageTooHigh.selector);
        distributor.setFeePercentage(FEE_RANGE + 1);
    }

    function test_SetFeePercentage_AllowsMaxFee() public {
        vm.prank(owner);
        distributor.setFeePercentage(FEE_RANGE);
        vm.warp(block.timestamp + distributor.FEE_INCREASE_DELAY());
        distributor.applyFeePercentageIncrease();
        assertEq(distributor.feePercentage(), FEE_RANGE);
    }

    function test_SetMerkleSnapshot_UpdatesValue() public {
        address newSnapshot = address(0x999);
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit IMerkleFundDistributor.MerkleSnapshotUpdated(address(mockMerkleSnapshot), newSnapshot);
        distributor.setMerkleSnapshot(newSnapshot);

        assertEq(distributor.merkleSnapshot(), newSnapshot);
    }

    function test_SetMerkleSnapshot_RevertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setMerkleSnapshot(address(0x999));
    }

    function test_SetMerkleSnapshot_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(IMerkleFundDistributor.InvalidAddress.selector);
        distributor.setMerkleSnapshot(address(0));
    }

    function test_SetAllowlistEnabled_UpdatesValue() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit IMerkleFundDistributor.DistributorAllowlistUpdated(true);
        distributor.setAllowlistEnabled(true);

        assertEq(distributor.allowlistEnabled(), true);
    }

    function test_SetAllowlistEnabled_RevertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setAllowlistEnabled(true);
    }

    function test_UpdateDistributorAllowance_AddsToAllowlist() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit IMerkleFundDistributor.DistributorAllowanceUpdated(alice, true);
        distributor.updateDistributorAllowance(alice, true);

        assertTrue(distributor.isAllowlisted(alice));
        assertEq(distributor.getAllowlistLength(), 1);
    }

    function test_UpdateDistributorAllowance_RemovesFromAllowlist() public {
        vm.startPrank(owner);
        distributor.updateDistributorAllowance(alice, true);
        assertTrue(distributor.isAllowlisted(alice));

        vm.expectEmit(true, true, false, false);
        emit IMerkleFundDistributor.DistributorAllowanceUpdated(alice, false);
        distributor.updateDistributorAllowance(alice, false);
        vm.stopPrank();

        assertFalse(distributor.isAllowlisted(alice));
        assertEq(distributor.getAllowlistLength(), 0);
    }

    function test_UpdateDistributorAllowance_RevertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.updateDistributorAllowance(bob, true);
    }

    /* ========== PAUSE/UNPAUSE TESTS ========== */

    function test_Pause_PausesContract() public {
        vm.prank(owner);
        distributor.pause();

        assertTrue(distributor.paused());
    }

    function test_Pause_RevertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.pause();
    }

    function test_Unpause_UnpausesContract() public {
        vm.startPrank(owner);
        distributor.pause();
        distributor.unpause();
        vm.stopPrank();

        assertFalse(distributor.paused());
    }

    function test_Unpause_RevertsIfNotOwner() public {
        vm.prank(owner);
        distributor.pause();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.unpause();
    }

    /* ========== ALLOWLIST VIEW TESTS ========== */

    function test_IsAllowlisted_ReturnsTrueForAllowlistedAddress() public {
        vm.prank(owner);
        distributor.updateDistributorAllowance(alice, true);

        assertTrue(distributor.isAllowlisted(alice));
    }

    function test_IsAllowlisted_ReturnsFalseForNonAllowlistedAddress() public view {
        assertFalse(distributor.isAllowlisted(alice));
    }

    function test_GetAllowlistLength_ReturnsCorrectLength() public {
        vm.startPrank(owner);
        distributor.updateDistributorAllowance(alice, true);
        distributor.updateDistributorAllowance(bob, true);
        vm.stopPrank();

        assertEq(distributor.getAllowlistLength(), 2);
    }

    function test_GetAllowlist_ReturnsAllAddresses() public {
        vm.startPrank(owner);
        distributor.updateDistributorAllowance(alice, true);
        distributor.updateDistributorAllowance(bob, true);
        vm.stopPrank();

        address[] memory allowlist = distributor.getAllowlist();
        assertEq(allowlist.length, 2);
        assertEq(allowlist[0], alice);
        assertEq(allowlist[1], bob);
    }

    function test_GetDistributionCount_ReturnsZeroInitially() public view {
        assertEq(distributor.getDistributionCount(), 0);
    }

    function test_GetDistribution_ReturnsCorrectData() public {
        // Create a distribution first
        _createERC20Distribution(alice, 100 ether);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.distributor, alice);
        assertEq(dist.token, address(mockToken));
        assertEq(dist.amountFunded, 100 ether);
        assertEq(dist.root, TEST_ROOT);
    }

    function test_Distribute_ERC20_CreatesDistribution() public {
        uint256 amount = 100 ether;
        uint256 expectedFee = (amount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;

        vm.startPrank(alice);
        mockToken.approve(address(distributor), amount);

        vm.expectEmit(true, true, true, true);
        emit IMerkleFundDistributor.Distributed(0, alice, address(mockToken), amount, expectedFee);

        RoundPins.Pins memory _pins0 = RoundPins.read(distributor, amount);
        uint256 distributionIndex = distributor.distribute(
            address(mockToken), amount, _pins0.root, _pins0.totalValue, 0, type(uint256).max, _pins0.feeRecipient
        );
        vm.stopPrank();

        assertEq(distributionIndex, 0);
        assertEq(distributor.getDistributionCount(), 1);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.distributor, alice);
        assertEq(dist.token, address(mockToken));
        assertEq(dist.amountFunded, amount);
        assertEq(dist.feeAmount, expectedFee);
        assertEq(dist.feeRecipient, feeRecipient);
        assertEq(dist.root, TEST_ROOT);
        assertEq(dist.totalMerkleValue, TEST_TOTAL_VALUE);
    }

    function test_Distribute_ERC20_TransfersFundsCorrectly() public {
        uint256 amount = 100 ether;
        uint256 expectedFee = (amount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;

        uint256 aliceBalanceBefore = mockToken.balanceOf(alice);
        uint256 feeRecipientBalanceBefore = mockToken.balanceOf(feeRecipient);
        uint256 distributorBalanceBefore = mockToken.balanceOf(address(distributor));

        _createERC20Distribution(alice, amount);

        assertEq(mockToken.balanceOf(alice), aliceBalanceBefore - amount);
        assertEq(mockToken.balanceOf(feeRecipient), feeRecipientBalanceBefore + expectedFee);
        assertEq(mockToken.balanceOf(address(distributor)), distributorBalanceBefore + amount - expectedFee);
    }

    function test_Distribute_NativeToken_CreatesDistribution() public {
        uint256 amount = 10 ether;
        uint256 expectedFee = (amount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;

        RoundPins.Pins memory _pins1 = RoundPins.read(distributor, amount);
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IMerkleFundDistributor.Distributed(0, alice, address(0), amount, expectedFee);

        uint256 distributionIndex = distributor.distribute{value: amount}(
            address(0), amount, _pins1.root, _pins1.totalValue, 0, type(uint256).max, _pins1.feeRecipient
        );

        assertEq(distributionIndex, 0);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.token, address(0));
        assertEq(dist.amountFunded, amount);
        assertEq(dist.feeAmount, expectedFee);
    }

    function test_Distribute_NativeToken_TransfersFundsCorrectly() public {
        uint256 amount = 10 ether;
        uint256 expectedFee = (amount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;

        uint256 aliceBalanceBefore = alice.balance;
        uint256 feeRecipientBalanceBefore = feeRecipient.balance;
        uint256 distributorBalanceBefore = address(distributor).balance;

        RoundPins.Pins memory _pins2 = RoundPins.read(distributor, amount);
        vm.prank(alice);
        distributor.distribute{value: amount}(
            address(0), amount, _pins2.root, _pins2.totalValue, 0, type(uint256).max, _pins2.feeRecipient
        );

        assertEq(alice.balance, aliceBalanceBefore - amount);
        assertEq(feeRecipient.balance, feeRecipientBalanceBefore + expectedFee);
        assertEq(address(distributor).balance, distributorBalanceBefore + amount - expectedFee);
    }

    function test_Distribute_WithExpectedRoot_Succeeds() public {
        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);
        RoundPins.Pins memory _pins3 = RoundPins.read(distributor, 100 ether);
        distributor.distribute(
            address(mockToken), 100 ether, TEST_ROOT, _pins3.totalValue, 0, type(uint256).max, _pins3.feeRecipient
        );
        vm.stopPrank();

        assertEq(distributor.getDistributionCount(), 1);
    }

    function test_Distribute_WithExpectedRoot_RevertsOnMismatch() public {
        bytes32 wrongRoot = bytes32(uint256(0xdeadbeef));

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins4 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.UnexpectedMerkleRoot.selector, wrongRoot, TEST_ROOT)
        );
        distributor.distribute(
            address(mockToken), 100 ether, wrongRoot, _pins4.totalValue, 0, type(uint256).max, _pins4.feeRecipient
        );
        vm.stopPrank();
    }

    function test_Distribute_RevertsOnInvalidMerkleState_ZeroRoot() public {
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: bytes32(0),
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: TEST_TOTAL_VALUE
            })
        );

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins5 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(IMerkleFundDistributor.InvalidMerkleState.selector);
        distributor.distribute(
            address(mockToken), 100 ether, _pins5.root, _pins5.totalValue, 0, type(uint256).max, _pins5.feeRecipient
        );
        vm.stopPrank();
    }

    function test_Distribute_RevertsOnInvalidMerkleState_ZeroTotalValue() public {
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: TEST_ROOT,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 0
            })
        );

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins6 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(IMerkleFundDistributor.InvalidMerkleState.selector);
        distributor.distribute(
            address(mockToken), 100 ether, _pins6.root, _pins6.totalValue, 0, type(uint256).max, _pins6.feeRecipient
        );
        vm.stopPrank();
    }

    function test_Distribute_NativeToken_RevertsOnWrongMsgValue() public {
        RoundPins.Pins memory _pins7 = RoundPins.read(distributor, 10 ether);
        vm.prank(alice);
        vm.expectRevert(IMerkleFundDistributor.InvalidNativeTokenTransferAmount.selector);
        distributor.distribute{value: 5 ether}(
            address(0), 10 ether, _pins7.root, _pins7.totalValue, 0, type(uint256).max, _pins7.feeRecipient
        );
    }

    function test_Distribute_ERC20_RevertsIfMsgValueSent() public {
        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins8 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(IMerkleFundDistributor.InvalidNativeTokenTransfer.selector);
        distributor.distribute{value: 1 ether}(
            address(mockToken), 100 ether, _pins8.root, _pins8.totalValue, 0, type(uint256).max, _pins8.feeRecipient
        );
        vm.stopPrank();
    }

    function test_Distribute_RevertsWhenPaused() public {
        vm.prank(owner);
        distributor.pause();

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins9 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        distributor.distribute(
            address(mockToken), 100 ether, _pins9.root, _pins9.totalValue, 0, type(uint256).max, _pins9.feeRecipient
        );
        vm.stopPrank();
    }

    function test_Distribute_RevertsWhenNotAllowlisted() public {
        vm.prank(owner);
        distributor.setAllowlistEnabled(true);

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins10 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(IMerkleFundDistributor.CannotDistribute.selector);
        distributor.distribute(
            address(mockToken), 100 ether, _pins10.root, _pins10.totalValue, 0, type(uint256).max, _pins10.feeRecipient
        );
        vm.stopPrank();
    }

    function test_Distribute_SucceedsWhenAllowlisted() public {
        vm.startPrank(owner);
        distributor.setAllowlistEnabled(true);
        distributor.updateDistributorAllowance(alice, true);
        vm.stopPrank();

        _createERC20Distribution(alice, 100 ether);

        assertEq(distributor.getDistributionCount(), 1);
    }

    function test_Distribute_NativeToken_RevertsOnFeeTransferFailure() public {
        // Deploy a rejecting contract as fee recipient
        RejectingReceiver rejecter = new RejectingReceiver();

        vm.prank(owner);
        distributor.setFeeRecipient(address(rejecter));

        RoundPins.Pins memory _pins11 = RoundPins.read(distributor, 10 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMerkleFundDistributor.FailedToTransferFee.selector, ""));
        distributor.distribute{value: 10 ether}(
            address(0), 10 ether, _pins11.root, _pins11.totalValue, 0, type(uint256).max, _pins11.feeRecipient
        );
    }

    function test_Distribute_ZeroFeePercentage() public {
        vm.prank(owner);
        distributor.setFeePercentage(0);

        uint256 amount = 100 ether;
        uint256 feeRecipientBalanceBefore = mockToken.balanceOf(feeRecipient);

        _createERC20Distribution(alice, amount);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.feeAmount, 0);
        // Fee recipient receives nothing (but SafeERC20 still calls transfer with 0)
        assertEq(mockToken.balanceOf(feeRecipient), feeRecipientBalanceBefore);
    }

    function test_Distribute_MaxFeePercentage() public {
        vm.prank(owner);
        distributor.setFeePercentage(FEE_RANGE); // 100% — scheduled (M-7), applied after the delay
        vm.warp(block.timestamp + distributor.FEE_INCREASE_DELAY());
        distributor.applyFeePercentageIncrease();

        uint256 amount = 100 ether;

        _createERC20Distribution(alice, amount);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.feeAmount, amount); // entire amount is fee
        assertEq(mockToken.balanceOf(feeRecipient), amount);
        assertEq(mockToken.balanceOf(address(distributor)), 0);
    }

    /* ========== CLAIM TESTS ========== */

    function test_Claim_ERC20_TransfersCorrectAmount() public {
        // Create merkle tree: alice=600, bob=400 (total=1000)
        bytes32 aliceLeaf = _generateLeaf(alice, 600);
        bytes32 bobLeaf = _generateLeaf(bob, 400);
        bytes32 root = _hashPair(aliceLeaf, bobLeaf);

        // Update mock to use this root
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        // Create distribution with 100 tokens, 1% fee = 99 distributable
        uint256 fundedAmount = 100 ether;
        _createERC20Distribution(alice, fundedAmount);

        uint256 feeAmount = (fundedAmount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = fundedAmount - feeAmount;

        // Alice claims (600/1000 * 99 = 59.4 tokens)
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;

        uint256 aliceBalanceBefore = mockToken.balanceOf(alice);
        uint256 expectedAliceClaim = (distributable * 600) / 1000;

        vm.expectEmit(true, true, true, true);
        emit IMerkleFundDistributor.Claimed(0, alice, address(mockToken), expectedAliceClaim, 600, expectedAliceClaim);

        uint256 claimedAmount = distributor.claim(0, alice, 600, aliceProof);

        assertEq(claimedAmount, expectedAliceClaim);
        assertEq(mockToken.balanceOf(alice), aliceBalanceBefore + expectedAliceClaim);
        assertEq(distributor.claimed(0, alice), expectedAliceClaim);
    }

    function test_Claim_NativeToken_TransfersCorrectAmount() public {
        // Create merkle tree: alice=600, bob=400 (total=1000)
        bytes32 aliceLeaf = _generateLeaf(alice, 600);
        bytes32 bobLeaf = _generateLeaf(bob, 400);
        bytes32 root = _hashPair(aliceLeaf, bobLeaf);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        // Create native token distribution
        uint256 fundedAmount = 10 ether;
        RoundPins.Pins memory _pins12 = RoundPins.read(distributor, fundedAmount);
        vm.prank(alice);
        distributor.distribute{value: fundedAmount}(
            address(0), fundedAmount, _pins12.root, _pins12.totalValue, 0, type(uint256).max, _pins12.feeRecipient
        );

        uint256 feeAmount = (fundedAmount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = fundedAmount - feeAmount;

        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;

        uint256 aliceBalanceBefore = alice.balance;
        uint256 expectedAliceClaim = (distributable * 600) / 1000;

        uint256 claimedAmount = distributor.claim(0, alice, 600, aliceProof);

        assertEq(claimedAmount, expectedAliceClaim);
        assertEq(alice.balance, aliceBalanceBefore + expectedAliceClaim);
    }

    function test_Claim_MultipleUsersFromSameDistribution() public {
        // Create merkle tree
        bytes32 aliceLeaf = _generateLeaf(alice, 600);
        bytes32 bobLeaf = _generateLeaf(bob, 400);
        bytes32 root = _hashPair(aliceLeaf, bobLeaf);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        uint256 fundedAmount = 100 ether;
        _createERC20Distribution(alice, fundedAmount);

        uint256 feeAmount = (fundedAmount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = fundedAmount - feeAmount;

        // Alice claims
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;
        uint256 aliceClaimed = distributor.claim(0, alice, 600, aliceProof);

        // Bob claims
        bytes32[] memory bobProof = new bytes32[](1);
        bobProof[0] = aliceLeaf;
        uint256 bobClaimed = distributor.claim(0, bob, 400, bobProof);

        uint256 expectedAlice = (distributable * 600) / 1000;
        uint256 expectedBob = (distributable * 400) / 1000;

        assertEq(aliceClaimed, expectedAlice);
        assertEq(bobClaimed, expectedBob);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.amountDistributed, aliceClaimed + bobClaimed);
    }

    function test_Claim_RevertsOnDistributionNotFound() public {
        bytes32[] memory proof = new bytes32[](0);

        vm.expectRevert(IMerkleFundDistributor.DistributionNotFound.selector);
        distributor.claim(0, alice, 100, proof);
    }

    function test_Claim_RevertsOnInvalidAddress() public {
        _createERC20Distribution(alice, 100 ether);

        bytes32[] memory proof = new bytes32[](0);

        vm.expectRevert(IMerkleFundDistributor.InvalidAddress.selector);
        distributor.claim(0, address(0), 100, proof);
    }

    function test_Claim_RevertsOnAlreadyClaimed() public {
        bytes32 aliceLeaf = _generateLeaf(alice, 600);
        bytes32 bobLeaf = _generateLeaf(bob, 400);
        bytes32 root = _hashPair(aliceLeaf, bobLeaf);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        _createERC20Distribution(alice, 100 ether);

        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;

        // First claim succeeds
        distributor.claim(0, alice, 600, aliceProof);

        // Second claim reverts
        vm.expectRevert(IMerkleFundDistributor.AlreadyClaimed.selector);
        distributor.claim(0, alice, 600, aliceProof);
    }

    function test_Claim_RevertsOnInvalidMerkleProof() public {
        _createERC20Distribution(alice, 100 ether);

        bytes32[] memory invalidProof = new bytes32[](1);
        invalidProof[0] = bytes32(uint256(0xdeadbeef));

        vm.expectRevert(IMerkleFundDistributor.InvalidMerkleProof.selector);
        distributor.claim(0, alice, 100, invalidProof);
    }

    function test_Claim_RevertsOnNoFundsToClaim() public {
        // Create tree where alice has 0 value
        bytes32 aliceLeaf = _generateLeaf(alice, 0);
        bytes32 bobLeaf = _generateLeaf(bob, 1000);
        bytes32 root = _hashPair(aliceLeaf, bobLeaf);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        _createERC20Distribution(alice, 100 ether);

        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;

        vm.expectRevert(IMerkleFundDistributor.NoFundsToClaim.selector);
        distributor.claim(0, alice, 0, aliceProof);
    }

    /// H-3 regression: a malformed tree can make the formula exceed this round's funding, but it
    /// cannot spend a sibling round's balance. The cap fires before bookkeeping or transfer.
    function test_H3_ClaimCannotExceedPerRoundBudget() public {
        _createERC20Distribution(alice, 100 ether);
        uint256 siblingBalance = mockToken.balanceOf(address(distributor));

        uint256 attackerValue = 1000;
        bytes32 attackerRoot = _generateLeaf(charlie, attackerValue);
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: attackerRoot,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1
            })
        );

        _createERC20Distribution(bob, 1 ether);
        IMerkleFundDistributor.DistributionState memory badRound = distributor.getDistribution(1);
        uint256 budget = badRound.amountFunded - badRound.feeAmount;
        uint256 formulaAmount = Math.mulDiv(budget, attackerValue, 1);
        bytes32[] memory noProof = new bytes32[](0);

        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.ClaimExceedsRoundBudget.selector, formulaAmount, budget)
        );
        distributor.claim(1, charlie, attackerValue, noProof);

        assertEq(distributor.getDistribution(1).amountDistributed, 0, "rejected claim must not change books");
        assertEq(mockToken.balanceOf(charlie), 0, "rejected claim must not transfer");
        assertEq(mockToken.balanceOf(address(distributor)), siblingBalance + budget, "both rounds remain fully backed");
    }

    function test_H3_CumulativeClaimsCannotExceedPerRoundBudget() public {
        bytes32 aliceLeaf = _generateLeaf(alice, 60);
        bytes32 bobLeaf = _generateLeaf(bob, 60);
        bytes32 root = _hashPair(aliceLeaf, bobLeaf);
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 100
            })
        );
        _createERC20Distribution(alice, 100 ether);

        uint256 budget = 99 ether;
        uint256 eachFormulaAmount = Math.mulDiv(budget, 60, 100);
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;
        assertEq(distributor.claim(0, alice, 60, aliceProof), eachFormulaAmount);

        uint256 remainingBudget = budget - eachFormulaAmount;
        bytes32[] memory bobProof = new bytes32[](1);
        bobProof[0] = aliceLeaf;
        vm.expectRevert(
            abi.encodeWithSelector(
                IMerkleFundDistributor.ClaimExceedsRoundBudget.selector, eachFormulaAmount, remainingBudget
            )
        );
        distributor.claim(0, bob, 60, bobProof);

        assertEq(distributor.getDistribution(0).amountDistributed, eachFormulaAmount);
        assertEq(mockToken.balanceOf(address(distributor)), remainingBudget);
    }

    function test_Claim_RevertsWhenPaused() public {
        _createERC20Distribution(alice, 100 ether);

        vm.prank(owner);
        distributor.pause();

        bytes32[] memory proof = new bytes32[](0);

        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        distributor.claim(0, alice, 100, proof);
    }

    function test_Claim_NativeToken_RevertsOnTransferFailure() public {
        // Create merkle tree with rejecting receiver
        RejectingReceiver rejecter = new RejectingReceiver();
        bytes32 rejecterLeaf = _generateLeaf(address(rejecter), 600);
        bytes32 bobLeaf = _generateLeaf(bob, 400);
        bytes32 root = _hashPair(rejecterLeaf, bobLeaf);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        // Create native token distribution
        RoundPins.Pins memory _pins13 = RoundPins.read(distributor, 10 ether);
        vm.prank(alice);
        distributor.distribute{value: 10 ether}(
            address(0), 10 ether, _pins13.root, _pins13.totalValue, 0, type(uint256).max, _pins13.feeRecipient
        );

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;

        vm.expectRevert(abi.encodeWithSelector(IMerkleFundDistributor.FailedToTransferTokens.selector, ""));
        distributor.claim(0, address(rejecter), 600, proof);
    }

    function test_Claim_AnyoneCanClaimOnBehalfOfAccount() public {
        bytes32 aliceLeaf = _generateLeaf(alice, 600);
        bytes32 bobLeaf = _generateLeaf(bob, 400);
        bytes32 root = _hashPair(aliceLeaf, bobLeaf);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        _createERC20Distribution(alice, 100 ether);

        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;

        uint256 aliceBalanceBefore = mockToken.balanceOf(alice);

        // Charlie claims on behalf of alice
        vm.prank(charlie);
        uint256 claimedAmount = distributor.claim(0, alice, 600, aliceProof);

        // Tokens go to alice, not charlie
        assertEq(mockToken.balanceOf(alice), aliceBalanceBefore + claimedAmount);
    }

    /* ========== COMPLEX MERKLE TREE TESTS ========== */

    function test_Claim_ComplexMerkleTree_FourLeaves() public {
        // Create a 4-leaf merkle tree
        bytes32 leaf0 = _generateLeaf(alice, 250);
        bytes32 leaf1 = _generateLeaf(bob, 250);
        bytes32 leaf2 = _generateLeaf(charlie, 250);
        bytes32 leaf3 = _generateLeaf(address(0x6), 250);

        bytes32 node01 = _hashPair(leaf0, leaf1);
        bytes32 node23 = _hashPair(leaf2, leaf3);
        bytes32 root = _hashPair(node01, node23);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );

        _createERC20Distribution(alice, 100 ether);

        // Alice claims with proof [leaf1, node23]
        bytes32[] memory aliceProof = new bytes32[](2);
        aliceProof[0] = leaf1;
        aliceProof[1] = node23;

        uint256 claimedAmount = distributor.claim(0, alice, 250, aliceProof);

        uint256 feeAmount = (100 ether * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = 100 ether - feeAmount;
        uint256 expectedClaim = (distributable * 250) / 1000;

        assertEq(claimedAmount, expectedClaim);
    }

    /* ========== CLAIM DEADLINE (DISTRIBUTE OVERLOAD) TESTS ========== */

    function test_DistributeWithDeadline_StoresDeadlineAndZeroSweptAmount() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.claimDeadline, deadline);
        assertEq(dist.sweptAmount, 0);
        assertEq(dist.distributor, alice);
        assertEq(dist.amountFunded, 100 ether);
    }

    function test_DistributeWithDeadline_ZeroDeadlineMatchesLegacyBehavior() public {
        _setupTwoLeafTree();
        _createERC20DistributionWithDeadline(alice, 100 ether, 0);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.claimDeadline, 0);

        // Claims stay open forever.
        vm.warp(block.timestamp + 3650 days);
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = _generateLeaf(bob, 400);
        uint256 claimedAmount = distributor.claim(0, alice, 600, aliceProof);
        assertGt(claimedAmount, 0);

        // And the distribution can never be swept.
        vm.expectRevert(IMerkleFundDistributor.NoClaimDeadline.selector);
        distributor.sweep(0);
    }

    function test_LegacyDistribute_CreatesZeroDeadlineDistribution() public {
        _createERC20Distribution(alice, 100 ether);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.claimDeadline, 0);
        assertEq(dist.sweptAmount, 0);
    }

    function test_DistributeWithDeadline_RevertsOnPastDeadline() public {
        vm.warp(1000);

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins14 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(IMerkleFundDistributor.InvalidClaimDeadline.selector);
        distributor.distribute(
            address(mockToken),
            100 ether,
            _pins14.root,
            _pins14.totalValue,
            uint64(999),
            type(uint256).max,
            _pins14.feeRecipient
        );
        vm.stopPrank();
    }

    function test_DistributeWithDeadline_RevertsOnDeadlineEqualToNow() public {
        vm.warp(1000);

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins15 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(IMerkleFundDistributor.InvalidClaimDeadline.selector);
        distributor.distribute(
            address(mockToken),
            100 ether,
            _pins15.root,
            _pins15.totalValue,
            uint64(1000),
            type(uint256).max,
            _pins15.feeRecipient
        );
        vm.stopPrank();
    }

    function test_DistributeWithDeadline_RespectsAllowlist() public {
        vm.prank(owner);
        distributor.setAllowlistEnabled(true);

        vm.startPrank(alice);
        mockToken.approve(address(distributor), 100 ether);

        RoundPins.Pins memory _pins16 = RoundPins.read(distributor, 100 ether);
        vm.expectRevert(IMerkleFundDistributor.CannotDistribute.selector);
        distributor.distribute(
            address(mockToken),
            100 ether,
            _pins16.root,
            _pins16.totalValue,
            uint64(block.timestamp + 1 days),
            type(uint256).max,
            _pins16.feeRecipient
        );
        vm.stopPrank();
    }

    /* ========== CLAIM WINDOW TESTS ========== */

    function test_Claim_BeforeDeadline_Succeeds() public {
        _setupTwoLeafTree();
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.warp(deadline - 1);
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = _generateLeaf(bob, 400);
        uint256 claimedAmount = distributor.claim(0, alice, 600, aliceProof);
        assertGt(claimedAmount, 0);
    }

    function test_Claim_AfterDeadline_RevertsClaimWindowClosed() public {
        _setupTwoLeafTree();
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.warp(uint256(deadline) + 1);
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = _generateLeaf(bob, 400);

        vm.expectRevert(IMerkleFundDistributor.ClaimWindowClosed.selector);
        distributor.claim(0, alice, 600, aliceProof);
    }

    function test_SweepVsLateClaimRace_AtAndPastDeadline() public {
        // The race the design closes: claims are valid while timestamp <= deadline,
        // sweep only when timestamp > deadline. The two can never both succeed at
        // the same timestamp.
        _setupTwoLeafTree();
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        uint256 feeAmount = (100 ether * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = 100 ether - feeAmount;

        // Exactly at the deadline: claim still works, sweep reverts.
        vm.warp(deadline);
        vm.expectRevert(IMerkleFundDistributor.ClaimWindowNotClosed.selector);
        distributor.sweep(0);

        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = _generateLeaf(bob, 400);
        uint256 aliceClaimed = distributor.claim(0, alice, 600, aliceProof);
        assertEq(aliceClaimed, (distributable * 600) / 1000);

        // One second past the deadline: claim reverts, sweep works.
        vm.warp(uint256(deadline) + 1);
        bytes32[] memory bobProof = new bytes32[](1);
        bobProof[0] = _generateLeaf(alice, 600);
        vm.expectRevert(IMerkleFundDistributor.ClaimWindowClosed.selector);
        distributor.claim(0, bob, 400, bobProof);

        uint256 aliceBalanceBefore = mockToken.balanceOf(alice);
        uint256 sweptAmount = distributor.sweep(0);
        assertEq(sweptAmount, distributable - aliceClaimed);
        assertEq(mockToken.balanceOf(alice), aliceBalanceBefore + sweptAmount);
    }

    /* ========== SWEEP TESTS ========== */

    function test_Sweep_BeforeDeadline_Reverts() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.expectRevert(IMerkleFundDistributor.ClaimWindowNotClosed.selector);
        distributor.sweep(0);
    }

    function test_Sweep_ERC20_ReturnsAllUnclaimedToFunder() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        uint256 feeAmount = (100 ether * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = 100 ether - feeAmount;

        vm.warp(uint256(deadline) + 1);

        uint256 aliceBalanceBefore = mockToken.balanceOf(alice);

        vm.expectEmit(true, true, false, true);
        emit IMerkleFundDistributor.Swept(0, alice, distributable);

        uint256 sweptAmount = distributor.sweep(0);

        assertEq(sweptAmount, distributable);
        assertEq(mockToken.balanceOf(alice), aliceBalanceBefore + sweptAmount);
        assertEq(mockToken.balanceOf(address(distributor)), 0);

        IMerkleFundDistributor.DistributionState memory dist = distributor.getDistribution(0);
        assertEq(dist.sweptAmount, sweptAmount);
        // Fee accounting untouched by the sweep.
        assertEq(dist.feeAmount, feeAmount);
        assertEq(mockToken.balanceOf(feeRecipient), feeAmount);
    }

    function test_Sweep_NativeToken_ReturnsAllUnclaimedToFunder() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        RoundPins.Pins memory _pins17 = RoundPins.read(distributor, 10 ether);
        vm.prank(alice);
        distributor.distribute{value: 10 ether}(
            address(0), 10 ether, _pins17.root, _pins17.totalValue, deadline, type(uint256).max, _pins17.feeRecipient
        );

        uint256 feeAmount = (10 ether * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = 10 ether - feeAmount;

        vm.warp(uint256(deadline) + 1);

        uint256 aliceBalanceBefore = alice.balance;
        uint256 sweptAmount = distributor.sweep(0);

        assertEq(sweptAmount, distributable);
        assertEq(alice.balance, aliceBalanceBefore + sweptAmount);
        assertEq(address(distributor).balance, 0);
    }

    function test_Sweep_Permissionless_FundsStillGoToFunder() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.warp(uint256(deadline) + 1);

        uint256 aliceBalanceBefore = mockToken.balanceOf(alice);
        uint256 charlieBalanceBefore = mockToken.balanceOf(charlie);

        // Charlie (unrelated) triggers the sweep.
        vm.prank(charlie);
        uint256 sweptAmount = distributor.sweep(0);

        assertEq(mockToken.balanceOf(alice), aliceBalanceBefore + sweptAmount);
        assertEq(mockToken.balanceOf(charlie), charlieBalanceBefore);
    }

    function test_Sweep_DoubleSweepReverts() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.warp(uint256(deadline) + 1);
        distributor.sweep(0);

        vm.expectRevert(IMerkleFundDistributor.AlreadySwept.selector);
        distributor.sweep(0);
    }

    function test_Sweep_RevertsOnZeroDeadlineDistribution() public {
        _createERC20Distribution(alice, 100 ether);

        vm.warp(block.timestamp + 3650 days);
        vm.expectRevert(IMerkleFundDistributor.NoClaimDeadline.selector);
        distributor.sweep(0);
    }

    function test_Sweep_RevertsOnDistributionNotFound() public {
        vm.expectRevert(IMerkleFundDistributor.DistributionNotFound.selector);
        distributor.sweep(0);
    }

    /// M-8 regression: pausing incident response must not remove an expired funder's only exit.
    function test_M8_SweepSucceedsWhenPaused() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.warp(uint256(deadline) + 1);
        vm.prank(owner);
        distributor.pause();

        uint256 balanceBefore = mockToken.balanceOf(alice);
        uint256 sweptAmount = distributor.sweep(0);
        assertEq(mockToken.balanceOf(alice), balanceBefore + sweptAmount);
        assertEq(mockToken.balanceOf(address(distributor)), 0);
    }

    function test_M8_PausedSweepStillRequiresClosedClaimWindow() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.prank(owner);
        distributor.pause();

        vm.expectRevert(IMerkleFundDistributor.ClaimWindowNotClosed.selector);
        distributor.sweep(0);
    }

    function test_Claim_AfterSweep_RevertsClaimWindowClosed() public {
        _setupTwoLeafTree();
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        vm.warp(uint256(deadline) + 1);
        distributor.sweep(0);

        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = _generateLeaf(bob, 400);
        vm.expectRevert(IMerkleFundDistributor.ClaimWindowClosed.selector);
        distributor.claim(0, alice, 600, aliceProof);
    }

    function test_Sweep_PartialClaims_AccountingExact() public {
        _setupTwoLeafTree();
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        uint256 feeAmount = (100 ether * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = 100 ether - feeAmount;

        // Alice claims her share, bob never claims.
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = _generateLeaf(bob, 400);
        uint256 aliceClaimed = distributor.claim(0, alice, 600, aliceProof);

        vm.warp(uint256(deadline) + 1);
        uint256 sweptAmount = distributor.sweep(0);

        // Exact remainder, and the whole pot is accounted for.
        assertEq(sweptAmount, distributable - aliceClaimed);
        assertEq(feeAmount + aliceClaimed + sweptAmount, 100 ether);
        assertEq(mockToken.balanceOf(address(distributor)), 0);
    }

    function test_Sweep_AllClaimed_RevertsNothingToSweep() public {
        _setupTwoLeafTree();
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);

        // Both leaves claim (600 + 400 over total 1000 divides 99 ether exactly).
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = _generateLeaf(bob, 400);
        distributor.claim(0, alice, 600, aliceProof);

        bytes32[] memory bobProof = new bytes32[](1);
        bobProof[0] = _generateLeaf(alice, 600);
        distributor.claim(0, bob, 400, bobProof);

        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(IMerkleFundDistributor.NothingToSweep.selector);
        distributor.sweep(0);
    }

    function test_Sweep_NativeToken_RevertsOnTransferFailure() public {
        RejectingReceiver rejecter = new RejectingReceiver();
        vm.deal(address(rejecter), 10 ether);

        uint64 deadline = uint64(block.timestamp + 7 days);
        RoundPins.Pins memory _pins18 = RoundPins.read(distributor, 10 ether);
        vm.prank(address(rejecter));
        distributor.distribute{value: 10 ether}(
            address(0), 10 ether, _pins18.root, _pins18.totalValue, deadline, type(uint256).max, _pins18.feeRecipient
        );

        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(IMerkleFundDistributor.FailedToTransferTokens.selector, ""));
        distributor.sweep(0);
    }

    function test_Sweep_OnlyTargetsItsOwnDistribution() public {
        // Two distributions; sweeping one must not touch the other's funds.
        _setupTwoLeafTree();
        uint64 deadline = uint64(block.timestamp + 7 days);
        _createERC20DistributionWithDeadline(alice, 100 ether, deadline);
        _createERC20DistributionWithDeadline(bob, 50 ether, deadline);

        uint256 fee0 = (100 ether * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 fee1 = (50 ether * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;

        vm.warp(uint256(deadline) + 1);
        uint256 swept0 = distributor.sweep(0);

        assertEq(swept0, 100 ether - fee0);
        // Distribution 1's pot is still fully held by the contract.
        assertEq(mockToken.balanceOf(address(distributor)), 50 ether - fee1);

        uint256 swept1 = distributor.sweep(1);
        assertEq(swept1, 50 ether - fee1);
        assertEq(mockToken.balanceOf(address(distributor)), 0);
    }

    /* ========== SWEEP FUZZ TESTS ========== */

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_Sweep_ConservationInvariant(uint256 fundedAmount, uint256[4] memory values, uint8 claimMask)
        public
    {
        fundedAmount = bound(fundedAmount, 1, 1e30);

        address[4] memory accounts = [alice, bob, charlie, address(0x6666)];

        // Build a 4-leaf tree with fuzzed values (at least one non-zero).
        uint256 totalValue;
        bytes32[4] memory leaves;
        for (uint256 i = 0; i < 4; i++) {
            values[i] = bound(values[i], 0, 1e24);
            totalValue += values[i];
            leaves[i] = _generateLeaf(accounts[i], values[i]);
        }
        vm.assume(totalValue > 0);

        bytes32 node01 = _hashPair(leaves[0], leaves[1]);
        bytes32 node23 = _hashPair(leaves[2], leaves[3]);
        bytes32 root = _hashPair(node01, node23);

        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: totalValue
            })
        );

        uint64 deadline = uint64(block.timestamp + 7 days);
        mockToken.mint(alice, fundedAmount);
        _createERC20DistributionWithDeadline(alice, fundedAmount, deadline);

        uint256 feeAmount = (fundedAmount * DEFAULT_FEE_PERCENTAGE) / FEE_RANGE;
        uint256 distributable = fundedAmount - feeAmount;

        // A random subset of accounts claims before the deadline.
        uint256 totalClaimed;
        for (uint256 i = 0; i < 4; i++) {
            if (claimMask & (1 << i) == 0) continue;

            uint256 expectedClaim = (distributable * values[i]) / totalValue;
            if (expectedClaim == 0) continue; // would revert NoFundsToClaim

            bytes32[] memory proof = new bytes32[](2);
            proof[0] = i % 2 == 0 ? leaves[i + 1] : leaves[i - 1];
            proof[1] = i < 2 ? node23 : node01;

            totalClaimed += distributor.claim(0, accounts[i], values[i], proof);
        }

        vm.warp(uint256(deadline) + 1);

        uint256 unclaimed = distributable - totalClaimed;
        uint256 sweptAmount;
        if (unclaimed == 0) {
            vm.expectRevert(IMerkleFundDistributor.NothingToSweep.selector);
            distributor.sweep(0);
        } else {
            sweptAmount = distributor.sweep(0);
        }

        // Conservation: every wei of the pot is either fee, claimed, or swept.
        assertEq(feeAmount + totalClaimed + sweptAmount, fundedAmount);
        // The contract holds nothing for this distribution afterwards.
        assertEq(mockToken.balanceOf(address(distributor)), 0);
    }

    /* ========== HELPER FUNCTIONS ========== */

    function _createERC20Distribution(address from, uint256 amount) internal {
        vm.startPrank(from);
        mockToken.approve(address(distributor), amount);
        RoundPins.Pins memory _pins19 = RoundPins.read(distributor, amount);
        distributor.distribute(
            address(mockToken), amount, _pins19.root, _pins19.totalValue, 0, type(uint256).max, _pins19.feeRecipient
        );
        vm.stopPrank();
    }

    function _createERC20DistributionWithDeadline(address from, uint256 amount, uint64 claimDeadline) internal {
        vm.startPrank(from);
        mockToken.approve(address(distributor), amount);
        RoundPins.Pins memory _pins20 = RoundPins.read(distributor, amount);
        distributor.distribute(
            address(mockToken),
            amount,
            _pins20.root,
            _pins20.totalValue,
            claimDeadline,
            type(uint256).max,
            _pins20.feeRecipient
        );
        vm.stopPrank();
    }

    /// @dev Sets the mock snapshot to a two-leaf tree: alice=600, bob=400 (total=1000).
    function _setupTwoLeafTree() internal {
        bytes32 root = _hashPair(_generateLeaf(alice, 600), _generateLeaf(bob, 400));
        mockMerkleSnapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: TEST_IPFS_HASH,
                ipfsHashCid: TEST_IPFS_CID,
                totalValue: 1000
            })
        );
    }

    function _generateLeaf(address account, uint256 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, value))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// H-1: a fee-on-transfer token must book the amount RECEIVED (balance delta), not the amount
    /// requested. Otherwise a distribution over-books its share of the shared per-token balance and
    /// drains sibling distributions. This also verifies the fee is taken on the received amount so
    /// the contract stays exactly solvent: retained == amountFunded - feeAmount.
    function test_Distribute_FeeOnTransfer_BooksReceivedNotRequested() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(1000); // 10% fee
        fot.mint(alice, 1000 ether);

        vm.startPrank(alice);
        fot.approve(address(distributor), type(uint256).max);
        RoundPins.Pins memory _pins21 = RoundPins.read(distributor, 1000 ether);
        uint256 idx = distributor.distribute(
            address(fot), 1000 ether, TEST_ROOT, _pins21.totalValue, 0, type(uint256).max, _pins21.feeRecipient
        );
        vm.stopPrank();

        IMerkleFundDistributor.DistributionState memory d = distributor.getDistribution(idx);
        // 10% burned in transit → only 900 arrived, and that is what gets booked.
        assertEq(d.amountFunded, 900 ether, "books received, not requested");
        // Fee is 1% of the RECEIVED amount (9), not 1% of the requested amount (10).
        assertEq(d.feeAmount, 9 ether, "fee computed on received");
        // Contract retains received - fee = the exact distributable; no phantom liability.
        assertEq(fot.balanceOf(address(distributor)), 891 ether, "distributor solvent for this pool");
    }

    /// H-1 (solvency across siblings): two fee-on-transfer distributions of the same token must not
    /// let one distribution's booked total exceed what actually arrived, so the shared balance always
    /// covers the sum of distributable amounts.
    function test_Distribute_FeeOnTransfer_SiblingsStaySolvent() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(1000); // 10% fee
        fot.mint(alice, 5000 ether);

        vm.startPrank(alice);
        fot.approve(address(distributor), type(uint256).max);
        RoundPins.Pins memory _pins22 = RoundPins.read(distributor, 1000 ether);
        uint256 a = distributor.distribute(
            address(fot), 1000 ether, TEST_ROOT, _pins22.totalValue, 0, type(uint256).max, _pins22.feeRecipient
        );
        RoundPins.Pins memory _pins23 = RoundPins.read(distributor, 2000 ether);
        uint256 b = distributor.distribute(
            address(fot), 2000 ether, TEST_ROOT, _pins23.totalValue, 0, type(uint256).max, _pins23.feeRecipient
        );
        vm.stopPrank();

        IMerkleFundDistributor.DistributionState memory da = distributor.getDistribution(a);
        IMerkleFundDistributor.DistributionState memory db = distributor.getDistribution(b);

        uint256 distributableA = da.amountFunded - da.feeAmount;
        uint256 distributableB = db.amountFunded - db.feeAmount;
        // The shared balance must cover the sum of both distributions' distributable amounts.
        assertGe(fot.balanceOf(address(distributor)), distributableA + distributableB, "pool covers all claims");
    }
}

/* ========== MOCK CONTRACTS ========== */

contract MockMerkleSnapshot is IMerkleSnapshot {
    MerkleState private _state;

    function setMerkleState(MerkleState memory state) external {
        _state = state;
    }

    function getLatestState() external view override returns (MerkleState memory) {
        return _state;
    }
}

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A fee-on-transfer token that burns `feeBps` of every transfer, like PAXG or an
///         activated-fee USDT. Used to prove the distributor books received, not requested, amounts.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps; // out of 10_000

    constructor(uint256 _feeBps) ERC20("Fee Token", "FEE") {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0xdead), fee); // burn the fee
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract RejectingReceiver {
    receive() external payable {
        revert();
    }
}
