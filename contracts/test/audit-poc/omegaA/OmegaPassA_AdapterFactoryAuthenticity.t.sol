// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
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
/// The factory now pins one canonical registry at deployment and refuses a caller-supplied
/// lookalike before the append-only authenticity ledger can be polluted.
contract OmegaPassA_AdapterFactoryAuthenticity is Test {
    function test_PassA_ForgedRegistryCannotMintAnAuthenticatedAdapter() public {
        FakeSnapshot snap = new FakeSnapshot();
        FakeVerifier ver = new FakeVerifier();
        FakeRegistry canonical = new FakeRegistry(address(snap), address(ver));
        FakeRegistry forged = new FakeRegistry(address(snap), address(ver));
        CompositionSourceAdapterFactory factory =
            new CompositionSourceAdapterFactory(IInstanceRegistry(address(canonical)));

        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAdapterFactory.ForeignRegistry.selector, address(canonical), address(forged)
            )
        );
        factory.create(
            IInstanceRegistry(address(forged)),
            keccak256("any-id"),
            keccak256("source"),
            keccak256("family"),
            keccak256("allocation"),
            keccak256("looks-reviewed")
        );
        assertEq(address(factory.registry()), address(canonical));
    }
}
