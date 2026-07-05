// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { stdJson } from 'forge-std/StdJson.sol';
import { console } from 'forge-std/console.sol';
import { Strings } from '@openzeppelin/contracts/utils/Strings.sol';

import { ISP1Verifier } from 'interfaces/merkle/ISP1Verifier.sol';
import {
  SP1TrustGraphVerifier
} from 'contracts/merkle/SP1TrustGraphVerifier.sol';

import { Common } from 'script/Common.s.sol';

/// @title DeployZkVerifier
/// @notice Deploys the `SP1TrustGraphVerifier` adapter that gates `MerkleSnapshot.submitProof`.
///
/// This script does NOT deploy an SP1 verifier gateway: the canonical Groth16 gateway is a shared,
/// audited Succinct deployment (per-chain). Its address is taken as an INPUT so we point at the
/// already-deployed canonical gateway rather than hardcoding it. The `programVKey` (guest image id)
/// is likewise an input — it is the constitutional "what is correct PageRank" knob and is immutable
/// in the adapter (see `SP1TrustGraphVerifier` / DECISIONS D8).
///
/// The deployed adapter address is written to `.docker/zk_verifier_deploy.json` so the TypeScript
/// deploy orchestration can thread it into `DeployNetwork` as `MerkleSnapshot.zkVerifier`.
contract DeployZkVerifier is Common {
  using stdJson for string;

  string public root = vm.projectRoot();
  string public script_output_path =
    string.concat(root, '/.docker/zk_verifier_deploy.json');

  /// @notice Deploy the SP1 verifier adapter.
  /// @param sp1GatewayAddr The already-deployed canonical SP1 verifier gateway address. If empty,
  ///        falls back to the `SP1_VERIFIER_GATEWAY` env var.
  /// @param programVKey The SP1 guest program verification key (image id). If zero, falls back to
  ///        the `SP1_PROGRAM_VKEY` env var.
  /// @return verifier The deployed `SP1TrustGraphVerifier` address.
  function run(
    string calldata sp1GatewayAddr,
    bytes32 programVKey
  ) public returns (address verifier) {
    // Gateway: prefer the explicit param, else the env var. Never hardcoded.
    address gateway = bytes(sp1GatewayAddr).length == 0
      ? vm.envAddress('SP1_VERIFIER_GATEWAY')
      : vm.parseAddress(sp1GatewayAddr);
    require(gateway != address(0), 'DeployZkVerifier: gateway is zero');

    // Program vkey: prefer the explicit param, else the env var.
    bytes32 vkey = programVKey == bytes32(0)
      ? vm.envBytes32('SP1_PROGRAM_VKEY')
      : programVKey;
    require(vkey != bytes32(0), 'DeployZkVerifier: programVKey is zero');

    vm.startBroadcast(_privateKey);

    SP1TrustGraphVerifier sp1Verifier = new SP1TrustGraphVerifier(
      ISP1Verifier(gateway),
      vkey
    );
    verifier = address(sp1Verifier);

    vm.stopBroadcast();

    console.log('SP1 verifier gateway:', gateway);
    console.log('SP1 program vkey:', vm.toString(vkey));
    console.log('SP1TrustGraphVerifier deployed at:', verifier);

    // Persist for the deploy orchestration (env.ts reads `zk_verifier`).
    string memory _json = 'json';
    _json.serialize(
      'sp1_gateway',
      Strings.toChecksumHexString(gateway)
    );
    _json.serialize('program_vkey', vm.toString(vkey));
    string memory finalJson = _json.serialize(
      'zk_verifier',
      Strings.toChecksumHexString(verifier)
    );
    vm.writeFile(script_output_path, finalJson);
  }
}
