// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Research-only validator used to benchmark issue #34's compact-calldata architecture.
contract WeightedPriorValidatorSpike {
    uint256 internal constant SCALE = 1e18;
    uint32 internal constant MAX_ENTRIES = 2048;

    bytes32 public priorRoot;
    bytes32 public manifestSha256;
    uint32 public priorCount;

    function validateAndStore(bytes calldata manifest) external {
        require(manifest.length >= 18, "short manifest");
        require(bytes4(manifest[0:4]) == bytes4("TGWP"), "bad magic");
        require(uint16(bytes2(manifest[4:6])) == 1, "bad version");
        uint32 count = uint32(bytes4(manifest[14:18]));
        require(count > 0 && count <= MAX_ENTRIES, "bad count");
        require(manifest.length == 18 + uint256(count) * 28, "bad length");

        bytes32[] memory level = new bytes32[](count);
        uint256 sum;
        address previous;
        for (uint256 i; i < count; ++i) {
            uint256 offset = 18 + i * 28;
            address account;
            uint64 weight;
            assembly ("memory-safe") {
                account := shr(96, calldataload(add(manifest.offset, offset)))
                weight := shr(192, calldataload(add(add(manifest.offset, offset), 20)))
            }
            require(account > previous && weight > 0, "noncanonical entry");
            previous = account;
            sum += weight;
            level[i] = keccak256(abi.encode(account, uint256(weight)));
        }
        require(sum == SCALE, "bad sum");

        uint256 width = count;
        while (width > 1) {
            uint256 nextWidth;
            for (uint256 i; i < width; i += 2) {
                if (i + 1 == width) {
                    level[nextWidth++] = level[i];
                } else {
                    bytes32 left = level[i];
                    bytes32 right = level[i + 1];
                    level[nextWidth++] = left < right
                        ? keccak256(abi.encodePacked(left, right))
                        : keccak256(abi.encodePacked(right, left));
                }
            }
            width = nextWidth;
        }

        priorRoot = level[0];
        priorCount = count;
        manifestSha256 = sha256(manifest);
    }
}

/// @dev `forge script script/research/WeightedPriorGas.s.sol --sig 'run(uint256)' COUNT -vv`.
contract WeightedPriorGas is Script {
    uint256 internal constant SCALE = 1e18;

    function run(uint256 count) external {
        require(count > 1 && count <= 2048, "count outside spike range");
        WeightedPriorValidatorSpike validator = new WeightedPriorValidatorSpike();
        bytes memory manifest = _manifest(count);

        uint256 beforeGas = gasleft();
        validator.validateAndStore(manifest);
        uint256 executionGas = beforeGas - gasleft();
        bytes memory call = abi.encodeCall(validator.validateAndStore, (manifest));

        console2.log("count", count);
        console2.log("manifest_bytes", manifest.length);
        console2.log("abi_calldata_bytes", call.length);
        console2.log("execution_gas", executionGas);
        console2.log("calldata_gas", _calldataGas(call));
        console2.log("total_l1_gas_upper_bound", executionGas + _calldataGas(call) + 21_000);
    }

    function _manifest(uint256 count) private pure returns (bytes memory manifest) {
        manifest = new bytes(18 + count * 28);
        manifest[0] = 0x54;
        manifest[1] = 0x47;
        manifest[2] = 0x57;
        manifest[3] = 0x50;
        manifest[5] = 0x01;
        _writeBigEndian(manifest, 6, 10, 8);
        _writeBigEndian(manifest, 14, count, 4);

        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint256 offset = 18 + i * 28;
            address account = address(uint160(i + 1));
            uint256 weight = base + (i < remainder ? 1 : 0);
            assembly ("memory-safe") {
                mstore(add(add(manifest, 32), offset), shl(96, account))
                mstore(add(add(add(manifest, 32), offset), 20), shl(192, weight))
            }
        }
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) private pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _calldataGas(bytes memory data) private pure returns (uint256 gasUnits) {
        for (uint256 i; i < data.length; ++i) {
            gasUnits += data[i] == 0 ? 4 : 16;
        }
    }
}
