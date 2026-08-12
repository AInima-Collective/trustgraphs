// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {TrustgraphsParamsController} from "contracts/factory/TrustgraphsParamsController.sol";
import {Common} from "script/Common.s.sol";

/// @title DeployParamsTimelock
/// @notice Starts a two-step handoff of one typed scoring controller to an operational timelock.
/// @dev The controller remains owned by its current owner until the scheduled `acceptOwnership()`
///      executes. A failed or forgotten schedule therefore cannot strand scoring authority.
contract DeployParamsTimelock is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    function run(address controller, uint256 minDelay, string calldata executorAddr)
        public
        returns (address timelock, bytes32 operationId)
    {
        require(controller != address(0), "DeployParamsTimelock: controller is zero");
        address deployer = vm.addr(_privateKey);
        require(
            TrustgraphsParamsController(controller).owner() == deployer,
            "DeployParamsTimelock: deployer is not controller owner"
        );

        // The current controller owner is the bootstrap proposer. Passing an explicit zero address
        // makes execution permissionless after the delay; an empty string restricts it to deployer.
        address executor = bytes(executorAddr).length == 0 ? deployer : vm.parseAddress(executorAddr);
        address[] memory proposers = new address[](1);
        proposers[0] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = executor;

        vm.startBroadcast(_privateKey);
        TimelockController operational = new TimelockController(minDelay, proposers, executors, address(0));
        timelock = address(operational);

        TrustgraphsParamsController(controller).transferOwnership(timelock);
        require(
            TrustgraphsParamsController(controller).pendingOwner() == timelock,
            "DeployParamsTimelock: pending owner mismatch"
        );

        bytes memory acceptCall = abi.encodeWithSignature("acceptOwnership()");
        bytes32 salt = keccak256(abi.encode(controller, timelock, block.chainid, "accept-params-ownership"));
        operational.schedule(controller, 0, acceptCall, bytes32(0), salt, minDelay);
        operationId = operational.hashOperation(controller, 0, acceptCall, bytes32(0), salt);
        require(operational.getTimestamp(operationId) != 0, "DeployParamsTimelock: handoff not scheduled");
        vm.stopBroadcast();

        string memory json = "paramsTimelock";
        json.serialize("controller", Strings.toChecksumHexString(controller));
        json.serialize("timelock", Strings.toChecksumHexString(timelock));
        json.serialize("proposer", Strings.toChecksumHexString(deployer));
        json.serialize("executor", Strings.toChecksumHexString(executor));
        json.serialize("min_delay", minDelay);
        json.serialize("operation_id", operationId);
        json.serialize("salt", salt);
        string memory finalJson = json.serialize("accept_ownership_calldata", acceptCall);
        vm.createDir(string.concat(root, "/.trustgraph"), true);
        vm.writeFile(string.concat(root, "/.trustgraph/params-timelock.json"), finalJson);

        console.log("Operational params timelock:", timelock);
        console.log("Controller pending owner:", timelock);
        console.log("Minimum delay:", minDelay);
        console.logBytes32(operationId);
    }
}
