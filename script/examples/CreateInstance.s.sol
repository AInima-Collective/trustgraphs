// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";

/// @title CreateInstance
/// @notice Create one instance through the factory AND endow its proving tank in the same
///         transaction. Used by `test/e2e/fork.sh` and by the demo in `docs/build/quickstart.md`.
/// @dev Exists so the fork e2e exercises the real `createInstance` entry point (payable, with the
///      full `CreateArgs` struct and every creation-time bound) rather than a hand-rolled
///      approximation of it. Writes the resulting id to `/tmp/fork-create.json` because the
///      instance id is a hash of (creator, name, salt) and the script is the only thing that knows
///      all three.
contract CreateInstance is Script {
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
        return run(factory, prepayWei, name, msg.sender);
    }

    /// @notice Create an instance whose trust graph is rooted at `trustedSeed`.
    /// @param trustedSeed The single trusted seed. Defaults to the creator in the shorter
    ///        overloads, which is right for `fork.sh` (it creates and vouches from one key) and
    ///        wrong for the local demo, where the deployer is `FUNDED_KEY` but the vouches come
    ///        from anvil's well-known accounts. A graph the seed cannot reach scores every member
    ///        at the same floor, so this is not cosmetic.
    function run(address factory, uint256 prepayWei, string memory name, address trustedSeed)
        public
        returns (bytes32 instanceId, address snapshot, address resolver, bytes32 schemaUid)
    {
        require(trustedSeed != address(0), "CreateInstance: trustedSeed is zero");
        TrustgraphsFactory f = TrustgraphsFactory(factory);

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
        p.trustedSeeds[0] = trustedSeed;
        p.totalPool = 1_000_000 * S;
        p.precisionScale = S;
        p.weightFieldIndex = 1;
        // schemaUid / accumulator / chainId are DERIVED — the factory fills them, and submitting
        // anything but zero is rejected.

        TrustgraphsFactory.CreateArgs memory args = TrustgraphsFactory.CreateArgs({
            name: name,
            metadataURI: "ipfs://fork-e2e",
            params: p,
            admin: msg.sender,
            epochLength: 5,
            // Bundle the rewards distributor. The factory owns it outright and hands it to the
            // admin, so a demo network can publish a distribution against its proven root without
            // a second deploy. Catalog-derived, so the UI picks it up with no config entry.
            withDistributor: true,
            distributorToken: address(0),
            salt: bytes32(0)
        });

        vm.startBroadcast();
        (instanceId, snapshot, resolver,, schemaUid) = f.createInstance{value: prepayWei}(args);
        vm.stopBroadcast();

        // The directory is not guaranteed to exist: it is gitignored, and a `rm -rf .trustgraph`
        // between runs is routine. Without this the whole script reverts AFTER the instance has
        // already been created and paid for on chain.
        vm.createDir(".trustgraph", true);

        string memory out = "fork";
        vm.serializeUint(out, "prepayWei", prepayWei);
        vm.serializeAddress(out, "snapshot", snapshot);
        vm.serializeAddress(out, "resolver", resolver);
        vm.serializeBytes32(out, "schemaUid", schemaUid);
        string memory json = vm.serializeBytes32(out, "instanceId", instanceId);
        vm.writeFile(".trustgraph/create-instance.json", json);

        console.log("instanceId:");
        console.logBytes32(instanceId);
    }
}
