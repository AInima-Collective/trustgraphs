// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {TrustGraphFactory} from "contracts/factory/TrustGraphFactory.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";

/// @title ForkCreate
/// @notice Create one instance through the factory AND endow its proving tank in the same
///         transaction, for `test/e2e/fork.sh`.
/// @dev Exists so the fork e2e exercises the real `createInstance` entry point (payable, with the
///      full `CreateArgs` struct and every creation-time bound) rather than a hand-rolled
///      approximation of it. Writes the resulting id to `/tmp/fork-create.json` because the
///      instance id is a hash of (creator, name, salt) and the script is the only thing that knows
///      all three.
contract ForkCreate is Script {
    using stdJson for string;

    uint256 constant S = 1e18;

    function run(address factory, uint256 prepayWei)
        public
        returns (bytes32 instanceId, address snapshot, address resolver, bytes32 schemaUid)
    {
        return run(factory, prepayWei, "fork-e2e");
    }

    function run(address factory, uint256 prepayWei, string memory name)
        public
        returns (bytes32 instanceId, address snapshot, address resolver, bytes32 schemaUid)
    {
        TrustGraphFactory f = TrustGraphFactory(factory);

        ParamsCodec.Params memory p;
        p.dampingFp = (85 * S) / 100;
        p.toleranceFp = S / 1_000_000;
        p.maxIterations = 100;
        p.minWeightFp = 0;
        p.maxWeightFp = 100 * S;
        p.trustMultiplierFp = 2 * S;
        p.trustShareFp = (15 * S) / 100;
        p.trustDecayFp = (80 * S) / 100;
        p.trustedSeeds = new address[](1);
        p.trustedSeeds[0] = msg.sender;
        p.totalPool = 1_000_000 * S;
        p.precisionScale = S;
        p.weightFieldIndex = 1;
        // schemaUid / accumulator / chainId are DERIVED — the factory fills them, and submitting
        // anything but zero is rejected.

        TrustGraphFactory.CreateArgs memory args = TrustGraphFactory.CreateArgs({
            name: name,
            metadataURI: "ipfs://fork-e2e",
            params: p,
            admin: msg.sender,
            epochLength: 5,
            withDistributor: false,
            distributorToken: address(0),
            salt: bytes32(0)
        });

        vm.startBroadcast();
        (instanceId, snapshot, resolver,, schemaUid) = f.createInstance{value: prepayWei}(args);
        vm.stopBroadcast();

        string memory out = "fork";
        vm.serializeUint(out, "prepayWei", prepayWei);
        vm.serializeAddress(out, "snapshot", snapshot);
        vm.serializeAddress(out, "resolver", resolver);
        vm.serializeBytes32(out, "schemaUid", schemaUid);
        string memory json = vm.serializeBytes32(out, "instanceId", instanceId);
        vm.writeFile(".trustgraph/fork-create.json", json);

        console.log("instanceId:");
        console.logBytes32(instanceId);
    }
}
