// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {console} from "forge-std/console.sol";

import {ContributionsParamsController} from "contracts/factory/ContributionsParamsController.sol";
import {ContributionsParamsCodec} from "contracts/params/ContributionsParamsCodec.sol";
import {Common} from "script/Common.s.sol";
import {ContributionsParamsJson} from "script/lib/ContributionsParamsJson.sol";

/// @title UpdateContributionsParams
/// @notice Publish a local draft through the typed, history-preserving on-chain controller.
contract UpdateContributionsParams is Common {
    function run(string calldata controllerAddr, string calldata paramsPath, string calldata evidenceURI) public {
        ContributionsParamsController controller = ContributionsParamsController(vm.parseAddress(controllerAddr));
        ContributionsParamsCodec.Params memory current = controller.getContributionsParams();
        ContributionsParamsCodec.Params memory next = ContributionsParamsJson.read(
            paramsPath, current.claimSchemaUid, current.responseSchemaUid, current.valuationSchemaUid
        );

        vm.startBroadcast(_privateKey);
        (uint64 version, bytes32 paramsHash) = controller.updateParams(next, evidenceURI);
        vm.stopBroadcast();

        console.log("Contributions params version:", version);
        console.log("paramsHash:", vm.toString(paramsHash));
    }
}
