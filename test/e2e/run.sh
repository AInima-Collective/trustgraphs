#!/usr/bin/env bash
#
# End-to-end acceptance for the input-exporter → prover loop against a live chain.
#
#   deploy EAS + resolver + schema  ->  attest ring + revoke  ->  checkpoint  ->
#   input-exporter (self-checks re-fold == acc)  ->  prover execute/signer-execute (guest == native)
#
# This validates the exporter's real RPC + ABI-decode path (getCheckpoint / EdgeFolded / Attested /
# getAttestation) that unit tests can't reach. Starts its own anvil if none is reachable.
#
# Env overrides: RPC (default http://127.0.0.1:8545), PK (default anvil key 0).
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

RPC="${RPC:-http://127.0.0.1:8545}"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"  # anvil key 0
WORK="$(mktemp -d)"
ANVIL_PID=""

cleanup() {
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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
( cd zk/prover && cargo run -q --release -- execute "$WORK/input.json" )

echo "== prover signer-execute (guest == native) =="
( cd zk/prover && cargo run -q --release -- signer-execute "$WORK/signer_input.json" )

# --- optional on-chain submit (only if a real proof is present) --------------
# On a proving box: generate zk/prover/proof.bin + signer_proof.bin, deploy the verifier + module,
# and submit. Gated out of the default run because Groth16 proving needs ~16-32 GiB / the network.

echo
echo "E2E PASS — exporter reconstructed a live checkpoint and the guests accepted it."
