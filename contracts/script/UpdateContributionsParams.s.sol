// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {console} from "forge-std/console.sol";

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";

import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {SafeOwnerPolicy} from "src/factory/SafeOwnerPolicy.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {Common} from "script/Common.s.sol";
import {ContributionsParamsJson} from "script/lib/ContributionsParamsJson.sol";

/// @title UpdateContributionsParams
/// @notice Publish a local draft through the typed, history-preserving on-chain controller.
/// @dev Supports either the broadcaster directly owning the controller or the demo's initialized,
///      1-of-1 Safe owning it. Production multisig/governed updates use their normal proposal path.
contract UpdateContributionsParams is Common {
    error UnsupportedParamsAuthority(address authority);
    error DevSafeThresholdNotOne(address safe, uint256 threshold);
    error BroadcasterNotDevSafeOwner(address safe, address broadcaster);
    error DevSafeExecutionFailed(address safe);

    function run(string calldata controllerAddr, string calldata paramsPath, string calldata evidenceURI) public {
        ContributionsParamsController controller = ContributionsParamsController(vm.parseAddress(controllerAddr));
        ContributionsParamsCodec.Params memory current = controller.getContributionsParams();
        ContributionsParamsCodec.Params memory next = ContributionsParamsJson.read(
            paramsPath, current.claimSchemaUid, current.responseSchemaUid, current.valuationSchemaUid
        );

        address broadcaster = vm.addr(_privateKey);
        _startBroadcast();
        (uint64 version, bytes32 paramsHash) = _update(controller, next, evidenceURI, broadcaster);
        vm.stopBroadcast();

        console.log("Contributions params version:", version);
        console.log("paramsHash:", vm.toString(paramsHash));
    }

    function _update(
        ContributionsParamsController controller,
        ContributionsParamsCodec.Params memory next,
        string memory evidenceURI,
        address broadcaster
    ) internal returns (uint64 version, bytes32 paramsHash) {
        address authority = controller.owner();
        if (authority == broadcaster) {
            return controller.updateParams(next, evidenceURI);
        }

        if (!SafeOwnerPolicy.isSafe(authority)) revert UnsupportedParamsAuthority(authority);

        GnosisSafe safe = GnosisSafe(payable(authority));
        uint256 threshold = safe.getThreshold();
        if (threshold != 1) revert DevSafeThresholdNotOne(authority, threshold);
        if (!safe.isOwner(broadcaster)) revert BroadcasterNotDevSafeOwner(authority, broadcaster);

        bytes memory data = abi.encodeCall(ContributionsParamsController.updateParams, (next, evidenceURI));
        bool success = safe.execTransaction(
            address(controller),
            0,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _approvedHashSignature(broadcaster)
        );
        if (!success) revert DevSafeExecutionFailed(authority);

        return (controller.version(), controller.currentParamsHash());
    }

    /// @dev Safe v1 approved-hash signature. It is valid here because the broadcaster is the sole
    ///      owner and calls `execTransaction` itself; no hash approval is stored or reused.
    function _approvedHashSignature(address signer) private pure returns (bytes memory) {
        return abi.encodePacked(uint256(uint160(signer)), uint256(0), uint8(1));
    }
}
