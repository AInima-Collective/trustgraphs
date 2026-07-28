#!/usr/bin/env bash
#
# M2 exit: `operator --once` drives trigger → prove → submit unattended, and a restart re-attaches
# rather than paying again.
#
# This is the acceptance test for the daemon, and it is deliberately separate from `run.sh`: that
# script proves the CLI path a human drives, this one proves nobody has to.
#
#   bash test/e2e/operator.sh
#
# Needs anvil + the SP1 toolchain (SP1_PROVER=mock runs the guest for real; only the SNARK is a
# stub, exactly as in run.sh).

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RPC="${RPC:-http://127.0.0.1:8545}"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
WORK="${WORK:-/tmp/operator-e2e}"
CONFIG="$WORK/operator.toml"
GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
say() { echo -e "$*"; }
die() { echo -e "${RED}FATAL:${NC} $*" >&2; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK"

# --- chain -------------------------------------------------------------------
if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  say "== starting anvil =="
  anvil --silent &
  ANVIL_PID=$!
  trap '[ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null' EXIT
  for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
fi
cast block-number --rpc-url "$RPC" >/dev/null || die "no chain at $RPC"
DEPLOYER=$(cast wallet address --private-key "$PK")

# --- an instance the operator can find ----------------------------------------
say "== deploy EAS + resolver + schema + snapshot =="
forge script script/DeployEasResolver.s.sol:DeployEasResolver \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null 2>&1 \
  || die "DeployEasResolver failed"
EAS=$(jq -r .eas test/e2e/deploy.json)
RESOLVER=$(jq -r .resolver test/e2e/deploy.json)
SCHEMA=$(jq -r .schema_uid test/e2e/deploy.json)
SNAPSHOT=$(jq -r .snapshot test/e2e/deploy.json)
say "   snapshot=$SNAPSHOT resolver=$RESOLVER"

# An empty registry: the daemon enumerates it every tick, and a manifest instance must be found
# alongside whatever the chain describes (here, nothing).
REGISTRY=$(forge create src/contracts/registry/InstanceRegistry.sol:InstanceRegistry \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json --constructor-args "$DEPLOYER" \
  | jq -r .deployedTo)
say "   registry=$REGISTRY (empty)"

say "== attest a ring so the graph is non-empty =="
forge script script/E2eAttest.s.sol:E2eAttest --sig "run(address,bytes32)" "$EAS" "$SCHEMA" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null 2>&1 \
  || die "E2eAttest failed"
LEAVES=$(cast call "$RESOLVER" "leafCount()(uint64)" --rpc-url "$RPC")
say "   leafCount=$LEAVES"

jq --arg s "$SCHEMA" '.schema_uid = $s' test/e2e/params.template.json > "$WORK/params.json"

# A REAL SP1JournalVerifier pinned to this binary's guest vkey. The deploy script installs an
# accept-all verifier so the off-chain half of run.sh can work without one; the daemon refuses to
# prove against a verifier it cannot satisfy, which is the behaviour we want and which means the
# test has to give it a real one. (The SNARK itself is still stubbed at the gateway seam, exactly
# as in run.sh — SP1_PROVER=mock.)
say "== pin a real verifier to the guest vkey =="
VKEY=$( cd zk/prover && SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release -- trust-graph vkey )
[ -n "$VKEY" ] || die "could not derive the trust-graph vkey"
GATEWAY=$(forge create test/mocks/MockSP1Gateway.sol:MockSP1Gateway \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
cast send "$GATEWAY" "setExpectedVKey(bytes32)" "$VKEY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
VERIFIER=$(forge create src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$GATEWAY" "$VKEY" | jq -r .deployedTo)
cast send "$SNAPSHOT" "setZkVerifier(address)" "$VERIFIER" --rpc-url "$RPC" --private-key "$PK" >/dev/null
say "   vkey=$VKEY verifier=$VERIFIER"

cat > "$CONFIG" <<EOF
rpc      = "$RPC"
registry = "$REGISTRY"

[[manifest]]
program    = "trust-graph"
snapshot   = "$SNAPSHOT"
params     = "$WORK/params.json"
eas        = "$EAS"
from_block = 0

[curated]
instances = []

[cadence]
tick_seconds = 1
subsidy_min_blocks = 0

[finality]
confirmations = 0

[gas]
max_basefee_gwei = 10000

[prover]
backend = "mock"
groth16 = true

[ops]
journal_path = "$WORK/journal.jsonl"
status_path  = "$WORK/status.json"
log_format   = "json"
EOF

OP=(cargo run -q --release --manifest-path zk/operator/Cargo.toml -- --config "$CONFIG" --once)
export SUBMITTER_PRIVATE_KEY="$PK"
export SP1_SKIP_PROGRAM_BUILD=true

# --- dry run: decide, report, spend nothing ------------------------------------
say ""
say "== tick 1: --dry-run decides but must not send =="
BEFORE=$(cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC")
"${OP[@]}" --dry-run 2>&1 | tee "$WORK/tick-dry.log" | grep -E '"event"' | head -5
AFTER=$(cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC")
[ "$BEFORE" = "$AFTER" ] || die "--dry-run minted a checkpoint ($BEFORE -> $AFTER)"
grep -q '"action":"trigger"' "$WORK/tick-dry.log" || die "expected a Trigger decision, got: $(cat "$WORK/tick-dry.log")"
say "   ${GREEN}decided Trigger, sent nothing ✓${NC}"

# --- the real loop --------------------------------------------------------------
for i in 1 2 3; do
  say ""
  say "== tick $i =="
  "${OP[@]}" 2>&1 | tee "$WORK/tick-$i.log" | grep -E '"event":"(decision|triggered|proved|submitted|instance_skipped)"' | head -5
done

# --- what must be true ------------------------------------------------------------
CPS=$(cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC")
[ "$CPS" -ge 1 ] || die "the daemon never froze a checkpoint"
APPLIED=$(cast call "$SNAPSHOT" "hasAppliedCheckpoint()(bool)" --rpc-url "$RPC")
[ "$APPLIED" = "true" ] || die "the daemon never landed a root"
ROOT=$(cast call "$SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" \
  --rpc-url "$RPC" | grep -o '0x[0-9a-f]\{64\}' | head -1)
say ""
say "   ${GREEN}root landed unattended: $ROOT ✓${NC}"

# One checkpoint, one intent, one request, one settlement. Anything else means it paid twice.
INTENTS=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
SETTLED=$(grep -c '"kind":"settled"' "$WORK/journal.jsonl" || echo 0)
say "   journal: $INTENTS intent(s), $SETTLED settlement(s)"
[ "$INTENTS" = "1" ] || die "expected exactly 1 intent, got $INTENTS — the daemon paid more than once"

# --- restart must re-attach, not re-pay -------------------------------------------
say ""
say "== restart on a settled checkpoint: must not request again =="
"${OP[@]}" 2>&1 | tee "$WORK/tick-restart.log" >/dev/null
INTENTS2=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
[ "$INTENTS2" = "$INTENTS" ] || die "a restart re-requested a settled checkpoint ($INTENTS -> $INTENTS2)"
say "   ${GREEN}re-attached, no second request ✓${NC}"

# --- quiet is free -----------------------------------------------------------------
grep -q '"idle":"quiet"' "$WORK/tick-restart.log" \
  || say "   (note: not idle-quiet yet; state was $(grep -o '"action":"[a-z]*"' "$WORK/tick-restart.log" | head -1))"

# --- the heartbeat -------------------------------------------------------------------
jq -e '.instances | length >= 1' "$WORK/status.json" >/dev/null || die "status.json has no instances"
say "   status.json: $(jq -c '{head_block, instances: [.instances[] | {name, action: .action.action}]}' "$WORK/status.json")"

say ""
say "${GREEN}OPERATOR E2E PASS — trigger, prove and submit with no human in the loop,${NC}"
say "${GREEN}and a restart that re-attaches instead of paying again.${NC}"
