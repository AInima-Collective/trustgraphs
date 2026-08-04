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
# Unlike the demo and the operator/fork harnesses, this script does NOT set
# SP1_SKIP_PROGRAM_BUILD, so zk/prover/build.rs builds the guests for it — but only if the SP1
# toolchain is installed. Say which command is missing rather than letting cargo fail on a
# `succinct` toolchain it can't find, minutes in. `task zk:build` up front makes this run fast.
command -v cargo-prove >/dev/null 2>&1 || {
  echo "FATAL: 'cargo-prove' not found in PATH — the SP1 guests cannot be built."
  echo "  curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up --version v6.3.1"
  echo "  export PATH=\"\$HOME/.sp1/bin:\$PATH\""
  exit 1
}

# Journal v3: the bounty payee the guest commits and submitProof binds. A non-zero default so the
# e2e actually exercises the binding rather than the all-zero path.
RECIPIENT="${RECIPIENT:-0x00000000000000000000000000000000000000BE}"

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
SNAPSHOT=$(jq -r .snapshot test/e2e/deploy.json)
PARAMS_HASH=$(jq -r .params_hash test/e2e/deploy.json)
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
echo "   EAS=$EAS"
echo "   RESOLVER=$RESOLVER"
echo "   SCHEMA=$SCHEMA"
echo "   SNAPSHOT=$SNAPSHOT (accumulator bound; trigger() is the only checkpoint mint)"

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
# Through trigger(), never the resolver directly: the accumulator is bound to this snapshot, so
# trigger() is the only mint (issue #10) and the only thing that pins the checkpoint's paramsHash.
echo "== freeze checkpoint 0 (via trigger) =="
cast send "$SNAPSHOT" "trigger()" --rpc-url "$RPC" --private-key "$PK" >/dev/null
LEAF=$(cast call "$RESOLVER" "leafCount()(uint64)" --rpc-url "$RPC")
PINNED=$(cast call "$SNAPSHOT" "checkpointParamsHash(uint256)(bytes32)" 0 --rpc-url "$RPC")
echo "   leafCount=$LEAF (expected 4)"
[ "$PINNED" = "$PARAMS_HASH" ] || { echo "FATAL: checkpoint 0 pinned $PINNED != $PARAMS_HASH"; exit 1; }
echo "   checkpoint 0 pinned paramsHash=$PINNED ✓"

# A stranger cannot mint a checkpoint behind the snapshot's back (issue #10 regression).
if cast send "$RESOLVER" "checkpoint()" --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1; then
  echo "FATAL: direct accumulator.checkpoint() succeeded — the snapshot binding is not enforced"
  exit 1
fi
echo "   direct accumulator.checkpoint() rejected ✓"

# --- params (schema_uid from the deploy) -------------------------------------
jq --arg s "$SCHEMA" '.schema_uid = $s' test/e2e/params.template.json > "$WORK/params.json"

# --- export ------------------------------------------------------------------
echo "== export GuestInput =="
cargo run -q -p input-exporter -- \
  --rpc "$RPC" --accumulator "$RESOLVER" --eas "$EAS" \
  --checkpoint 0 --params "$WORK/params.json" --snapshot "$SNAPSHOT" \
  --recipient "$RECIPIENT" --out "$WORK/input.json"

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
  # The exporter's params must hash to what the deploy already pinned into the snapshot; if they
  # ever drift, every proof for this instance is dead on arrival, so check rather than assume.
  EXPORTED_PARAMS_HASH=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph paramshash "$WORK/input.json" )
  [ "$EXPORTED_PARAMS_HASH" = "$PARAMS_HASH" ] || {
    echo "FATAL: exporter paramsHash $EXPORTED_PARAMS_HASH != deployed $PARAMS_HASH"; exit 1; }
  SELECTION_PARAMS_HASH=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- signer selectionparamshash "$WORK/signer_input.json" )
  echo "   vkey=$VKEY signerVkey=$SIGNER_VKEY"

  echo "== deploy mock gateway + real SP1JournalVerifiers, re-point the snapshot =="
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
  # The snapshot already exists (it had to: only its trigger() can mint a checkpoint). Swap the
  # accept-all deploy verifier for the real SP1JournalVerifier through the constitutional knob the
  # deployer still holds. Deliberately NOT pinned per checkpoint — a verifier rotation is the
  # SP1-soundness emergency path and must invalidate in-flight proofs.
  cast send "$SNAPSHOT" "setZkVerifier(address)" "$VERIFIER" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  echo "   gateway=$GATEWAY verifier=$VERIFIER snapshot=$SNAPSHOT signerVerifier=$SIGNER_VERIFIER"

  echo "== submitProof (root producer) =="
  OUTPUT_ROOT=$(echo "$EXEC_OUT" | awk '/^outputRoot:/{print $2}')
  IPFS_HASH=$(echo "$EXEC_OUT" | awk '/^ipfsHash:/{print $2}')
  CID=$(echo "$EXEC_OUT" | awk '/^cid:/{print $2}')
  TOTAL_VALUE=$(echo "$EXEC_OUT" | awk '/^totalValue:/{print $2}')
  # Journal v3: lane-1-only run, skippedDigest is the zero word; `recipient` is echoed back from
  # the guest, because submitProof folds it into the digest.
  ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
  PROVEN_RECIPIENT=$(echo "$EXEC_OUT" | awk '/^recipient:/{print $2}')
  lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
  [ "$(lower "$PROVEN_RECIPIENT")" = "$(lower "$RECIPIENT")" ] || {
    echo "FATAL: guest committed recipient $PROVEN_RECIPIENT != requested $RECIPIENT"; exit 1; }
  cast send "$SNAPSHOT" "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
    0 "$OUTPUT_ROOT" "$IPFS_HASH" "$CID" "$TOTAL_VALUE" "$ZERO32" "$PROVEN_RECIPIENT" \
    "$(hex_file .trustgraph/trust-graph/proof.bin)" \
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
    0 "[$SIGNERS]" "$TARGET_THRESHOLD" "$(hex_file .trustgraph/signer-sync/signer_proof.bin)" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  OWNERS=$(cast call "$SAFE" "getOwners()(address[])" --rpc-url "$RPC")
  THRESHOLD=$(cast call "$SAFE" "getThreshold()(uint256)" --rpc-url "$RPC")
  echo "   safe owners now: $OWNERS (threshold $THRESHOLD) ✓"
  echo
  echo "E2E ONCHAIN PASS — both programs proven via the CLI and applied on anvil"
  echo "(SNARK check mocked at the gateway seam; run SP1_PROVER=network against the canonical"
  echo " gateway for a fully real proof)."

  # --- TWO-LANE stage (M2 exit): lane-1 EAS edges + lane-2 envelope-0 in ONE journal ---------
  echo
  echo "== two-lane: deploy AnchorRegistry, wire it into MerkleSnapshot =="
  REGISTRY=$(forge create src/contracts/registry/AnchorRegistry.sol:AnchorRegistry \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$DEPLOYER" | jq -r .deployedTo)
  cast send "$SNAPSHOT" "setAnchorRegistry(address)" "$REGISTRY" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  echo "   registry=$REGISTRY"

  echo "== two-lane: attester builds + anchors a signed envelope-0 log =="
  ATTESTER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d  # anvil key 1
  DS=$(cast keccak "e2e-envelope0-domain")
  GEN_OUT=$(cargo run -q -p input-exporter --bin envelope0-gen -- \
    --key "$ATTESTER_KEY" --domain-separator "$DS" --schema "$SCHEMA" \
    --attest "$A0:80" --attest "0x0000000000000000000000000000000000000005:40" --revoke 1 \
    --out "$WORK/envelope0_log.json")
  echo "$GEN_OUT"
  NODE_ID=$(echo "$GEN_OUT" | awk '/^nodeId:/{print $2}')
  HEAD=$(echo "$GEN_OUT" | awk '/^head:/{print $2}')
  cast send "$REGISTRY" "register()" --rpc-url "$RPC" --private-key "$ATTESTER_KEY" >/dev/null
  cast send "$REGISTRY" "anchor(bytes32,uint8,bytes32,bytes32)" "$NODE_ID" 0 "$HEAD" "$ZERO32" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null   # third-party relay: permissionless anchor

  echo "== two-lane: a second node anchors a head and WITHHOLDS the data (rule Φ) =="
  WITHHELD_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a  # anvil key 2
  WITHHELD_ADDR=$(cast wallet address --private-key "$WITHHELD_KEY")
  WITHHELD_NODE=$(cast keccak "$(cast abi-encode "f(address)" "$WITHHELD_ADDR")")
  cast send "$REGISTRY" "register()" --rpc-url "$RPC" --private-key "$WITHHELD_KEY" >/dev/null
  cast send "$REGISTRY" "anchor(bytes32,uint8,bytes32,bytes32)" \
    "$WITHHELD_NODE" 0 0x00000000000000000000000000000000000000000000000000000000deadbeef "$ZERO32" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null

  # Enabling lane 2 changes the params, and params take effect at the NEXT boundary: every
  # checkpoint is proven under the hash pinned when its inputs froze. So rotate FIRST, then
  # trigger. (Rotating after the trigger would leave checkpoint 1 pinned to the lane-1 params and
  # this lane-2 proof would not verify — which is the point of pinning, exercised below.)
  echo "== two-lane: rotate params (lane 2 on) BEFORE the boundary =="
  jq --arg s "$SCHEMA" --arg d "$DS" \
    '.schema_uid = $s | .envelope0_domain_separators = [$d] | .lane2_max_head_age = 1000000000' \
    test/e2e/params.template.json > "$WORK/params2.json"
  # Filled from the connection the way input-exporter does, so the hash matches what the guest
  # will commit for this instance.
  jq --arg a "$RESOLVER" --argjson c "$CHAIN_ID" '.accumulator = $a | .chain_id = $c' \
    "$WORK/params2.json" > "$WORK/params2.filled.json"
  PARAMS2_HASH=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph paramshash --params "$WORK/params2.filled.json" )
  cast send "$SNAPSHOT" "setParamsHash(bytes32)" "$PARAMS2_HASH" --rpc-url "$RPC" --private-key "$PK" >/dev/null

  echo "== two-lane: fresh lane-1 inputs + trigger() checkpoints BOTH lanes =="
  forge script script/E2eAttest.s.sol:E2eAttest --sig "run(address,bytes32)" "$EAS" "$SCHEMA" \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null
  cast send "$SNAPSHOT" "trigger()" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  ANCHOR_CP=$(cast call "$SNAPSHOT" "anchorCheckpoints(uint256)(bytes32,uint64)" 1 --rpc-url "$RPC")
  PINNED2=$(cast call "$SNAPSHOT" "checkpointParamsHash(uint256)(bytes32)" 1 --rpc-url "$RPC")
  echo "   anchorCheckpoints(1): $ANCHOR_CP"
  [ "$PINNED2" = "$PARAMS2_HASH" ] || { echo "FATAL: checkpoint 1 pinned $PINNED2 != $PARAMS2_HASH"; exit 1; }
  [ "$PINNED2" != "$PARAMS_HASH" ] || { echo "FATAL: the rotation did not bind the new checkpoint"; exit 1; }
  echo "   checkpoint 1 pinned the ROTATED paramsHash ✓ (checkpoint 0 keeps $PARAMS_HASH)"

  echo "== two-lane: export (lane-1 re-fold + lane-2 anchor re-fold self-checks) =="
  cargo run -q -p input-exporter -- \
    --rpc "$RPC" --accumulator "$RESOLVER" --eas "$EAS" \
    --checkpoint 1 --params "$WORK/params2.json" \
    --anchor-registry "$REGISTRY" --snapshot "$SNAPSHOT" --recipient "$RECIPIENT" \
    --envelope0-log "$WORK/envelope0_log.json" \
    --out "$WORK/input2.json"

  echo "== two-lane: prove via the CLI and land the journal-v3 proof =="
  EXEC2_OUT=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph execute "$WORK/input2.json" )
  echo "$EXEC2_OUT"
  ( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph prove "$WORK/input2.json" --groth16 >/dev/null )
  OUTPUT_ROOT2=$(echo "$EXEC2_OUT" | awk '/^outputRoot:/{print $2}')
  IPFS_HASH2=$(echo "$EXEC2_OUT" | awk '/^ipfsHash:/{print $2}')
  CID2=$(echo "$EXEC2_OUT" | awk '/^cid:/{print $2}')
  TOTAL_VALUE2=$(echo "$EXEC2_OUT" | awk '/^totalValue:/{print $2}')
  SKIPPED2=$(echo "$EXEC2_OUT" | awk '/^skippedDigest:/{print $2}')
  [ "$SKIPPED2" != "$ZERO32" ] || { echo "FATAL: withheld head did not produce a skippedDigest"; exit 1; }
  echo "   skippedDigest (withheld node recorded): $SKIPPED2 ✓"
  RECIPIENT2=$(echo "$EXEC2_OUT" | awk '/^recipient:/{print $2}')
  cast send "$SNAPSHOT" "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
    1 "$OUTPUT_ROOT2" "$IPFS_HASH2" "$CID2" "$TOTAL_VALUE2" "$SKIPPED2" "$RECIPIENT2" \
    "$(hex_file .trustgraph/trust-graph/proof.bin)" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  ROOT2_ONCHAIN=$(cast call "$SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" --rpc-url "$RPC" | grep -o '0x[0-9a-f]\{64\}' | head -1)
  [ "$ROOT2_ONCHAIN" = "$OUTPUT_ROOT2" ] || { echo "FATAL: two-lane root $ROOT2_ONCHAIN != proven $OUTPUT_ROOT2"; exit 1; }
  echo "   two-lane root landed on-chain: $ROOT2_ONCHAIN ✓"
  echo
  echo "E2E TWO-LANE PASS — lane-1 EAS edges + lane-2 envelope-0 in one proven journal,"
  echo "with a withheld head degraded via rule Φ and publicly committed in skippedDigest."

  # --- HYPERCERTS instance (M4 exit): lane-2-only, envelope 1, seeded two-repo fixture ------
  echo
  echo "== hypercerts: emit the two-repo fixture GuestInput =="
  GEN_HC=$(cargo run -q -p hypercerts-core --example emit_fixture_input "$WORK/hc_input.json")
  echo "$GEN_HC"
  HC_NODE_A=$(echo "$GEN_HC" | sed -n 1p | grep -o 'nodeId=0x[0-9a-f]*' | cut -d= -f2)
  HC_HEAD_A=$(echo "$GEN_HC" | sed -n 1p | grep -o 'head=0x[0-9a-f]*' | cut -d= -f2)
  HC_NODE_B=$(echo "$GEN_HC" | sed -n 2p | grep -o 'nodeId=0x[0-9a-f]*' | cut -d= -f2)
  HC_HEAD_B=$(echo "$GEN_HC" | sed -n 2p | grep -o 'head=0x[0-9a-f]*' | cut -d= -f2)

  echo "== hypercerts: deploy the lane-2-only instance =="
  HC_VKEY=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- hypercerts vkey )
  HC_PARAMS_HASH=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- hypercerts paramshash "$WORK/hc_input.json" )
  HC_EMPTY_ACC=$(forge create src/contracts/merkle/EmptyLaneAccumulator.sol:EmptyLaneAccumulator \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
  HC_REGISTRY=$(forge create src/contracts/registry/AnchorRegistry.sol:AnchorRegistry \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$DEPLOYER" | jq -r .deployedTo)
  HC_GATEWAY=$(forge create test/mocks/MockSP1Gateway.sol:MockSP1Gateway \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
  cast send "$HC_GATEWAY" "setExpectedVKey(bytes32)" "$HC_VKEY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  HC_VERIFIER=$(forge create src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$HC_GATEWAY" "$HC_VKEY" | jq -r .deployedTo)
  HC_SNAPSHOT=$(forge create src/contracts/merkle/MerkleSnapshot.sol:MerkleSnapshot \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$HC_VERIFIER" "$HC_PARAMS_HASH" "$HC_EMPTY_ACC" "$DEPLOYER" "$DEPLOYER" | jq -r .deployedTo)
  cast send "$HC_SNAPSHOT" "setAnchorRegistry(address)" "$HC_REGISTRY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  # Bind the lane-1 seam to this snapshot: on a lane-2-only instance lane 1 is constant (0, 0), so
  # the checkpoint id is the ONLY thing separating one epoch's inputs from another's.
  cast send "$HC_EMPTY_ACC" "bindSnapshot(address)" "$HC_SNAPSHOT" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  HC_DOMAIN=$(cast keccak "$(cast abi-encode "f(address,uint256)" "$HC_SNAPSHOT" "$CHAIN_ID")")
  echo "   registry=$HC_REGISTRY snapshot=$HC_SNAPSHOT verifier=$HC_VERIFIER (vkey=$HC_VKEY)"
  echo "   instanceDomain=$HC_DOMAIN — the ONLY instance-unique word in this program's journal"

  echo "== hypercerts: register DID nodes (REGISTRAR gate = PDS-allowlist stand-in) + anchor heads =="
  cast send "$HC_REGISTRY" "registerNode(bytes32,uint8)" "$HC_NODE_A" 1 --rpc-url "$RPC" --private-key "$PK" >/dev/null
  cast send "$HC_REGISTRY" "registerNode(bytes32,uint8)" "$HC_NODE_B" 1 --rpc-url "$RPC" --private-key "$PK" >/dev/null
  cast send "$HC_REGISTRY" "anchor(bytes32,uint8,bytes32,bytes32)" "$HC_NODE_A" 1 "$HC_HEAD_A" "$ZERO32" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  TS_A=$(cast block latest --field timestamp --rpc-url "$RPC")
  cast send "$HC_REGISTRY" "anchor(bytes32,uint8,bytes32,bytes32)" "$HC_NODE_B" 1 "$HC_HEAD_B" "$ZERO32" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  TS_B=$(cast block latest --field timestamp --rpc-url "$RPC")
  # The witness anchors must carry the REAL chain timestamps so the guest re-fold matches
  # the checkpointed anchorAcc.
  # ...and the journal-v3 bindings must name THIS snapshot, or submitProof rebuilds a different
  # digest. `emit_fixture_input` cannot know the address, so it is filled here.
  jq --argjson a "$TS_A" --argjson b "$TS_B" --arg d "$HC_DOMAIN" --arg r "$RECIPIENT" \
    '.anchors[0].block_timestamp = $a | .anchors[1].block_timestamp = $b
     | .binding = {recipient: $r, instance_domain: $d}' \
    "$WORK/hc_input.json" > "$WORK/hc_input_chain.json"

  echo "== hypercerts: trigger checkpoints both lanes (lane 1 = the empty accumulator) =="
  cast send "$HC_SNAPSHOT" "trigger()" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  echo "   anchorCheckpoints(0): $(cast call "$HC_SNAPSHOT" "anchorCheckpoints(uint256)(bytes32,uint64)" 0 --rpc-url "$RPC")"

  echo "== hypercerts: prove via the CLI and land the journal-v2 proof =="
  HC_EXEC=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- hypercerts execute "$WORK/hc_input_chain.json" )
  echo "$HC_EXEC"
  ( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- hypercerts prove "$WORK/hc_input_chain.json" --groth16 >/dev/null )
  HC_ROOT=$(echo "$HC_EXEC" | awk '/^outputRoot:/{print $2}')
  HC_IPFS=$(echo "$HC_EXEC" | awk '/^ipfsHash:/{print $2}')
  HC_CID=$(echo "$HC_EXEC" | awk '/^cid:/{print $2}')
  HC_TOTAL=$(echo "$HC_EXEC" | awk '/^totalValue:/{print $2}')
  HC_SKIPPED=$(echo "$HC_EXEC" | awk '/^skippedDigest:/{print $2}')
  HC_RECIPIENT=$(echo "$HC_EXEC" | awk '/^recipient:/{print $2}')
  HC_PROVEN_DOMAIN=$(echo "$HC_EXEC" | awk '/^instanceDomain:/{print $2}')
  [ "$HC_SKIPPED" != "$ZERO32" ] || { echo "FATAL: fixture self-edge did not land in skippedDigest"; exit 1; }
  [ "$(lower "$HC_PROVEN_DOMAIN")" = "$(lower "$HC_DOMAIN")" ] || {
    echo "FATAL: guest committed domain $HC_PROVEN_DOMAIN != this instance's $HC_DOMAIN"; exit 1; }
  cast send "$HC_SNAPSHOT" "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
    0 "$HC_ROOT" "$HC_IPFS" "$HC_CID" "$HC_TOTAL" "$HC_SKIPPED" "$HC_RECIPIENT" \
    "$(hex_file .trustgraph/hypercerts/hypercerts_proof.bin)" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  HC_ROOT_ONCHAIN=$(cast call "$HC_SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" --rpc-url "$RPC" | grep -o '0x[0-9a-f]\{64\}' | head -1)
  [ "$HC_ROOT_ONCHAIN" = "$HC_ROOT" ] || { echo "FATAL: hypercerts root $HC_ROOT_ONCHAIN != proven $HC_ROOT"; exit 1; }
  echo "   hypercerts root landed on-chain: $HC_ROOT_ONCHAIN ✓ (skippedDigest $HC_SKIPPED)"

  echo "== hypercerts: an identically-configured twin refuses the same proof (issue #9) =="
  # Same vkey, same paramsHash, same (empty) lane 1, same anchor set: before journal v3 these two
  # instances accepted each other's proofs, because nothing in this program's params names an
  # instance. The twin's checkpoint is frozen at the same anchor state, so ONLY the domain differs.
  HC_TWIN_ACC=$(forge create src/contracts/merkle/EmptyLaneAccumulator.sol:EmptyLaneAccumulator \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
  HC_TWIN=$(forge create src/contracts/merkle/MerkleSnapshot.sol:MerkleSnapshot \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$HC_VERIFIER" "$HC_PARAMS_HASH" "$HC_TWIN_ACC" "$DEPLOYER" "$DEPLOYER" | jq -r .deployedTo)
  cast send "$HC_TWIN" "setAnchorRegistry(address)" "$HC_REGISTRY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  cast send "$HC_TWIN_ACC" "bindSnapshot(address)" "$HC_TWIN" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  cast send "$HC_TWIN" "trigger()" --rpc-url "$RPC" --private-key "$PK" >/dev/null
  if cast send "$HC_TWIN" "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
      0 "$HC_ROOT" "$HC_IPFS" "$HC_CID" "$HC_TOTAL" "$HC_SKIPPED" "$HC_RECIPIENT" \
      "$(hex_file .trustgraph/hypercerts/hypercerts_proof.bin)" \
      --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1; then
    echo "FATAL: the twin accepted another instance's proof — domain separation is not working"
    exit 1
  fi
  echo "   twin=$HC_TWIN refused it ✓"

  echo "== hypercerts: register the instance in InstanceRegistry =="
  IREG=$(forge create src/contracts/registry/InstanceRegistry.sol:InstanceRegistry \
    --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
    --constructor-args "$DEPLOYER" | jq -r .deployedTo)
  HC_ID=$(cast keccak "hypercerts-e2e")
  cast send "$IREG" "register(bytes32,(bytes32,address,address,address,bytes32))" \
    "$HC_ID" "($(cast keccak "hypercerts"),$HC_SNAPSHOT,$HC_VERIFIER,$HC_REGISTRY,$HC_PARAMS_HASH)" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
  echo "   instance registered: $IREG[$HC_ID] ✓"
  echo
  echo "E2E HYPERCERTS PASS — the fourth program's full pipeline on anvil: seeded two-repo"
  echo "fixture anchored (DID nodes via the registrar gate), both repos proven in ONE lane-2"
  echo "journal (envelope 1 in-guest), root + skippedDigest landed, instance discoverable"
  echo "on-chain via InstanceRegistry."
fi

echo
echo "E2E PASS — exporter reconstructed a live checkpoint and the guests accepted it."
