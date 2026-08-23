// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";

/// Minimal snapshot double: returns whatever (root, totalValue) it is told to.
contract StubSnapshot {
    IMerkleSnapshot.MerkleState internal _state;

    function set(bytes32 root, bytes32 ipfsHash, string memory cid, uint256 totalValue) external {
        _state = IMerkleSnapshot.MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: ipfsHash,
            ipfsHashCid: cid,
            totalValue: totalValue
        });
    }

    function getLatestState() external view returns (IMerkleSnapshot.MerkleState memory) {
        return _state;
    }
}

contract PocToken is ERC20 {
    constructor() ERC20("Poc", "POC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice H-3 regression: `MerkleFundDistributor.claim` bounds every distribution's cumulative
///         payouts by that distribution's own `amountFunded - feeAmount`, even when its snapshot
///         reports an inconsistent `(root, totalMerkleValue)` pair.
contract QuillBehav_DistributorOverclaim is Test {
    MerkleFundDistributor internal dist;
    StubSnapshot internal honest;
    StubSnapshot internal rogue;
    PocToken internal token;

    address internal admin = address(0xAD814); // instance admin == distributor owner
    address internal alice = address(0xA11CE); // third-party funder of a real round
    address internal bob = address(0xB0B); // legitimate contributor in Alice's round

    function _leaf(address account, uint256 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, value))));
    }

    function setUp() public {
        honest = new StubSnapshot();
        rogue = new StubSnapshot();
        token = new PocToken();

        // Alice's round: bob is the only scored account, value 1000, totalValue 1000.
        honest.set(_leaf(bob, 1000), keccak256("blob"), "QmHonest", 1000);

        dist = new MerkleFundDistributor(admin, address(honest), admin, 0, false);

        token.mint(alice, 1_000e18);
        token.mint(admin, 1);
    }

    function test_H3_OwnerRepointCannotDrainAnotherFundersRound() public {
        // 1. Alice funds a real round of 1000 tokens against the honest root.
        vm.startPrank(alice);
        token.approve(address(dist), 1_000e18);
        uint256 aliceRound = dist.distribute(address(token), 1_000e18, bytes32(0));
        vm.stopPrank();
        assertEq(token.balanceOf(address(dist)), 1_000e18, "round funded");

        // 2. The distributor owner re-points `merkleSnapshot` at a contract it controls, whose
        //    state claims totalValue == 1 while the tree hands the owner a leaf worth 1000e18.
        rogue.set(_leaf(admin, 1_000e18), keccak256("rogue"), "QmRogue", 1);
        vm.prank(admin);
        dist.setMerkleSnapshot(address(rogue));

        // 3. The owner opens a 1-wei round against that state. Nothing here is gated on the
        //    funder, the amount, or any relationship between the root and the amount funded.
        vm.startPrank(admin);
        token.approve(address(dist), 1);
        uint256 rogueRound = dist.distribute(address(token), 1, bytes32(0));
        vm.stopPrank();

        // 4. The formula proposes 1000e18, but the round has only one wei of budget.
        bytes32[] memory emptyProof = new bytes32[](0);
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.ClaimExceedsRoundBudget.selector, 1_000e18, uint256(1))
        );
        dist.claim(rogueRound, admin, 1_000e18, emptyProof);
        assertEq(token.balanceOf(admin), 0, "rejected claim transferred Alice's funds");

        // The malicious round's books remain bounded by its own funding.
        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(rogueRound);
        assertEq(d.amountFunded, 1);
        assertEq(d.amountDistributed, 0);

        // 5. Bob's legitimate claim against Alice's round remains fully backed.
        assertEq(dist.claim(aliceRound, bob, 1000, emptyProof), 1_000e18);
    }
}
