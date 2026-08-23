// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {AnchorRegistry} from "src/registry/AnchorRegistry.sol";
import {EasOffchainAnchorRegistry} from "src/registry/EasOffchainAnchorRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

contract VA_Lane1 {
    uint64 public leafCount;

    function set(uint64 c) external {
        leafCount = c;
    }
}

contract VA_Snap {
    address public accumulator;
    address public anchorRegistry;

    constructor(address a, address r) {
        accumulator = a;
        anchorRegistry = r;
    }
}

contract VerifyAnchorIngress is Test {
    uint256 internal constant VICTIM_KEY = 0xC1CDEF;
    address internal victim;
    address internal admin = address(0xA11CE);

    AnchorRegistry internal reg;
    VA_Lane1 internal lane1;

    function setUp() public {
        victim = vm.addr(VICTIM_KEY);
        reg = new AnchorRegistry(admin, 200_000);
        lane1 = new VA_Lane1();
        VA_Snap snap = new VA_Snap(address(lane1), address(reg));
        reg.bindSnapshot(address(snap));
        bytes32 role = reg.ANCHORER_ROLE();
        vm.prank(admin);
        reg.grantRole(role, address(this));
        vm.prank(victim);
        reg.register();
    }

    function _sign(bytes32 head, uint64 count, bytes32 dataCommitment) internal view returns (bytes memory) {
        bytes32 nodeId = keccak256(abi.encode(victim));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VICTIM_KEY, reg.anchorDigest(nodeId, 0, head, count, dataCommitment));
        return abi.encodePacked(r, s, v);
    }

    /// C8 regression: impossible counts are refused and governance can recover the admission gate.
    function test_C8_MaxCountIsRejectedAndAdminCanResetTheIdentity() public {
        bytes32 nodeId = keccak256(abi.encode(victim));
        bytes memory sig = _sign(keccak256("attacker-head"), type(uint64).max, keccak256("x"));
        vm.expectRevert(
            abi.encodeWithSelector(AnchorRegistry.InvalidHeadCount.selector, type(uint64).max, reg.maxTotalInputs())
        );
        reg.anchor(nodeId, 0, keccak256("attacker-head"), type(uint64).max, keccak256("x"), sig);
        assertEq(reg.lastCount(nodeId), 0);

        uint64 maximum = reg.maxTotalInputs();
        bytes memory high = _sign(keccak256("high-head"), maximum, keccak256("x"));
        reg.anchor(nodeId, 0, keccak256("high-head"), maximum, keccak256("x"), high);
        bytes memory good = _sign(keccak256("real-head"), 5, keccak256("y"));
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.StaleHeadCount.selector, nodeId, uint64(5), maximum));
        reg.anchor(nodeId, 0, keccak256("real-head"), 5, keccak256("y"), good);

        vm.prank(admin);
        reg.resetHeadCount(nodeId);
        reg.anchor(nodeId, 0, keccak256("real-head"), 5, keccak256("y"), good);
        assertEq(reg.lastCount(nodeId), 5);
        console2.log("admin recovered the head-count admission gate at:", reg.lastCount(nodeId));
    }

    /// The sibling refuses the same shape three separate ways.
    function test_C8_SiblingRegistryRefusesMaxCountAndCrossDomainReplay() public {
        SchemaRegistry sr = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(sr)));
        address[] memory relayers = new address[](1);
        relayers[0] = address(this);
        EasOffchainAnchorRegistry strict = new EasOffchainAnchorRegistry(
            IEAS(address(eas)), keccak256("schema"), 200_000, admin, address(this), relayers
        );
        VA_Snap s2 = new VA_Snap(address(lane1), address(strict));
        strict.bindSnapshot(address(s2));

        bytes32 nodeId = keccak256(abi.encode(victim));
        // 1. count is capped at MAX_ENTRIES_PER_NODE.
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(
            VICTIM_KEY, strict.anchorDigest(nodeId, 0, bytes32(0), keccak256("h"), type(uint64).max, keccak256("dc"))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                EasOffchainAnchorRegistry.InvalidEntryCount.selector, type(uint64).max, strict.MAX_ENTRIES_PER_NODE()
            )
        );
        strict.anchor(
            nodeId, 0, bytes32(0), keccak256("h"), type(uint64).max, keccak256("dc"), abi.encodePacked(r, ss, v)
        );

        // 2. the sibling uses a distinct EIP-712 struct and verifying-contract domain.
        bytes memory legacySig = _sign(keccak256("h"), 7, keccak256("dc"));
        vm.expectRevert(); // WrongNodeId: recovery yields a different address entirely
        strict.anchor(nodeId, 0, bytes32(0), keccak256("h"), 7, keccak256("dc"), legacySig);
        console2.log("strict registry rejects both shapes");
    }

    /// C16 lane-2: work units are charged on a CLAIMED count that is never validated on-chain,
    /// and are never reclaimed when the head turns out to be unusable.
    function test_C16_StrictLaneChargesWorkForAHeadThatCanNeverVerify() public {
        SchemaRegistry sr = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(sr)));
        address[] memory relayers = new address[](1);
        relayers[0] = address(this);
        EasOffchainAnchorRegistry strict = new EasOffchainAnchorRegistry(
            IEAS(address(eas)), keccak256("schema"), 200_000, admin, address(this), relayers
        );
        VA_Snap s2 = new VA_Snap(address(lane1), address(strict));
        strict.bindSnapshot(address(s2));

        uint256 key = 0xF00D;
        address a = vm.addr(key);
        bytes32 nodeId = keccak256(abi.encode(a));
        // A head over a log that does not exist. Nothing on-chain can tell.
        bytes32 head = keccak256("no-such-log");
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(key, strict.anchorDigest(nodeId, 0, bytes32(0), head, 2048, keccak256("dc")));
        uint256 g0 = gasleft();
        strict.anchor(nodeId, 0, bytes32(0), head, 2048, keccak256("dc"), abi.encodePacked(r, ss, v));
        uint256 used = g0 - gasleft();

        assertEq(strict.workCount(), 1 + 2048 * 4);
        console2.log("work units bought by one garbage head:", strict.workCount());
        console2.log("execution gas paid                   :", used);
        console2.log("work units per 1000 gas              :", (strict.workCount() * 1000) / used);
    }
}
