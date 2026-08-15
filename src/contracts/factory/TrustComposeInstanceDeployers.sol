// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {CompositionSourceAccumulator} from "contracts/composition/CompositionSourceAccumulator.sol";
import {TrustComposeParamsController} from "contracts/factory/TrustComposeParamsController.sol";
import {TrustComposeParamsCodec} from "contracts/params/TrustComposeParamsCodec.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @notice Holds composition accumulator creation code outside the public factory runtime.
contract CompositionSourceAccumulatorDeployer {
    function deploy(ICompositionSourceAdapterFactory adapterFactory) external returns (CompositionSourceAccumulator) {
        return new CompositionSourceAccumulator(adapterFactory, msg.sender);
    }
}

/// @notice Holds the timelocked controller creation code outside the public factory runtime.
contract TrustComposeParamsControllerDeployer {
    function deploy(
        bytes32 instanceId,
        address snapshot,
        CompositionSourceAccumulator accumulator,
        IInstanceRegistry registry,
        TrustComposeParamsCodec.Params calldata initialParams,
        bytes calldata initialManifest,
        address[] calldata initialAdapters,
        bytes32 initialMetadataDigest,
        address owner,
        uint48 activationDelay
    ) external returns (TrustComposeParamsController) {
        return new TrustComposeParamsController(
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
