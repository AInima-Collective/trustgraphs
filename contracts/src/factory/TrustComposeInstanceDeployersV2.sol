// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {CompositionSourceAccumulatorV2} from "src/composition/CompositionSourceAccumulatorV2.sol";
import {TrustComposeParamsControllerV2} from "src/factory/TrustComposeParamsControllerV2.sol";
import {TrustComposeParamsCodecV2} from "src/params/TrustComposeParamsCodecV2.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @notice Holds V2 composition accumulator creation code outside the public factory runtime.
contract CompositionSourceAccumulatorV2Deployer {
    function deploy(ICompositionSourceAdapterFactory adapterFactory) external returns (CompositionSourceAccumulatorV2) {
        return new CompositionSourceAccumulatorV2(adapterFactory, msg.sender);
    }
}

/// @notice Holds the V2 timelocked controller creation code outside the public factory runtime.
contract TrustComposeParamsControllerV2Deployer {
    function deploy(
        bytes32 instanceId,
        address snapshot,
        CompositionSourceAccumulatorV2 accumulator,
        IInstanceRegistry registry,
        TrustComposeParamsCodecV2.Params calldata initialParams,
        bytes calldata initialManifest,
        address[] calldata initialAdapters,
        bytes32 initialMetadataDigest,
        address owner,
        uint48 activationDelay
    ) external returns (TrustComposeParamsControllerV2) {
        return new TrustComposeParamsControllerV2(
            instanceId,
            snapshot,
            accumulator,
            registry,
            initialParams,
            initialManifest,
            initialAdapters,
            initialMetadataDigest,
            owner,
            msg.sender,
            activationDelay
        );
    }
}
