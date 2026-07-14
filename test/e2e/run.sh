#!/usr/bin/env bash
#
# End-to-end acceptance for the input-exporter → prover loop against a live chain.
#
#   deploy EAS + resolver + schema  ->  attest ring + revoke  ->  checkpoint  ->
#   input-exporter (self-checks re-fold == acc)  ->  prover trust-graph execute / signer execute (guest == native)
#
# This validates the exporter's real RPC + ABI-decode path (getCheckpoint / EdgeFolded / Attested /
# getAttestation) that unit tests can't reach. Starts its own anvil if none is reachable.
#
# Env overrides: RPC (default http://127.0.0.1:8545), PK (default anvil key 0).
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

RPC="${RPC:-http://127.0.0.1:8545}"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"  # anvil key 0
# Foundry auto-loads .env, and script/Common.s.sol broadcasts with FUNDED_KEY — pin it to PK so the
# scripts and the cast/prover steps act as one funded account regardless of the developer's .env.
export FUNDED_KEY="$PK"
# The executor-only steps (execute/vkey/paramshash) never produce a proof, but the default
# ProverClient backend eagerly allocates the CPU prover machine (~5 GiB). Default to the mock
# backend so this harness runs on small boxes; override SP1_PROVER for real proving.
export SP1_PROVER="${SP1_PROVER:-mock}"
WORK="$(mktemp -d)"
ANVIL_PID=""

cleanup() {
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

hex_file() { echo "0x$(od -An -v -tx1 "$1" | tr -d ' \n')"; }

for tool in forge cast anvil cargo jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: '$tool' not found in PATH"; exit 1; }
done

# --- chain -------------------------------------------------------------------
if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "== starting anvil =="
  anvil --silent &
  ANVIL_PID=$!
  for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
fi
cast block-number --rpc-url "$RPC" >/dev/null || { echo "FATAL: no chain at $RPC"; exit 1; }

# --- deploy ------------------------------------------------------------------
echo "== deploy EAS + resolver + schema =="
forge script script/DeployEasResolver.s.sol:DeployEasResolver \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null
EAS=$(jq -r .eas test/e2e/deploy.json)
RESOLVER=$(jq -r .resolver test/e2e/deploy.json)
SCHEMA=$(jq -r .schema_uid test/e2e/deploy.json)
echo "   EAS=$EAS"
echo "   RESOLVER=$RESOLVER"
echo "   SCHEMA=$SCHEMA"

# --- attest ------------------------------------------------------------------
echo "== attest ring (3) =="
forge script script/E2eAttest.s.sol:E2eAttest --sig "run(address,bytes32)" "$EAS" "$SCHEMA" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null

# --- revoke (discover the REAL on-chain uid; see E2eAttest.s.sol) -------------
echo "== revoke a0's attestation =="
A0=$(cast wallet address --private-key "$PK" | tr '[:upper:]' '[:lower:]')
SIG=$(cast keccak "Attested(address,address,bytes32,bytes32)")
A0_TOPIC="0x000000000000000000000000${A0#0x}"   # address left-padded to a 32-byte topic
# NB: bash's $UID is a readonly builtin — use a different name.
ATT_UID=$(cast rpc eth_getLogs \
  "{\"address\":\"$EAS\",\"fromBlock\":\"0x0\",\"toBlock\":\"latest\",\"topics\":[\"$SIG\",null,\"$A0_TOPIC\"]}" \
  --rpc-url "$RPC" | jq -r '.[0].data' | cut -c1-66)
{ [ -n "$ATT_UID" ] && [ "$ATT_UID" != "null" ]; } || { echo "FATAL: could not find a0's attestation uid"; exit 1; }
cast send "$EAS" "revoke((bytes32,(bytes32,uint256)))" "($SCHEMA,($ATT_UID,0))" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null
echo "   revoked uid=$ATT_UID"

# --- checkpoint --------------------------------------------------------------
echo "== freeze checkpoint 0 =="
cast send "$RESOLVER" "checkpoint()" --rpc-url "$RPC" --private-key "$PK" >/dev/null
LEAF=$(cast call "$RESOLVER" "leafCount()(uint64)" --rpc-url "$RPC")
echo "   leafCount=$LEAF (expected 4)"

# --- params (schema_uid from the deploy) -------------------------------------
jq --arg s "$SCHEMA" '.schema_uid = $s' test/e2e/params.template.json > "$WORK/params.json"

# --- export ------------------------------------------------------------------
echo "== export GuestInput =="
cargo run -q -p input-exporter -- \
  --rpc "$RPC" --accumulator "$RESOLVER" --eas "$EAS" \
  --checkpoint 0 --params "$WORK/params.json" --out "$WORK/input.json"

echo "== export SignerInput =="
cargo run -q -p input-exporter -- \
  --rpc "$RPC" --accumulator "$RESOLVER" --eas "$EAS" \
  --checkpoint 0 --params "$WORK/params.json" \
  --signer --selection test/e2e/selection.json --out "$WORK/signer_input.json"

# --- prove-execute cross-check ----------------------------------------------
echo "== prover execute (guest == native) =="
EXEC_OUT=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph execute "$WORK/input.json" )
echo "$EXEC_OUT"

echo "== prover signer-execute (guest == native) =="
SIGNER_EXEC_OUT=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- signer execute "$WORK/signer_input.json" )
echo "$SIGNER_EXEC_OUT"

# --- on-chain submit (E2E_ONCHAIN=1, default) ---------------------------------
# Proves both programs through the CLI with SP1_PROVER=mock and lands the proofs on anvil through
# the REAL SP1JournalVerifier + MerkleSnapshot / SignerSyncZkModule paths. Only the SNARK check is
# stubbed (MockSP1Gateway at the ISP1Verifier seam): journal-digest binding, vkey pinning, proof-blob
# decoding, checkpoint monotonicity, and the Safe owner swap are all the production code paths.
# For a REAL proof, run with SP1_PROVER=network (or cpu on a 16-32 GiB box + --features native-gnark)
# and deploy against the canonical gateway instead.
if [ "${E2E_ONCHAIN:-1}" = "1" ]; then
  DEPLOYER=$(cast wallet address --private-key "$PK")

  echo "== prove (mock) both programs via the CLI =="
  ( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph prove "$WORK/input.json" --groth16 )
  ( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- signer prove "$WORK/signer_input.json" --groth16 )

  echo "== derive vkeys + params hashes via the CLI =="
  VKEY=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph vkey )
  SIGNER_VKEY=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- signer vkey )
  PARAMS_HASH=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph paramshash "$WORK/input.json" )
  SELECTION_PARAMS_HASH=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- signer selectionparamshash "$WORK/signer_input.json" )
  echo "   vkey=$VKEY signerVkey=$SIGNER_VKEY"

  echo "== deploy mock gateway + real SP1JournalVerifiers + MerkleSnapshot =="
  GATEWAY=$(forge create test/mocks/MockSP1Gateway.sol:MockSP1Gateway \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
  cast send "$GATEWAY" "setExpectedVKey(bytes32)" "$VKEY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  VERIFIER=$(forge create src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$GATEWAY" "$VKEY" | jq -r .deployedTo)
  SIGNER_GATEWAY=$(forge create test/mocks/MockSP1Gateway.sol:MockSP1Gateway \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
  cast send "$SIGNER_GATEWAY" "setExpectedVKey(bytes32)" "$SIGNER_VKEY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  SIGNER_VERIFIER=$(forge create src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$SIGNER_GATEWAY" "$SIGNER_VKEY" | jq -r .deployedTo)
  SNAPSHOT=$(forge create src/contracts/merkle/MerkleSnapshot.sol:MerkleSnapshot \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$VERIFIER" "$PARAMS_HASH" "$RESOLVER" "$DEPLOYER" "$DEPLOYER" | jq -r .deployedTo)
  echo "   gateway=$GATEWAY verifier=$VERIFIER snapshot=$SNAPSHOT signerVerifier=$SIGNER_VERIFIER"

  echo "== submitProof (root producer) =="
  OUTPUT_ROOT=$(echo "$EXEC_OUT" | awk '/^outputRoot:/{print $2}')
  IPFS_HASH=$(echo "$EXEC_OUT" | awk '/^ipfsHash:/{print $2}')
  CID=$(echo "$EXEC_OUT" | awk '/^cid:/{print $2}')
  TOTAL_VALUE=$(echo "$EXEC_OUT" | awk '/^totalValue:/{print $2}')
  cast send "$SNAPSHOT" "submitProof(uint256,bytes32,bytes32,string,uint256,bytes)" \
    0 "$OUTPUT_ROOT" "$IPFS_HASH" "$CID" "$TOTAL_VALUE" "$(hex_file zk/prover/proof.bin)" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  ROOT_ONCHAIN=$(cast call "$SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" --rpc-url "$RPC" | grep -o '0x[0-9a-f]\{64\}' | head -1)
  [ "$ROOT_ONCHAIN" = "$OUTPUT_ROOT" ] || { echo "FATAL: on-chain root $ROOT_ONCHAIN != proven $OUTPUT_ROOT"; exit 1; }
  echo "   root landed on-chain: $ROOT_ONCHAIN ✓"

  echo "== deploy Safe + SignerSyncZkModule, submitSignerProof =="
  SELECTION_PARAMS_HASH="$SELECTION_PARAMS_HASH" forge script script/DeployZodiacSafes.s.sol:DeployZodiacSafes \
    --sig "run(string,string)" "$SNAPSHOT" "$SIGNER_VERIFIER" \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null
  SIGNER_MODULE=$(jq -r '.safe.signer_sync_module' .docker/zodiac_safes_deploy.json)
  SAFE=$(jq -r '.safe.address' .docker/zodiac_safes_deploy.json)
  TARGET_THRESHOLD=$(echo "$SIGNER_EXEC_OUT" | awk '/^targetThreshold:/{print $2}')
  SIGNERS=$(echo "$SIGNER_EXEC_OUT" | awk '/^  0x/{print $1}' | paste -sd, -)
  cast send "$SIGNER_MODULE" "submitSignerProof(uint256,address[],uint256,bytes)" \
    0 "[$SIGNERS]" "$TARGET_THRESHOLD" "$(hex_file zk/prover/signer_proof.bin)" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  OWNERS=$(cast call "$SAFE" "getOwners()(address[])" --rpc-url "$RPC")
  THRESHOLD=$(cast call "$SAFE" "getThreshold()(uint256)" --rpc-url "$RPC")
  echo "   safe owners now: $OWNERS (threshold $THRESHOLD) ✓"
  echo
  echo "E2E ONCHAIN PASS — both programs proven via the CLI and applied on anvil"
  echo "(SNARK check mocked at the gateway seam; run SP1_PROVER=network against the canonical"
  echo " gateway for a fully real proof)."
fi

echo
echo "E2E PASS — exporter reconstructed a live checkpoint and the guests accepted it."
