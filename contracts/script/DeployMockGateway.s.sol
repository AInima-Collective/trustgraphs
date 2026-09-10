// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {MockSP1Gateway} from "test/mocks/MockSP1Gateway.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployMockGateway
/// @notice DEV ONLY. Deploys a `MockSP1Gateway` to stand in for Succinct's canonical SP1 gateway on
///         a local chain, and writes its address for the deploy orchestration to thread into
///         `DeployZkVerifier`.
///
/// @dev Why this exists: `SP1_VERIFIER_GATEWAY` names a real per-chain Succinct deployment, and on a
///      non-fork anvil that address has **no code**. Every `MerkleSnapshot.submitProof` then reverts
///      inside `gateway.verifyProof` before any real check runs — so a freshly deployed local stack
///      silently cannot accept a proof at all. Found by the local proving loop, which had to
///      `anvil_setCode` a gateway in by hand to get anywhere.
///
///      The stub is at the GATEWAY seam only: the real `SP1JournalVerifier` still runs, so journal
///      digest binding, vkey pinning and proof-blob decoding are all exercised — only the SNARK
///      check itself is faked. Exactly the seam `tests/e2e/run.sh` already uses, and the one
///      `research/DEVIATIONS.md` #1 records. Never run this against a chain where a real gateway exists;
///      the dev deploy skips it when the configured gateway already has code.
contract DeployMockGateway is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Deploy the mock gateway.
    /// @param expectedVKey If nonzero, the mock rejects proofs carrying any other program vkey.
    ///        Leave it ZERO for the normal dev stack: the root and signer `SP1JournalVerifier`s
    ///        share one gateway, so pinning it to either program's vkey would reject the other.
    ///        Each adapter pins its own vkey immutably regardless — this knob only exists for a
    ///        single-program stub. Note that with `SP1_PROVER=mock` the seal is a dummy, so genuine
    ///        vkey enforcement only happens against a real gateway.
    /// @return gateway The deployed `MockSP1Gateway`.
    function run(bytes32 expectedVKey) public returns (address gateway) {
        // Chain id alone is not enough of a gate: `research/operations/trust-graph/local-testing.md` runs the
        // MAINNET FORK as `anvil --fork-url … --chain-id 31337`, whose entire purpose is that a
        // real Groth16 proof verifies against Succinct's real gateway. Silently swapping in a stub
        // there would make that rehearsal prove nothing. So refuse whenever the configured gateway
        // actually has code — which is exactly the fork case, and never the plain-anvil case.
        require(block.chainid == 31337, "DeployMockGateway: dev chains only");
        address configured = vm.envOr("SP1_VERIFIER_GATEWAY", address(0));
        require(
            configured.code.length == 0,
            "DeployMockGateway: a real gateway is deployed here (fork?) - set DEV_MOCK_SP1_GATEWAY=false"
        );

        _startBroadcast();
        MockSP1Gateway mock = new MockSP1Gateway();
        if (expectedVKey != bytes32(0)) {
            mock.setExpectedVKey(expectedVKey);
        }
        vm.stopBroadcast();

        gateway = address(mock);
        console.log("MockSP1Gateway (DEV stub) deployed at:", gateway);
        if (expectedVKey != bytes32(0)) {
            console.log("  pinned to vkey:", vm.toString(expectedVKey));
        } else {
            console.log("  accepts ANY program vkey (no SP1_PROGRAM_VKEY pinned)");
        }

        string memory _json = "json";
        string memory finalJson = _json.serialize("gateway", Strings.toChecksumHexString(gateway));
        vm.writeFile(string.concat(root, "/.docker/mock_gateway_deploy.json"), finalJson);
    }
}
