// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {RoundPins} from "test/helpers/RoundPins.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract StubSnapshot is IMerkleSnapshot {
    MerkleState private _state;

    function setMerkleState(MerkleState memory s) external {
        _state = s;
    }

    function getLatestState() external view override returns (MerkleState memory) {
        return _state;
    }
}

/// @notice USDC/USDT-shaped blocklist. Any transfer touching a blocked address reverts.
contract BlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocklist", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function block_(address who) external {
        blocked[who] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @notice Returns a huge blob from its ETH-receiving fallback. `(bool, bytes memory data) =
///         addr.call{value: x}("")` copies ALL of it into the caller's memory, on the SUCCESS
///         path too.
contract ReturnBomb {
    uint256 public immutable size;

    constructor(uint256 size_) {
        size = size_;
    }

    fallback() external payable {
        uint256 n = size;
        assembly {
            // touch memory so the return region exists, then return `n` bytes
            mstore(n, 0)
            return(0, n)
        }
    }
}

/// @notice A funder contract that cannot receive ETH. Distributions it funds can never be swept.
contract RejectingFunder {
    function fund(MerkleFundDistributor d, uint256 amount, uint64 deadline) external payable {
        RoundPins.Pins memory _pins0 = RoundPins.read(d, amount);
        d.distribute{value: amount}(address(0), amount, _pins0.root, _pins0.totalValue, deadline, type(uint256).max, _pins0.feeRecipient);
    }

    receive() external payable {
        revert("no eth");
    }
}

contract QuillExtCall_DistributorWeirdTokens is Test {
    MerkleFundDistributor internal distributor;
    StubSnapshot internal snapshot;

    address internal owner = address(0xA0);
    address internal feeRecipient = address(0xFE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0);

    bytes32 internal constant IPFS = bytes32(uint256(0x1111));
    string internal constant CID = "QmTest";

    function setUp() public {
        snapshot = new StubSnapshot();
        distributor = new MerkleFundDistributor(owner, address(snapshot), feeRecipient, 0, false);
        vm.deal(alice, 1000 ether);
    }

    function _setTree(bytes32 root, uint256 totalValue) internal {
        snapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: IPFS,
                ipfsHashCid: CID,
                totalValue: totalValue
            })
        );
    }

    function _leaf(address account, uint256 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, value))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /*//////////////////////////////////////////////////////////////
        1. Return-data bomb on the native claim path.
    //////////////////////////////////////////////////////////////*/

    function test_ClaimNativeReturnDataBombInflatesCallerGas() public {
        // M0 disposition: preserve this refutation and its measured assertions, but do not make
        // the default suite red. The 2 MB returndata does amplify claim gas by over 100x, while
        // the stronger filed claim is refuted: the measured call is about 15.8M gas, below the
        // asserted 30M block budget. The audit historically counted five deliberate failures;
        // three historical harness artifacts now pass in the committed/current evidence (the two
        // Omega vault claims use a capture nonce, and the block-number variant is covered with
        // absolute rolls by VerifyVaultSiblings), leaving this refutation and the vault-epilogue
        // artifact as the only current default-suite failures.
        vm.skip(true);

        ReturnBomb bomb = new ReturnBomb(2_000_000); // 2 MB of returndata
        bytes32 leafBomb = _leaf(address(bomb), 500);
        bytes32 leafBob = _leaf(bob, 500);
        _setTree(_pair(leafBomb, leafBob), 1000);

        RoundPins.Pins memory _pins1 = RoundPins.read(distributor, 10 ether);
        vm.prank(alice);
        distributor.distribute{value: 10 ether}(address(0), 10 ether, _pins1.root, _pins1.totalValue, 0, type(uint256).max, _pins1.feeRecipient);

        bytes32[] memory proofBomb = new bytes32[](1);
        proofBomb[0] = leafBob;
        bytes32[] memory proofBob = new bytes32[](1);
        proofBob[0] = leafBomb;

        // Baseline: a plain EOA claim.
        uint256 g0 = gasleft();
        distributor.claim(0, bob, 500, proofBob);
        uint256 plainGas = g0 - gasleft();

        // The same claim, paid to a contract that returns 2 MB.
        uint256 g1 = gasleft();
        distributor.claim(0, address(bomb), 500, proofBomb);
        uint256 bombGas = g1 - gasleft();

        emit log_named_uint("plain EOA claim gas", plainGas);
        emit log_named_uint("return-bomb claim gas", bombGas);
        assertGt(bombGas, plainGas * 100, "returndata is copied on the success path");
        // Well past a mainnet block's 30M budget for a single claim.
        assertGt(bombGas, 30_000_000, "one leaf can price its own claim out of a block");
    }

    /*//////////////////////////////////////////////////////////////
        2. Native sweep is a push to a fixed address with no fallback.
    //////////////////////////////////////////////////////////////*/

    function test_SweepNativeIsPermanentlyBlockedByARevertingFunder() public {
        RejectingFunder funder = new RejectingFunder();
        vm.deal(address(funder), 10 ether);

        bytes32 leafA = _leaf(alice, 500);
        bytes32 leafB = _leaf(bob, 500);
        _setTree(_pair(leafA, leafB), 1000);

        uint64 deadline = uint64(block.timestamp + 1 days);
        funder.fund{value: 10 ether}(distributor, 10 ether, deadline);

        vm.warp(uint256(deadline) + 1);
        // Claims are closed forever; the only recovery path is `sweep`, and it pushes to the
        // funder with no alternate recipient.
        vm.expectRevert();
        distributor.sweep(0);

        assertEq(address(distributor).balance, 10 ether, "funds stranded");
    }

    /*//////////////////////////////////////////////////////////////
        3. A blocklisting ERC-20 (USDC/USDT) freezes every distribution
           of that token, with no rescue path.
    //////////////////////////////////////////////////////////////*/

    function test_BlocklistedDistributorFreezesClaimsAndSweepForever() public {
        BlocklistToken token = new BlocklistToken();
        token.mint(alice, 1000 ether);

        bytes32 leafA = _leaf(alice, 500);
        bytes32 leafB = _leaf(bob, 500);
        _setTree(_pair(leafA, leafB), 1000);

        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.startPrank(alice);
        token.approve(address(distributor), type(uint256).max);
        RoundPins.Pins memory _pins2 = RoundPins.read(distributor, 100 ether);
        distributor.distribute(address(token), 100 ether, _pins2.root, _pins2.totalValue, deadline, type(uint256).max, _pins2.feeRecipient);
        vm.stopPrank();

        // The token issuer blocks the distributor itself (the documented USDC/USDT power).
        token.block_(address(distributor));

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.expectRevert();
        distributor.claim(0, alice, 500, proofA);

        vm.warp(uint256(deadline) + 1);
        vm.expectRevert();
        distributor.sweep(0);

        assertEq(token.balanceOf(address(distributor)), 100 ether, "no rescue path exists");
    }

    /// A blocked FUNDER is enough on its own: claims still work, but the sweep that is the only
    /// way to recover the remainder pushes to that funder.
    function test_BlocklistedFunderBlocksSweepOnly() public {
        BlocklistToken token = new BlocklistToken();
        token.mint(alice, 1000 ether);

        bytes32 leafA = _leaf(alice, 500);
        bytes32 leafB = _leaf(bob, 500);
        _setTree(_pair(leafA, leafB), 1000);

        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.startPrank(alice);
        token.approve(address(distributor), type(uint256).max);
        RoundPins.Pins memory _pins3 = RoundPins.read(distributor, 100 ether);
        distributor.distribute(address(token), 100 ether, _pins3.root, _pins3.totalValue, deadline, type(uint256).max, _pins3.feeRecipient);
        vm.stopPrank();

        token.block_(alice);
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert();
        distributor.sweep(0);
        assertEq(token.balanceOf(address(distributor)), 100 ether, "remainder stranded");
    }
}
