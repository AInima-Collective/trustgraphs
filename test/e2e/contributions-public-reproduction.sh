#!/usr/bin/env bash
# Issue #28 acceptance: a second party reproduces an accepted Contributions root with only
# RPC URL + InstanceRegistry + start block. The setup-side params file is moved out of the way
# before the second scan; all addresses and the full 21-field tuple come back from chain history.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RPC="${RPC:-http://127.0.0.1:18546}"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
BOB_PK="${BOB_PK:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
WORK="${WORK:-.trustgraph/contributions-public-reproduction}"
LABEL="public-reproduction-e2e"
DEPLOY_FILE=".docker/contributions_instance_${LABEL}_deploy.json"

rm -rf "$WORK"
mkdir -p "$WORK"
if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  anvil --silent --port "${RPC##*:}" &
  ANVIL_PID=$!
  for _ in $(seq 1 40); do
    cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
trap '[ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null; rm -f "$DEPLOY_FILE"' EXIT

deployed() {
  forge create "$1" --rpc-url "$RPC" --private-key "$PK" --broadcast --json "${@:2}" |
    jq -r .deployedTo
}

DEPLOYER=$(cast wallet address --private-key "$PK")
BOB=$(cast wallet address --private-key "$BOB_PK")
SCHEMA_REGISTRY=$(deployed node_modules/@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol:SchemaRegistry)
EAS=$(deployed node_modules/@ethereum-attestation-service/eas-contracts/contracts/EAS.sol:EAS --constructor-args "$SCHEMA_REGISTRY")
SCHEMA_REGISTRAR=$(deployed src/contracts/eas/SchemaRegistrar.sol:SchemaRegistrar --constructor-args "$SCHEMA_REGISTRY")
TRUST_ACCUMULATOR=$(deployed src/contracts/eas/resolvers/EASIndexerResolver.sol:EASIndexerResolver --constructor-args "$EAS")
REGISTRY=$(deployed src/contracts/registry/InstanceRegistry.sol:InstanceRegistry --constructor-args "$DEPLOYER")
REGISTRY_START_BLOCK=0

REGISTER_TX=$(cast send "$SCHEMA_REGISTRY" 'register(string,address,bool)(bytes32)' \
  'string comment,uint256 confidence' "$TRUST_ACCUMULATOR" true \
  --rpc-url "$RPC" --private-key "$PK" --json | jq -r .transactionHash)
VOUCH_UID=$(cast receipt "$REGISTER_TX" --rpc-url "$RPC" --json | jq -r '.logs[0].topics[1]')
cast send "$TRUST_ACCUMULATOR" 'bindSchema(bytes32)' "$VOUCH_UID" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null
VOUCH_DATA=$(cast abi-encode 'f(string,uint256)' 'public trust edge' 100)
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
VOUCH_REQUEST="($VOUCH_UID,($BOB,0,true,$ZERO,$VOUCH_DATA,0))"
cast send "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))' "$VOUCH_REQUEST" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null

cp test/e2e/params.contributions.template.json "$WORK/setup-params.json"
FUNDED_KEY="$PK" CONTRIBUTIONS_PROGRAM_VKEY=0x0000000000000000000000000000000000000000000000000000000000000000 \
  forge script script/DeployContributionsInstance.s.sol:DeployContributionsInstance \
  --sig 'run(string,string,string,string,string,string,string)' \
  "$LABEL" "$EAS" "$SCHEMA_REGISTRAR" "$TRUST_ACCUMULATOR" \
  "$WORK/setup-params.json" '' "$REGISTRY" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --slow >/dev/null

SNAPSHOT=$(jq -r .contracts.merkle_snapshot "$DEPLOY_FILE")
RESOLVER=$(jq -r .contracts.contribution_resolver "$DEPLOY_FILE")
CLAIM_UID=$(cast call "$RESOLVER" 'claimSchemaUid()(bytes32)' --rpc-url "$RPC")
RESPONSE_UID=$(cast call "$RESOLVER" 'responseSchemaUid()(bytes32)' --rpc-url "$RPC")
VALUATION_UID=$(cast call "$RESOLVER" 'valuationSchemaUid()(bytes32)' --rpc-url "$RPC")
CLAIM_DATA=$(cast abi-encode 'f(string,bytes32,string,address[],uint32[])' \
  'Public reproduction' "$(cast keccak public-reproduction)" 'ipfs://public' \
  "[$BOB]" '[100]')
REQUEST="($CLAIM_UID,($BOB,0,true,$ZERO,$CLAIM_DATA,0))"
CLAIM_TX=$(cast send "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))' "$REQUEST" \
  --rpc-url "$RPC" --private-key "$BOB_PK" --json | jq -r .transactionHash)
CLAIM_LOG_DATA=$(cast receipt "$CLAIM_TX" --rpc-url "$RPC" --json | \
  jq --arg eas "${EAS,,}" -r '.logs[] | select((.address | ascii_downcase) == $eas) | .data' | head -1)
CLAIM_ATTEST_UID=$(cast abi-decode 'x()(bytes32)' "$CLAIM_LOG_DATA")
RESPONSE_DATA=$(cast abi-encode 'f(bytes32,uint8)' "$CLAIM_ATTEST_UID" 1)
RESPONSE_REQUEST="($RESPONSE_UID,($BOB,0,true,$ZERO,$RESPONSE_DATA,0))"
cast send "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))' "$RESPONSE_REQUEST" \
  --rpc-url "$RPC" --private-key "$BOB_PK" >/dev/null
VALUATION_DATA=$(cast abi-encode 'f(bytes32,uint8)' "$CLAIM_ATTEST_UID" 100)
VALUATION_REQUEST="($VALUATION_UID,($BOB,0,true,$ZERO,$VALUATION_DATA,0))"
cast send "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))' "$VALUATION_REQUEST" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null
cast rpc anvil_mine 10 --rpc-url "$RPC" >/dev/null
cast send "$SNAPSHOT" 'trigger()' --rpc-url "$RPC" --private-key "$PK" >/dev/null

# First public reconstruction produces the input that is accepted below.
cargo run -q -p input-exporter --bin instance-scan -- \
  --rpc "$RPC" --registry "$REGISTRY" --program contributions \
  --from-block "$REGISTRY_START_BLOCK" --out-dir "$WORK/first" >/dev/null
FIRST_PLAN="$WORK/first/instances.json"
PARAMS=$(jq -r '.instances[0].paramsPath' "$FIRST_PLAN")
PUBLIC_EAS=$(jq -r '.instances[0].eas' "$FIRST_PLAN")
PUBLIC_SNAPSHOT=$(jq -r '.instances[0].snapshot' "$FIRST_PLAN")

# A known mismatch must stop before an input/proof artifact exists.
jq '.total_pool = "0x1"' "$PARAMS" >"$WORK/mismatched-params.json"
if SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release --features fetch \
  --manifest-path zk/prover/Cargo.toml -- contributions fetch \
  --rpc "$RPC" --snapshot "$PUBLIC_SNAPSHOT" --eas "$PUBLIC_EAS" --checkpoint 0 \
  --params "$WORK/mismatched-params.json" --from-block "$REGISTRY_START_BLOCK" \
  --out "$WORK/mismatch-must-not-exist.json" >"$WORK/mismatch.log" 2>&1; then
  echo 'mismatched public tuple was accepted' >&2
  exit 1
fi
grep -q 'PARAMS HASH MISMATCH' "$WORK/mismatch.log"
test ! -e "$WORK/mismatch-must-not-exist.json"

SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release --features fetch \
  --manifest-path zk/prover/Cargo.toml -- contributions fetch \
  --rpc "$RPC" --snapshot "$PUBLIC_SNAPSHOT" --eas "$PUBLIC_EAS" --checkpoint 0 \
  --params "$PARAMS" --from-block "$REGISTRY_START_BLOCK" --out "$WORK/first-input.json"
FIRST_EXEC=$(SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release \
  --manifest-path zk/prover/Cargo.toml -- contributions execute "$WORK/first-input.json")
ROOT=$(awk '/outputRoot:/{print $2}' <<<"$FIRST_EXEC")
IPFS_HASH=$(awk '/ipfsHash:/{print $2}' <<<"$FIRST_EXEC")
CID=$(awk '/^cid:/{print $2}' <<<"$FIRST_EXEC")
TOTAL=$(awk '/totalValue:/{print $2}' <<<"$FIRST_EXEC")
test "${ROOT,,}" != "${ZERO,,}"
SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release \
  --manifest-path zk/prover/Cargo.toml -- contributions prove "$WORK/first-input.json" \
  --groth16 --out-dir "$WORK/proof" >/dev/null
PROOF="0x$(od -An -v -tx1 "$WORK/proof/contributions_proof.bin" | tr -d ' \n')"
cast send "$SNAPSHOT" \
  'submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)' \
  0 "$ROOT" "$IPFS_HASH" "$CID" "$TOTAL" "$ZERO" \
  0x0000000000000000000000000000000000000000 "$PROOF" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null

# Remove the only setup-side params path. The reproduction subshell receives only the three
# public discovery inputs; every other value is derived from its newly written plan.
mv "$WORK/setup-params.json" "$WORK/setup-params.unavailable"
reproduce() {
  local PUBLIC_RPC=$1
  local PUBLIC_REGISTRY=$2
  local PUBLIC_START_BLOCK=$3
  cargo run -q -p input-exporter --bin instance-scan -- \
    --rpc "$PUBLIC_RPC" --registry "$PUBLIC_REGISTRY" --program contributions \
    --from-block "$PUBLIC_START_BLOCK" --out-dir "$WORK/second" >/dev/null
  PLAN="$WORK/second/instances.json"
  SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release --features fetch \
    --manifest-path zk/prover/Cargo.toml -- contributions fetch \
    --rpc "$PUBLIC_RPC" --snapshot "$(jq -r '.instances[0].snapshot' "$PLAN")" \
    --eas "$(jq -r '.instances[0].eas' "$PLAN")" --checkpoint 0 \
    --params "$(jq -r '.instances[0].paramsPath' "$PLAN")" \
    --from-block "$PUBLIC_START_BLOCK" \
    --out "$WORK/second-input.json"
}
reproduce "$RPC" "$REGISTRY" "$REGISTRY_START_BLOCK"

SECOND_EXEC=$(SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release \
  --manifest-path zk/prover/Cargo.toml -- contributions execute "$WORK/second-input.json")
SECOND_ROOT=$(awk '/outputRoot:/{print $2}' <<<"$SECOND_EXEC")
ONCHAIN_ROOT=$(cast call "$SNAPSHOT" \
  'getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))' --rpc-url "$RPC" |
  grep -o '0x[0-9a-fA-F]\{64\}' | head -1)

test "$SECOND_ROOT" = "$ROOT"
test "${ONCHAIN_ROOT,,}" = "${ROOT,,}"
test ! -e "$WORK/setup-params.json"
echo "public Contributions reproduction accepted: $SECOND_ROOT"
