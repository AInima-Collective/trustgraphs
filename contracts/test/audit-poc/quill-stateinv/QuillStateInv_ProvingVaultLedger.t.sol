// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "test/mocks/MockEthUsdFeed.sol";

contract QuillUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Drives every value-moving entry point on the vault under a bounded fuzz schedule.
///         Deployed BEFORE the snapshot so it can hold the snapshot's CONSTITUTIONAL_ROLE.
contract QuillVaultHandler is Test {
    ProvingVault public immutable vault;
    QuillUSDC public immutable usdc;
    MockAccumulator public immutable accumulator;
    MerkleSnapshot public snapshot;

    bytes32 public constant INSTANCE = keccak256("quill.vault.instance");
    address[] public payees;

    constructor(ProvingVault vault_, QuillUSDC usdc_, MockAccumulator accumulator_) {
        vault = vault_;
        usdc = usdc_;
        accumulator = accumulator_;
        payees.push(address(0xA1));
        payees.push(address(0xB2));
        payees.push(address(0xC3));
    }

    function bindSnapshot(MerkleSnapshot snapshot_) external {
        require(address(snapshot) == address(0), "bound");
        snapshot = snapshot_;
    }

    receive() external payable {}

    function depositETH(uint96 raw) external {
        uint256 amount = bound(raw, 1, 5 ether);
        vm.deal(address(this), address(this).balance + amount);
        vault.depositETH{value: amount}(INSTANCE);
    }

    function depositUSDC(uint96 raw) external {
        uint256 amount = bound(raw, 1, 10_000e6);
        usdc.mint(address(this), amount);
        usdc.approve(address(vault), amount);
        vault.depositUSDC(INSTANCE, amount);
    }

    function setPolicy(uint64 rawInterval, uint96 rawCap) external {
        vault.setPolicy(INSTANCE, uint64(bound(rawInterval, 0, 10)), uint96(bound(rawCap, 0, 500e8)));
    }

    function landRootAndClaim(uint128 rawLeaf, uint8 rawPayee, uint32 rawBlocks) external {
        vm.roll(block.number + bound(rawBlocks, 1, 20));
        uint64 leaf = uint64(bound(rawLeaf, 1, 150_000));
        accumulator.setState(keccak256(abi.encode("acc", leaf, block.number)), leaf);
        try snapshot.trigger() returns (uint256 id) {
            address payee = payees[bound(rawPayee, 0, payees.length - 1)];
            IProvingVault.SubmitArgs memory args = IProvingVault.SubmitArgs({
                checkpointId: id,
                outputRoot: keccak256(abi.encode("root", id)),
                ipfsHash: keccak256(abi.encode("blob", id)),
                ipfsHashCid: "bafyquill",
                totalValue: 1_000,
                skippedDigest: bytes32(0),
                recipient: payee,
                proof: hex"01",
                minPayoutUsd: 0
            });
            try vault.submitAndClaim(INSTANCE, args) {} catch {}
        } catch {}
    }

    function requestWithdrawal(uint128 rawEth, uint128 rawUsdc) external {
        IProvingVault.Account memory a = vault.accountOf(INSTANCE);
        if (a.snapshot == address(0)) return;
        uint256 eth = bound(rawEth, 0, a.ethBalance);
        uint256 usd = bound(rawUsdc, 0, a.usdcBalance);
        if (eth == 0 && usd == 0) return;
        vault.requestWithdrawal(INSTANCE, eth, usd);
    }

    function cancelWithdrawal() external {
        if (vault.pendingWithdrawalOf(INSTANCE).readyAt == 0) return;
        vault.cancelWithdrawal(INSTANCE);
    }

    function executeWithdrawal(uint32 rawWait) external {
        IProvingVault.PendingWithdrawal memory w = vault.pendingWithdrawalOf(INSTANCE);
        if (w.readyAt == 0) return;
        vm.warp(block.timestamp + bound(rawWait, 0, 10 days));
        if (block.timestamp < w.readyAt) return;
        vault.executeWithdrawal(INSTANCE, address(this));
    }

    function withdrawCredit(uint8 rawPayee, bool ethLeg) external {
        address payee = payees[bound(rawPayee, 0, payees.length - 1)];
        address token = ethLeg ? address(0) : address(usdc);
        if (vault.creditOf(payee, token) == 0) return;
        vm.prank(payee);
        vault.withdrawCredit(token, payee);
    }

    function payeeCount() external view returns (uint256) {
        return payees.length;
    }

    function payeeAt(uint256 i) external view returns (address) {
        return payees[i];
    }
}

contract QuillStateInv_ProvingVaultLedger is Test {
    ProvingVault internal vault;
    QuillUSDC internal usdc;
    MerkleSnapshot internal snapshot;
    MockAccumulator internal accumulator;
    MockZkVerifier internal verifier;
    MockEthUsdFeed internal feed;
    InstanceRegistry internal registry;
    QuillVaultHandler internal handler;

    address internal registryAdmin = address(0xBEEF);
    address internal feeSetter = address(0xF335);
    bytes32 internal constant INSTANCE = keccak256("quill.vault.instance");
    bytes32 internal constant PROGRAM = keccak256("trust-graph");

    function setUp() public {
        registry = new InstanceRegistry(registryAdmin);
        usdc = new QuillUSDC();
        feed = new MockEthUsdFeed();
        verifier = new MockZkVerifier();
        accumulator = new MockAccumulator();
        vm.warp(1_000_000);
        feed.set(3_000e8, block.timestamp);

        vault = new ProvingVault(
            IInstanceRegistry(address(registry)),
            usdc,
            IEthUsdFeed(address(feed)),
            1 days,
            100e8,
            100_000e8,
            feeSetter,
            address(this)
        );

        handler = new QuillVaultHandler(vault, usdc, accumulator);
        snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            keccak256("params"),
            IAttestationAccumulator(address(accumulator)),
            address(handler),
            address(this),
            ""
        );
        handler.bindSnapshot(snapshot);

        vm.prank(registryAdmin);
        registry.registerWithParamsAuthority(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accumulator),
                paramsHash: keccak256("params")
            }),
            address(this)
        );

        vm.startPrank(feeSetter);
        vault.setFeePerRootUsd(PROGRAM, 1, 5e8);
        vault.setFeePerRootUsd(PROGRAM, 2, 25e8);
        vault.setFeePerRootUsd(PROGRAM, 3, 100e8);
        vm.stopPrank();

        vm.fee(20 gwei);
        targetContract(address(handler));
    }

    /// Conservation: the vault never books more than it holds, on either leg.
    function invariant_VaultNeverBooksMoreThanItHolds() public view {
        IProvingVault.Account memory a = vault.accountOf(INSTANCE);

        uint256 ethCredits = vault.creditOf(address(handler), address(0));
        uint256 usdcCredits = vault.creditOf(address(handler), address(usdc));
        uint256 n = handler.payeeCount();
        for (uint256 i; i < n; ++i) {
            address p = handler.payeeAt(i);
            ethCredits += vault.creditOf(p, address(0));
            usdcCredits += vault.creditOf(p, address(usdc));
        }

        assertGe(address(vault).balance, uint256(a.ethBalance) + ethCredits, "ETH ledger exceeds holdings");
        assertGe(usdc.balanceOf(address(vault)), uint256(a.usdcBalance) + usdcCredits, "USDC ledger exceeds holdings");
    }

    /*//////////////////////////////////////////////////////////////
        The pending-withdrawal ledger is NOT bounded by the balance.
    //////////////////////////////////////////////////////////////*/

    /// `requestWithdrawal` checks each request against the CURRENT balance but then ACCUMULATES
    /// into `w.ethAmount` / `w.usdcAmount` (ProvingVault.sol:603-604) with no cap against the
    /// account. The stored pending figure can therefore exceed the account many times over.
    /// `executeWithdrawal` clamps, so no value is lost - but `pendingWithdrawalOf` is the number
    /// an operator/monitor reads to decide whether a tank is about to empty, and it overstates.
    function test_PendingWithdrawalLedgerExceedsTheAccountItDrawsOn() public {
        vm.deal(address(this), 10 ether);
        vault.depositETH{value: 1 ether}(INSTANCE);

        vm.startPrank(address(handler));
        for (uint256 i; i < 10; ++i) {
            vault.requestWithdrawal(INSTANCE, 1 ether, 0);
        }
        vm.stopPrank();

        IProvingVault.PendingWithdrawal memory w = vault.pendingWithdrawalOf(INSTANCE);
        IProvingVault.Account memory a = vault.accountOf(INSTANCE);
        assertEq(a.ethBalance, 1 ether);
        assertEq(w.ethAmount, 10 ether, "pending ledger is 10x the account it can draw on");
        assertGt(w.ethAmount, a.ethBalance);

        // Execution is clamped, so solvency itself is preserved.
        vm.warp(block.timestamp + 8 days);
        vm.prank(address(handler));
        vault.executeWithdrawal(INSTANCE, address(0xDEAD));
        assertEq(address(0xDEAD).balance, 1 ether);
        assertEq(vault.accountOf(INSTANCE).ethBalance, 0);
    }

    /*//////////////////////////////////////////////////////////////
        ZKS-3 regression: is the checkpoint high-water mark still
        exposed to an accumulator rotation on MerkleSnapshot?
    //////////////////////////////////////////////////////////////*/

    /// CLEARED: `MerkleSnapshot.setAccumulator` refuses any rotation once EITHER side has
    /// checkpoint history, and `nextCheckpointId == accumulator.checkpointCount()` always holds,
    /// so the high-water mark can never index a different contract's ids.
    function test_MerkleSnapshotAccumulatorRotationIsLockedAfterFirstCheckpoint() public {
        accumulator.setState(keccak256("a"), 1);
        vm.prank(address(handler));
        // trigger() is permissionless; epochLength is 0 on this snapshot.
        uint256 id = snapshot.trigger();
        assertEq(id, 0);
        assertEq(snapshot.nextCheckpointId(), accumulator.checkpointCount(), "id space stays dense and paired");

        MockAccumulator fresh = new MockAccumulator();
        vm.prank(address(handler));
        vm.expectRevert(abi.encodeWithSelector(IMerkleSnapshot.AccumulatorRotationLocked.selector, 1, 0));
        snapshot.setAccumulator(IAttestationAccumulator(address(fresh)));
    }
}
