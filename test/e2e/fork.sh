#!/usr/bin/env bash
#
# M5: the whole proof-scheduler stack on a MAINNET FORK, unattended, plus the adversarial pass.
#
# What a fork buys that a bare anvil does not: Succinct's canonical SP1 verifier gateway is real
# forked state, so "the verifier path works" stops being a claim about a mock. One step below shows
# that gateway REJECTING a fabricated proof, which is the honest way to run a stubbed SNARK seam.
#
#   bash test/e2e/fork.sh
#   FORK_RPC=https://… bash test/e2e/fork.sh   (skips the upstream probe)
#
# Needs anvil, the SP1 toolchain, and outbound access to a mainnet RPC.
#
# ── On the SNARK, stated plainly ────────────────────────────────────────────────────────────────
# A real Groth16 wrap needs ~16-32 GiB (local `native-gnark`) or a prover-network key. This box has
# 11 GiB and no key, so the runs below wrap at a MockSP1Gateway exactly as `run.sh` does and for the
# same recorded reason (DEVIATIONS #1, extended by #20). Everything else is production code: the
# daemon's decisions, the journal, input reconstruction and its re-fold self-check, guest-vs-native
# byte equality, journal binding in SP1JournalVerifier, the vault's payout arithmetic, and every
# write. What this script CANNOT establish is that a real Groth16 proof verifies at the canonical
# gateway. That is a deploy-time check, and it is written up as one.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Any of these will do; the script probes them in order. The requirement is NOT "answers
# eth_blockNumber" — it is "answers eth_getStorageAt at a block a few thousand behind head".
# anvil keeps asking the upstream for state AT the pinned fork block, and once the real chain
# moves past it those become archive requests. A provider that serves the first and refuses the
# second does not fail politely: anvil PANICS mid-block ("pre-execution changes failed"), taking
# the run down partway through with a foundry backtrace that looks like our bug and is not.
# ethereum-rpc.publicnode.com is exactly that kind of provider, which is how this list exists.
FORK_RPC="${FORK_RPC:-}"
FORK_RPC_CANDIDATES=(
  https://eth.merkle.io
  https://rpc.flashbots.net
  https://gateway.tenderly.co/public/mainnet
  https://rpc.mevblocker.io
  https://1rpc.io/eth
)
PORT="${PORT:-8547}"
RPC="${RPC:-http://127.0.0.1:$PORT}"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
# anvil key 1: the front-runner, and the stranger.
PK2="${PK2:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
# Succinct's SP1 verifier gateway on Ethereum mainnet.
GATEWAY_MAINNET="${GATEWAY_MAINNET:-0x397A5f7f3dBd538f23DE225B51f532c34448dA9B}"
WORK="${WORK:-/tmp/fork-e2e}"
EPOCH=5

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YEL=$'\033[0;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
say() { echo -e "$*"; }
step() { echo -e "\n${BOLD}== $* ==${NC}"; }
die() { echo -e "${RED}FATAL:${NC} $*" >&2; exit 1; }
ok() { echo -e "   ${GREEN}$* ✓${NC}"; }
note() { echo -e "   ${YEL}$*${NC}"; }

FAILURES=0
# check <description> <0 if it held, anything else if it did not>
check() {
  if [ "$2" = "0" ]; then ok "$1"; else echo -e "   ${RED}$1 ✗${NC}"; FAILURES=$((FAILURES + 1)); fi
}

rm -rf "$WORK"; mkdir -p "$WORK" .trustgraph
export SP1_SKIP_PROGRAM_BUILD=true
export SUBMITTER_PRIVATE_KEY="$PK"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
step "fork mainnet"
# Picking an upstream is two questions, and only asking both is reliable:
#
#   1. Will it serve archive state? anvil keeps asking for state AT the pinned fork block, and
#      once the real chain moves past it those become archive requests. A provider that answers
#      `eth_blockNumber` and refuses those does not fail politely — anvil PANICS mid-block
#      ("pre-execution changes failed") partway through the run, with a foundry backtrace that
#      looks like our bug and is not.
#   2. Will it let anvil START? Several rate-limit (429) the burst of calls anvil makes while
#      setting the fork up, even though single probes sail through.
#
# So the loop probes, then actually starts anvil, and moves on if either half fails.
CANDIDATES=("${FORK_RPC_CANDIDATES[@]}")
[ -n "${FORK_RPC:-}" ] && CANDIDATES=("$FORK_RPC")   # an explicit choice is honoured, not probed
ANVIL_PID=""
trap '[ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null' EXIT

for candidate in "${CANDIDATES[@]}"; do
  HEAD_HEX=$(curl -s -m 8 -X POST "$candidate" -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq -r '.result // empty')
  if [ -z "$HEAD_HEX" ]; then note "$candidate: no answer"; continue; fi
  OLD_HEX=$(printf '0x%x' $(( HEAD_HEX - 3000 )))
  # The archive probe. This, not eth_blockNumber, is what decides whether the run survives.
  ARCHIVE=$(curl -s -m 12 -X POST "$candidate" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getStorageAt\",\"params\":[\"0x0000F90827F1C53a10cb7A02335B175320002935\",\"0x4a9\",\"$OLD_HEX\"],\"id\":1}" \
    | jq -r '.result // empty')
  if [ -z "$ARCHIVE" ]; then note "$candidate: answers head, refuses archive state — skipping"; continue; fi

  anvil --fork-url "$candidate" --port "$PORT" --silent >"$WORK/anvil.log" 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 60); do
    cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
    kill -0 "$ANVIL_PID" 2>/dev/null || break
    sleep 0.5
  done
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then FORK_RPC="$candidate"; break; fi
  note "$candidate: anvil could not fork it ($(head -1 "$WORK/anvil.log" | cut -c1-60))"
  kill "$ANVIL_PID" 2>/dev/null; ANVIL_PID=""
done

[ -n "$ANVIL_PID" ] || die "no usable mainnet RPC: none of ${#CANDIDATES[@]} candidate(s) could host the fork"
FORK_BLOCK=$(cast block-number --rpc-url "$RPC")
CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "1" ] || die "expected chain 1, got $CHAIN — this is not a mainnet fork"
say "   forked mainnet at block $FORK_BLOCK via $FORK_RPC"
DEPLOYER=$(cast wallet address --private-key "$PK")
SECOND=$(cast wallet address --private-key "$PK2")

step "the canonical SP1 gateway is real forked state, and it discriminates"
# Both assertions here are pure `eth_call`/`eth_getCode`. That is deliberate and load-bearing:
# the moment anvil MINES a block it re-reads the EIP-2935 history contract from the upstream, and
# any hiccup there kills the process (see the next step). So everything that needs a live upstream
# happens before the first block, and everything after it happens offline.
CODE=$(cast code "$GATEWAY_MAINNET" --rpc-url "$RPC")
[ "${#CODE}" -gt 2 ] || die "no code at the canonical gateway $GATEWAY_MAINNET — the fork is not live"
ok "gateway $GATEWAY_MAINNET carries $(( (${#CODE} - 2) / 2 )) bytes of forked code"

# Everything below wraps its SNARK at a MockSP1Gateway (see the header). That is only honest if
# the real thing would refuse those proofs, so ask the real thing, directly, right now.
FAKE_PROOF="0x$(printf 'a1%.0s' {1..130})"
GATEWAY_ANSWER=$(cast call "$GATEWAY_MAINNET" "verifyProof(bytes32,bytes,bytes)" \
  "$(cast keccak "probe-vkey")" "0xdeadbeef" "$FAKE_PROOF" --rpc-url "$RPC" 2>&1)
GATEWAY_RC=$?
# A dead node also "fails" this call, and would be a false pass. Prove the chain is alive first.
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 \
  || die "the fork died during the gateway probe; the rejection below would be meaningless"
[ "$GATEWAY_RC" != "0" ] || die "the canonical gateway accepted a fabricated proof: $GATEWAY_ANSWER"
ok "canonical gateway refuses it — mock-wrapped proofs are strictly local"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
step "detach from the upstream, carrying the gateway's real bytecode"
# Why this step exists, plainly: anvil re-reads the EIP-2935 block-hash-history contract from the
# upstream on EVERY block it mines, and treats ANY failure there as fatal — one 403 from an
# archive-gated provider, one 429, one dropped connection, and the process PANICS mid-block with
# "pre-execution changes failed". Over a run this long that is a certainty, not a risk: four
# separate attempts died that way, at four different points, across two providers.
#
# What this step does NOT claim. The chain below is no longer a live fork; `anvil_dumpState` only
# carries anvil's own accounts, never lazily-fetched remote ones, so there is no way to keep
# mainnet state wholesale without keeping the upstream. What it carries forward is the one piece
# of mainnet this test actually depends on — the canonical SP1 gateway's deployed bytecode, read
# out of the fork above and installed verbatim — on a chain that keeps mainnet's chain id.
#
# The two assertions that needed a real fork already ran, above, against the real thing: the
# gateway has code, and it refuses a proof it did not verify. Those are the fork's contribution
# and they are not re-claimed below.
cast rpc anvil_dumpState --rpc-url "$RPC" > "$WORK/state.hex" 2>/dev/null || die "anvil_dumpState failed"
# anvil_dumpState returns hex-encoded gzipped JSON; --load-state wants the JSON. It also records
# `best_block_number` = the fork height while carrying no block bodies, so a reload refuses with
# "best hash not found". Rewinding to 0 gives us our own block history, which is the point.
python3 - "$WORK/state.hex" "$WORK/state.json" <<'PY' || die "could not decode the state dump"
import gzip, json, sys
raw = open(sys.argv[1]).read().strip().strip('"')
blob = bytes.fromhex(raw[2:] if raw.startswith('0x') else raw)
try:
    blob = gzip.decompress(blob)
except OSError:
    pass                      # already plain JSON on some anvil builds
state = json.loads(blob)
state["best_block_number"] = 0
if isinstance(state.get("block"), dict):
    state["block"]["number"] = 0
json.dump(state, open(sys.argv[2], "w"))
PY
kill "$ANVIL_PID" 2>/dev/null; wait "$ANVIL_PID" 2>/dev/null; ANVIL_PID=""
anvil --load-state "$WORK/state.json" --chain-id 1 --port "$PORT" --silent >"$WORK/anvil2.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 \
  || { head -5 "$WORK/anvil2.log"; die "could not reload the dumped state"; }
[ "$(cast chain-id --rpc-url "$RPC")" = "1" ] || die "the reloaded chain is not chain 1"

cast rpc anvil_setCode "$GATEWAY_MAINNET" "$CODE" --rpc-url "$RPC" >/dev/null \
  || die "could not install the gateway bytecode"
[ "$(cast code "$GATEWAY_MAINNET" --rpc-url "$RPC")" = "$CODE" ] \
  || die "the installed gateway bytecode does not match what mainnet has"
# And it still runs, and still refuses. Bytecode that is present but inert would be worthless.
if cast call "$GATEWAY_MAINNET" "verifyProof(bytes32,bytes,bytes)" \
     "$(cast keccak "probe-vkey")" "0xdeadbeef" "$FAKE_PROOF" --rpc-url "$RPC" >/dev/null 2>&1; then
  die "the carried gateway bytecode accepted a fabricated proof"
fi
ok "chain 1, upstream detached, canonical gateway bytecode carried across and still refusing"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
step "deploy: EAS, registry, vault, factory"
forge script script/DeployEasResolver.s.sol:DeployEasResolver \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >"$WORK/deploy-eas.log" 2>&1 \
  || { tail -20 "$WORK/deploy-eas.log"; die "DeployEasResolver failed"; }
EAS=$(jq -r .eas test/e2e/deploy.json)
SCHEMA_REGISTRAR=$(jq -r .schema_registrar test/e2e/deploy.json)

REGISTRY_BLOCK=$(cast block-number --rpc-url "$RPC")
REGISTRY=$(forge create src/contracts/registry/InstanceRegistry.sol:InstanceRegistry \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json --constructor-args "$DEPLOYER" \
  | jq -r .deployedTo)
USDC=$(forge create src/contracts/tokens/TestUSDC.sol:TestUSDC \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
FEED=$(forge create test/mocks/MockEthUsdFeed.sol:MockEthUsdFeed \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
cast send "$FEED" "set(int256,uint256)" 300000000000 "$NOW" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null   # $3000.00000000, 8dp

VAULT=$(forge create src/contracts/vault/ProvingVault.sol:ProvingVault \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$REGISTRY" "$USDC" "$FEED" 86400 10000000000 10000000000000 "$DEPLOYER" "$DEPLOYER" \
  | jq -r .deployedTo)
say "   registry=$REGISTRY"
say "   vault=$VAULT (ETH/USD \$3000, sanity band \$100..\$100000)"

# The guest vkey, and a verifier pinned to it. Real SP1JournalVerifier; mock gateway underneath.
VKEY=$( cd zk/prover && SP1_PROVER=mock cargo run -q --release -- trust-graph vkey )
[ -n "$VKEY" ] || die "could not derive the trust-graph vkey"
MOCK_GATEWAY=$(forge create test/mocks/MockSP1Gateway.sol:MockSP1Gateway \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
cast send "$MOCK_GATEWAY" "setExpectedVKey(bytes32)" "$VKEY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
VERIFIER=$(forge create src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$MOCK_GATEWAY" "$VKEY" | jq -r .deployedTo)

SNAP_DEPLOYER=$(forge create src/contracts/factory/InstanceDeployers.sol:MerkleSnapshotDeployer \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
DIST_DEPLOYER=$(forge create src/contracts/factory/InstanceDeployers.sol:MerkleFundDistributorDeployer \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
FACTORY=$(forge create src/contracts/factory/TrustGraphFactory.sol:TrustGraphFactory \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$EAS" "$SCHEMA_REGISTRAR" "$VERIFIER" "$REGISTRY" \
    "$SNAP_DEPLOYER" "$DIST_DEPLOYER" "$EPOCH" "$VAULT" | jq -r .deployedTo)
REGISTRAR_ROLE=$(cast call "$REGISTRY" "REGISTRAR_ROLE()(bytes32)" --rpc-url "$RPC")
cast send "$REGISTRY" "grantRole(bytes32,address)" "$REGISTRAR_ROLE" "$FACTORY" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null
say "   factory=$FACTORY (epoch floor $EPOCH blocks)"

# Price a root before anyone creates anything, so the very first claim can pay.
PROGRAM=$(cast keccak "trust-graph")
for band in 1 2 3; do
  cast send "$VAULT" "setFeePerRootUsd(bytes32,uint8,uint256)" "$PROGRAM" "$band" $((band * 500000000)) \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null
done
ok "fee schedule set: \$5 / \$10 / \$15 per root by size band"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
step "create a network AND endow its proving tank in one transaction"
forge script script/examples/CreateInstance.s.sol:CreateInstance \
  --sig "run(address,uint256)" "$FACTORY" 3000000000000000000 \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >"$WORK/create.log" 2>&1 \
  || { tail -30 "$WORK/create.log"; die "createInstance failed"; }
INSTANCE=$(jq -r .instanceId .trustgraph/create-instance.json)
SNAPSHOT=$(jq -r .snapshot .trustgraph/create-instance.json)
RESOLVER=$(jq -r .resolver .trustgraph/create-instance.json)
SCHEMA=$(jq -r .schemaUid .trustgraph/create-instance.json)
[ -n "$INSTANCE" ] && [ "$INSTANCE" != "null" ] || die "no instance id"
say "   instance=$INSTANCE"
say "   snapshot=$SNAPSHOT  accumulator=$RESOLVER"

ETH_BAL=$(cast call "$VAULT" "accountOf(bytes32)((address,bytes32,uint128,uint128))" "$INSTANCE" \
  --rpc-url "$RPC" | grep -oE "[0-9]{15,}" | head -1)
[ "$ETH_BAL" = "3000000000000000000" ] \
  || die "the prepay did not reach the tank (balance=$ETH_BAL)"
ok "3 ETH prepay landed in the tank inside the creating transaction"

# The community's own spending limit. Constitutional, so only its admin can set it.
cast send "$VAULT" "setPolicy(bytes32,uint64,uint96)" "$INSTANCE" 0 5000000000 \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null || die "setPolicy failed"
ok "policy set: pay for every root, at most \$50 each"

step "a second network, curated: proven on us, no tank at all"
# The free tier, and the whole of it. A curated instance never draws a vault and lands its roots
# through plain `submitProof`. Running one alongside the funded instance in the same loop is the
# only way to see that the two policy branches coexist — an earlier bug had the operator treat
# every non-vault instance as unfunded and refuse to work at all.
forge script script/examples/CreateInstance.s.sol:CreateInstance \
  --sig "run(address,uint256,string)" "$FACTORY" 0 "fork-curated" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >"$WORK/create2.log" 2>&1 \
  || { tail -30 "$WORK/create2.log"; die "the curated createInstance failed"; }
CURATED=$(jq -r .instanceId .trustgraph/create-instance.json)
CUR_SNAPSHOT=$(jq -r .snapshot .trustgraph/create-instance.json)
CUR_RESOLVER=$(jq -r .resolver .trustgraph/create-instance.json)
CUR_SCHEMA=$(jq -r .schemaUid .trustgraph/create-instance.json)
[ "$CURATED" != "$INSTANCE" ] || die "the second instance reused the first id"
say "   curated=$CURATED  snapshot=$CUR_SNAPSHOT"
CUR_ACCOUNT=$(cast call "$VAULT" "accountOf(bytes32)((address,bytes32,uint128,uint128))" "$CURATED" --rpc-url "$RPC")
echo "$CUR_ACCOUNT" | grep -q "0x0000000000000000000000000000000000000000" \
  || die "the curated instance somehow bound a vault account"
ok "created with no prepay: it has no vault account at all"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────────────────────────
cat > "$WORK/operator.toml" <<EOF
rpc      = "$RPC"
registry = "$REGISTRY"
chain_id = 1
# The registry's deployment block. Zero would scan from genesis, and a mainnet provider rejects
# that range as an archive request — which is how this key came to exist.
registry_from_block = $REGISTRY_BLOCK

[curated]
instances = ["$CURATED"]

[paid]
enabled   = true
vault     = "$VAULT"
recipient = "$DEPLOYER"

[cadence]
tick_seconds = 1
subsidy_min_blocks = 0

[finality]
confirmations = 0

[gas]
max_basefee_gwei = 100000

[prover]
backend = "mock"
groth16 = true

[ops]
journal_path = "$WORK/journal.jsonl"
status_path  = "$WORK/status.json"
log_format   = "json"
EOF

OP=(cargo run -q --release --manifest-path zk/operator/Cargo.toml -- --config "$WORK/operator.toml" --once)
attest() { # attest <private-key>
  forge script script/E2eAttest.s.sol:E2eAttest --sig "run(address,bytes32)" "$EAS" "$SCHEMA" \
    --rpc-url "$RPC" --private-key "$1" --broadcast --skip-simulation >>"$WORK/attest.log" 2>&1
}
attest_curated() { # the curated instance has its own resolver, so its own schema
  forge script script/E2eAttest.s.sol:E2eAttest --sig "run(address,bytes32)" "$EAS" "$CUR_SCHEMA" \
    --rpc-url "$RPC" --private-key "$1" --broadcast --skip-simulation >>"$WORK/attest.log" 2>&1
}
cur_applied() { cast call "$CUR_SNAPSHOT" "lastAppliedCheckpoint()(uint256)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'; }
mine() { cast rpc anvil_mine "$1" --rpc-url "$RPC" >/dev/null; }
applied() { cast call "$SNAPSHOT" "lastAppliedCheckpoint()(uint256)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'; }
cps() { cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC" | awk '{print $1}'; }
intents() { grep -c '"kind":"intent"' "$WORK/journal.jsonl" 2>/dev/null || echo 0; }
credit() { cast call "$VAULT" "creditOf(address,address)(uint256)" "$1" \
  "0x0000000000000000000000000000000000000000" --rpc-url "$RPC" | awk '{print $1}'; }

# Prime the graph before the first epoch so `trigger()` has something to freeze.
attest "$PK"

say ""
say "${BOLD}Three epochs, unattended${NC}"
for epoch in 1 2 3; do
  step "epoch $epoch"
  attest "$PK"          # the graph must move; trigger() refuses a standing-still checkpoint
  attest_curated "$PK"
  mine $((EPOCH + 2))
  for _ in 1 2 3; do "${OP[@]}" >>"$WORK/epoch-$epoch.log" 2>&1; done
  grep -Eo '"event":"(triggered|proved|submitted|action_failed|tick_failed)"' \
    "$WORK/epoch-$epoch.log" | sort | uniq -c | sed 's/^/   /'
  say "   funded: checkpoints=$(cps) lastApplied=$(applied) credit=$(credit "$DEPLOYER") wei"
  say "   curated: lastApplied=$(cur_applied)"
done

HAS=$(cast call "$SNAPSHOT" "hasAppliedCheckpoint()(bool)" --rpc-url "$RPC")
[ "$HAS" = "true" ] || { tail -40 "$WORK/epoch-3.log"; die "no root landed across three epochs"; }
FINAL=$(applied)
check "roots landed across three epochs with zero manual steps (lastApplied=$FINAL)" \
      "$([ "$FINAL" -ge 2 ] && echo 0 || echo 1)"

# ...and the loop PAID for them. This is the half GOAL.md calls "the same loop pays whoever
# produces the root": a credit the prover can pull, priced by the fee the community set.
EARNED=$(credit "$DEPLOYER")
check "the tank paid the prover (credit = $EARNED wei)" \
      "$([ "$EARNED" != "0" ] && echo 0 || echo 1)"

# The free tier, in the same loop, on the same ticks, drawing nothing.
CUR_HAS=$(cast call "$CUR_SNAPSHOT" "hasAppliedCheckpoint()(bool)" --rpc-url "$RPC")
check "the curated instance also landed roots, unattended (lastApplied=$(cur_applied))" \
      "$([ "$CUR_HAS" = "true" ] && echo 0 || echo 1)"
CUR_ACCOUNT=$(cast call "$VAULT" "accountOf(bytes32)((address,bytes32,uint128,uint128))" "$CURATED" --rpc-url "$RPC")
check "and it still has no vault account: proven on us, not on its own money" \
      "$(echo "$CUR_ACCOUNT" | grep -q "0x0000000000000000000000000000000000000000" && echo 0 || echo 1)"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
say ""
say "${BOLD}The adversarial pass${NC}"

step "a stranger cannot mint a checkpoint"
BEFORE=$(cps)
cast send "$RESOLVER" "checkpoint()" --rpc-url "$RPC" --private-key "$PK2" >/dev/null 2>&1
check "direct accumulator.checkpoint() by a stranger rejected" \
      "$([ "$(cps)" = "$BEFORE" ] && echo 0 || echo 1)"

step "the payout survives a front-run"
# The scenario recipient-in-journal exists for. A copier watching the mempool sees the whole
# pending `submitAndClaim`: the proof bytes, the root, the CID, and the journal-committed
# recipient. Here it sees more than that — it reads the daemon's held proof straight off disk,
# which is strictly more information than a front-runner could ever have — and lands the claim
# itself, from its own key, before the daemon submits.
#
# What must hold: the FEE follows the journal's recipient, so the copier pays the original prover.
# Only the gas reimbursement follows `msg.sender`. Copying is allowed; stealing is not.
attest "$PK"; mine $((EPOCH + 2))
"${OP[@]}" >>"$WORK/frontrun.log" 2>&1   # trigger
"${OP[@]}" >>"$WORK/frontrun.log" 2>&1   # prove, and hold the result
FR_CP=$(( $(cps) - 1 ))
HELD=".trustgraph/operator/$INSTANCE/$FR_CP/held.json"
if [ ! -f "$HELD" ]; then
  note "no held proof at $HELD — the daemon submitted in the same tick; front-run not exercised"
  FAILURES=$((FAILURES + 1))
else
  ROOT=$(jq -r .output_root "$HELD"); IPFS=$(jq -r .ipfs_hash "$HELD")
  CID=$(jq -r .cid "$HELD");          TOTAL=$(jq -r .total_value "$HELD")
  SKIPPED=$(jq -r .skipped_digest "$HELD")
  RECIP=$(jq -r .recipient "$HELD");  BLOB=$(jq -r .blob "$HELD")
  say "   copying checkpoint $FR_CP; the journal names $RECIP as payee"

  PRE_PROVER=$(credit "$DEPLOYER"); PRE_COPIER=$(credit "$SECOND")
  # minPayoutUsd = 0: the copier wants it to land at any price. That is the attacker's best move,
  # so proving the property against it is the strongest form of the test.
  cast send "$VAULT" \
    "submitAndClaim(bytes32,(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes,uint256))" \
    "$INSTANCE" "($FR_CP,$ROOT,$IPFS,$CID,$TOTAL,$SKIPPED,$RECIP,$BLOB,0)" \
    --rpc-url "$RPC" --private-key "$PK2" --gas-limit 3000000 >"$WORK/frontrun-tx.log" 2>&1 \
    || { note "the copied call reverted:"; tail -3 "$WORK/frontrun-tx.log" | sed 's/^/     /'; }
  POST_PROVER=$(credit "$DEPLOYER"); POST_COPIER=$(credit "$SECOND")
  say "   prover credit $PRE_PROVER → $POST_PROVER"
  say "   copier credit $PRE_COPIER → $POST_COPIER"

  # The claim landed at all (otherwise the next two assertions are vacuous).
  check "the copied claim landed (lastApplied=$(applied) ≥ $FR_CP)" \
        "$([ "$(applied)" -ge "$FR_CP" ] && echo 0 || echo 1)"
  # The fee went to the prover the journal named, not to whoever sent the transaction.
  check "the proving fee went to the journal's recipient, not the sender" \
        "$([ "$POST_PROVER" -gt "$PRE_PROVER" ] && echo 0 || echo 1)"
  # The copier got at most gas back. A fee-sized credit would mean the split does not hold.
  COPIER_GAIN=$((POST_COPIER - PRE_COPIER))
  PROVER_GAIN=$((POST_PROVER - PRE_PROVER))
  say "   copier gained $COPIER_GAIN wei, prover gained $PROVER_GAIN wei"
  check "the copier took less than the prover (gas only, no fee)" \
        "$([ "$COPIER_GAIN" -lt "$PROVER_GAIN" ] && echo 0 || echo 1)"
fi
"${OP[@]}" >>"$WORK/frontrun.log" 2>&1   # the daemon re-attaches to a checkpoint someone else landed

step "a params rotation does not move an already-pinned checkpoint"
attest "$PK"; mine $((EPOCH + 2))
"${OP[@]}" >>"$WORK/rotate.log" 2>&1     # trigger, so a checkpoint exists with params pinned
CP=$(( $(cps) - 1 ))
PINNED=$(cast call "$SNAPSHOT" "checkpointParamsHash(uint256)(bytes32)" "$CP" --rpc-url "$RPC")
cast send "$SNAPSHOT" "setParamsHash(bytes32)" "$(cast keccak "rotated")" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1 || die "setParamsHash failed"
STILL=$(cast call "$SNAPSHOT" "checkpointParamsHash(uint256)(bytes32)" "$CP" --rpc-url "$RPC")
LIVE=$(cast call "$SNAPSHOT" "paramsHash()(bytes32)" --rpc-url "$RPC")
check "checkpoint $CP keeps its pinned params through the rotation" \
      "$([ "$PINNED" = "$STILL" ] && echo 0 || echo 1)"
check "the live params moved" "$([ "$LIVE" != "$PINNED" ] && echo 0 || echo 1)"

step "the operator refuses to spend on an instance it can no longer reproduce"
# Its reconstruction comes from the immutable creation event, so after that rotation the live hash
# is one it cannot reproduce. Minting against it would be paying gas to make work for nobody.
attest "$PK"; mine $((EPOCH + 2))
"${OP[@]}" >"$WORK/after-rotation.log" 2>&1
grep -q 'params_hash(reconstruction)' "$WORK/after-rotation.log"
check "skipped with a params mismatch instead of spending" "$?"

step "trigger spam buys the spammer nothing"
# `trigger()` is permissionless by design. What must NOT happen is one paid proof per spam
# checkpoint. Restore the params first, or the operator would skip for the reason above and this
# would measure nothing.
cast send "$SNAPSHOT" "setParamsHash(bytes32)" "$PINNED" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1
SPAM_BEFORE=$(cps); INTENTS_BEFORE=$(intents)
for _ in 1 2 3 4 5; do
  attest "$PK2"; mine $((EPOCH + 1))
  cast send "$SNAPSHOT" "trigger()" --rpc-url "$RPC" --private-key "$PK2" >/dev/null 2>&1
done
SPAMMED=$(( $(cps) - SPAM_BEFORE ))
"${OP[@]}" >>"$WORK/spam.log" 2>&1
"${OP[@]}" >>"$WORK/spam.log" 2>&1
NEW_INTENTS=$(( $(intents) - INTENTS_BEFORE ))
say "   $SPAMMED spam checkpoints ⇒ $NEW_INTENTS proof request(s)"
check "the operator coalesced to at most one proof" \
      "$([ "$NEW_INTENTS" -le 1 ] && echo 0 || echo 1)"

step "kill -9 mid-flight, then restart"
# The journal is the only thing between a crash and paying twice. Kill the daemon while a proof is
# in flight and restart it: it must re-attach, not re-request.
attest "$PK"; mine $((EPOCH + 2))
"${OP[@]}" >>"$WORK/crash.log" 2>&1      # trigger
APPLIED_PRE=$(applied)
"${OP[@]}" >>"$WORK/crash.log" 2>&1 &
KILLPID=$!
sleep 8                                   # inside the proof, before the submit
kill -9 "$KILLPID" 2>/dev/null; wait "$KILLPID" 2>/dev/null
INTENTS_MID=$(intents)
for _ in 1 2 3; do "${OP[@]}" >>"$WORK/crash.log" 2>&1; done
INTENTS_POST=$(intents)
say "   intents: $INTENTS_MID at the kill, $INTENTS_POST after recovery; applied $APPLIED_PRE → $(applied)"
check "the restart re-attached rather than re-requesting" \
      "$([ "$INTENTS_POST" -le "$((INTENTS_MID + 1))" ] && echo 0 || echo 1)"
check "the daemon recovered and kept landing roots" \
      "$([ "$(applied)" -gt "$APPLIED_PRE" ] && echo 0 || echo 1)"

step "the loss budget halts an instance rather than bleeding on it"
# Unpreventable spend is real: a creator-admin can rotate config one block after any preflight, so
# no amount of preflighting drives waste to zero. The budget is the backstop, and until this run it
# was unreachable code — the daemon passed `Spend::default()` forever, so no input could ever trip
# it. Set a cap below what this instance has already spent today and it must stop.
sed 's/^\[budget\]$//' "$WORK/operator.toml" > "$WORK/broke.toml"
cat >> "$WORK/broke.toml" <<'EOF'

[budget]
per_instance_usd_per_day = 0
global_usd_per_day       = 0
EOF
INTENTS_BUDGET=$(intents)
attest "$PK"; mine $((EPOCH + 2))
cargo run -q --release --manifest-path zk/operator/Cargo.toml -- \
  --config "$WORK/broke.toml" --once >"$WORK/budget.log" 2>&1
grep -qi 'loss_budget' "$WORK/budget.log"
check "held on the loss budget" "$?"
check "and spent nothing while halted ($(( $(intents) - INTENTS_BUDGET )) new request(s))" \
      "$([ "$(intents)" = "$INTENTS_BUDGET" ] && echo 0 || echo 1)"

step "a verifier it cannot satisfy is a hold, not a loss"
# Freeze-shaped: point the instance at a verifier nothing this binary produces can satisfy, and
# confirm the daemon reports it rather than burning proof after proof against it.
BOGUS=$(forge create src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$MOCK_GATEWAY" "$(cast keccak "not-our-vkey")" | jq -r .deployedTo)
cast send "$SNAPSHOT" "setZkVerifier(address)" "$BOGUS" --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1
INTENTS_B=$(intents)
attest "$PK"; mine $((EPOCH + 2))
for _ in 1 2 3; do "${OP[@]}" >>"$WORK/frozen.log" 2>&1; done
INTENTS_A=$(intents)
grep -qi 'verifier_rotated\|verifierrotated' "$WORK/frozen.log"
check "held on the rotated verifier rather than proving into it" "$?"
check "spent nothing while held ($((INTENTS_A - INTENTS_B)) new request(s))" \
      "$([ "$INTENTS_A" = "$INTENTS_B" ] && echo 0 || echo 1)"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
say ""
if [ "$FAILURES" = "0" ]; then
  say "${GREEN}${BOLD}FORK E2E PASS${NC}"
  say "${GREEN}Against the live fork: the canonical gateway is real and refuses what it did not${NC}"
  say "${GREEN}verify. Against its carried bytecode on chain 1: multi-epoch unattended proving, a${NC}"
  say "${GREEN}prepaid tank that paid the prover, a front-run that could not take the fee, and${NC}"
  say "${GREEN}every other adversarial case refused. The Groth16 wrap is stubbed — DEVIATIONS #20.${NC}"
  exit 0
else
  say "${RED}${BOLD}FORK E2E FAIL: $FAILURES check(s) failed${NC}"
  say "logs in $WORK"
  exit 1
fi
