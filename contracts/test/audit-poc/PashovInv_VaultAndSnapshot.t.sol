// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../mocks/MockEthUsdFeed.sol";

contract PashovInvNoopHook is IMerkleSnapshotHook {
    uint256 public seen;

    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory) external {
        seen++;
    }
}

contract PashovInvHandler is Test {
    ProvingVault public vault;
    MerkleSnapshot public snapshot;
    MockAccumulator public accer;
    TestUSDC public usdc;
    bytes32 public immutable INSTANCE;
    address public immutable CONSTITUTIONAL;

    address[3] public actors = [address(0xA1), address(0xA2), address(0xA3)];

    uint64 public leaves;
    uint256 public nonce;
    uint256 public appliedHigh;
    bool public anyApplied;

    // Every address that has ever been able to hold a credit.
    address[] public creditHolders;
    mapping(address => bool) internal _seenHolder;

    constructor(
        ProvingVault v,
        MerkleSnapshot s,
        MockAccumulator a,
        TestUSDC u,
        bytes32 instanceId,
        address constitutional
    ) {
        vault = v;
        snapshot = s;
        accer = a;
        usdc = u;
        INSTANCE = instanceId;
        CONSTITUTIONAL = constitutional;
        for (uint256 i; i < 3; ++i) {
            _track(actors[i]);
        }
        _track(address(this));
    }

    function _track(address who) internal {
        if (!_seenHolder[who]) {
            _seenHolder[who] = true;
            creditHolders.push(who);
        }
    }

    function creditHolderCount() external view returns (uint256) {
        return creditHolders.length;
    }

    function depositEth(uint8 who, uint96 raw) external {
        address actor = actors[who % 3];
        uint256 amount = bound(uint256(raw), 1, 20 ether);
        vm.deal(actor, amount);
        vm.prank(actor);
        vault.depositETH{value: amount}(INSTANCE);
    }

    function depositUsdc(uint8 who, uint96 raw) external {
        address actor = actors[who % 3];
        uint256 amount = bound(uint256(raw), 1, 50_000e6);
        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(vault), amount);
        vault.depositUSDC(INSTANCE, amount);
        vm.stopPrank();
    }

    /// Freeze a checkpoint then land a root through the vault, paying `recipient`.
    function proveAndClaim(uint8 who, uint8 recipientPick, uint16 rawBlocks) external {
        address actor = actors[who % 3];
        address recipient = actors[recipientPick % 3];
        _track(actor);
        _track(recipient);

        nonce++;
        leaves += uint64(bound(uint256(rawBlocks), 0, 3));
        accer.setState(keccak256(abi.encode("acc", nonce)), leaves);
        vm.roll(block.number + bound(uint256(rawBlocks), 1, 50));
        uint256 cp;
        try snapshot.trigger() returns (uint256 id) {
            cp = id;
        } catch {
            return;
        }

        IProvingVault.SubmitArgs memory args = IProvingVault.SubmitArgs({
            checkpointId: cp,
            outputRoot: keccak256(abi.encode("root", nonce)),
            ipfsHash: keccak256(abi.encode("ipfs", nonce)),
            ipfsHashCid: "cid",
            totalValue: 1_000 ether,
            skippedDigest: bytes32(0),
            recipient: recipient,
            proof: hex"",
            minPayoutUsd: 0
        });
        vm.prank(actor);
        try vault.submitAndClaim(INSTANCE, args) {
            appliedHigh = cp;
            anyApplied = true;
        } catch {}
    }

    function requestWithdrawal(uint96 rawEth, uint96 rawUsdc) external {
        IProvingVault.Account memory a = vault.accountOf(INSTANCE);
        uint256 e = a.ethBalance == 0 ? 0 : bound(uint256(rawEth), 0, a.ethBalance);
        uint256 u = a.usdcBalance == 0 ? 0 : bound(uint256(rawUsdc), 0, a.usdcBalance);
        if (e == 0 && u == 0) return;
        vm.prank(CONSTITUTIONAL);
        try vault.requestWithdrawal(INSTANCE, e, u) {} catch {}
    }

    function executeWithdrawal(uint32 rawSeconds, uint8 who) external {
        vm.warp(block.timestamp + bound(uint256(rawSeconds), 1, 3 days));
        address to = actors[who % 3];
        _track(to);
        vm.prank(CONSTITUTIONAL);
        try vault.executeWithdrawal(INSTANCE, to) {} catch {}
    }

    function withdrawCredit(uint8 who, bool ethLeg) external {
        address actor = actors[who % 3];
        _track(actor);
        vm.prank(actor);
        try vault.withdrawCredit(ethLeg ? address(0) : address(usdc), actor) {} catch {}
    }

    receive() external payable {}
}

contract PashovInv_VaultAndSnapshot is Test {
    ProvingVault vault;
    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    MockAccumulator accer;
    MockZkVerifier verifier;
    MockEthUsdFeed feed;
    TestUSDC usdc;
    PashovInvHandler handler;

    bytes32 constant INSTANCE = keccak256("solvency-net");
    bytes32 constant PROGRAM = keccak256("trust-graph");
    bytes32 constant PARAMS = keccak256("params-v1");

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    address feeSetter = address(0xFEE5);
    address vaultAdmin = address(0xAD41);

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, PARAMS, accer, constitutional, operational);
        registry = new InstanceRegistry(address(this));
        usdc = new TestUSDC();
        feed = new MockEthUsdFeed();
        vault = new ProvingVault(registry, usdc, feed, 1 hours, 100e8, 100_000e8, feeSetter, vaultAdmin);

        registry.register(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accer),
                paramsHash: PARAMS
            })
        );

        uint256 usdScale = vault.USD();
        vm.startPrank(feeSetter);
        vault.setFeePerRootUsd(PROGRAM, 1, 10 * usdScale);
        vault.setFeePerRootUsd(PROGRAM, 2, 40 * usdScale);
        vault.setFeePerRootUsd(PROGRAM, 3, 200 * usdScale);
        vm.stopPrank();

        vm.warp(1_000_000);
        vm.fee(1 gwei);
        feed.set(3_000e8, block.timestamp);

        // Seed the tank so the very first claim can pay, then hand the policy knob a real cap.
        vm.deal(address(this), 5 ether);
        vault.depositETH{value: 5 ether}(INSTANCE);
        uint96 cap = uint96(50 * usdScale);
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, cap);

        // A live hook, so `submitProof`'s hook loop is exercised.
        PashovInvNoopHook hook = new PashovInvNoopHook();
        vm.prank(constitutional);
        snapshot.addHook(hook);

        handler = new PashovInvHandler(vault, snapshot, accer, usdc, INSTANCE, constitutional);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](6);
        sels[0] = handler.depositEth.selector;
        sels[1] = handler.depositUsdc.selector;
        sels[2] = handler.proveAndClaim.selector;
        sels[3] = handler.requestWithdrawal.selector;
        sels[4] = handler.executeWithdrawal.selector;
        sels[5] = handler.withdrawCredit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    receive() external payable {}

    /// CONSERVATION: every wei the vault holds is either an instance's spendable balance or an
    /// accrued pull-payment credit; nothing is minted and nothing is stranded.
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 32
    function invariant_VaultEthAndUsdcAreFullyBacked() public view {
        IProvingVault.Account memory a = vault.accountOf(INSTANCE);

        uint256 ethCredits;
        uint256 usdcCredits;
        uint256 n = handler.creditHolderCount();
        for (uint256 i; i < n; ++i) {
            address who = handler.creditHolders(i);
            ethCredits += vault.creditOf(who, address(0));
            usdcCredits += vault.creditOf(who, address(usdc));
        }

        assertEq(address(vault).balance, uint256(a.ethBalance) + ethCredits, "ETH not conserved");
        assertEq(usdc.balanceOf(address(vault)), uint256(a.usdcBalance) + usdcCredits, "USDC not conserved");
    }

    /// STRUCTURE: the snapshot's checkpoint ids stay dense, its state blocks stay ascending, its
    /// applied-checkpoint pointer stays monotonic, the hook set stays dense, and the
    /// constitutional role can never empty out.
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 32
    function invariant_SnapshotStructuralLaws() public view {
        assertEq(snapshot.nextCheckpointId(), accer.checkpointCount(), "checkpoint ids not dense");

        uint256 states = snapshot.getStateCount();
        uint256 previous;
        for (uint256 i; i < states; ++i) {
            uint256 blockNumber = snapshot.stateBlocks(i);
            assertGe(blockNumber, previous, "state blocks regressed");
            assertEq(snapshot.blockToStateIndex(blockNumber), i, "block index desynced");
            previous = blockNumber;
        }

        if (snapshot.hasAppliedCheckpoint()) {
            assertGe(handler.appliedHigh(), snapshot.lastAppliedCheckpoint());
            assertLt(snapshot.lastAppliedCheckpoint(), snapshot.nextCheckpointId());
        }

        assertEq(uint256(snapshot.nextHookIndex()), uint256(snapshot.hookCount()) + 1, "hook set not dense");
        assertGe(snapshot.constitutionalHolderCount(), 1, "constitutional authority emptied");
    }
}
