#!/usr/bin/env bash
#
# The multi-instance proving loop — "chain is the config".
#
# Given an RPC endpoint and an `InstanceRegistry` address and nothing else, prove every trust-graph
# instance the chain knows about: enumerate the directory, rebuild each instance's params from its
# `InstanceCreated` event, self-check that hash against the live snapshot, then run
#
#     trigger() -> input-exporter -> prove -> pin -> submitProof
#
# per instance, in its own `.trustgraph/trust-graph/<instanceId>/` output directory. No per-instance
# config file exists anywhere, and no parameter is ever typed in by hand.
#
# Usage (defaults suit a local dev stack):
#
#     bash taskfile/instances.sh                       # or: task instances:prove-all
#     RPC=… REGISTRY=0x… PK=0x… bash taskfile/instances.sh
#     ONLY=0x<instanceId> bash taskfile/instances.sh   # one instance
#     DRY_RUN=1 bash taskfile/instances.sh             # scan + self-check only, send nothing
#
# Environment:
#   RPC        JSON-RPC endpoint                     (default http://127.0.0.1:8545)
#   REGISTRY   InstanceRegistry address              (default: .docker/instance_registry_deploy.json)
#   PK         funding key for trigger()/submitProof (default $FUNDED_KEY; both calls are permissionless)
#   SP1_PROVER proving backend                       (default mock — see the caveat below)
#   GROTH16    wrap the proof                        (default 1)
#   IPFS_API   kubo API for pinning the score blob   (default http://127.0.0.1:5001)
#   FROM_BLOCK first block scanned for registry logs (default 0)
#   ONLY       prove only this instanceId
#   DRY_RUN    1 = scan and self-check, then stop
#   RECIPIENT  journal-v3 bounty payee (default zero = no bounty)
#
# Scope: this is the DOCUMENTED FALLBACK. The operator daemon (`zk/operator`) does this loop
# unattended, with finality tracking, coalescing, loss budgets, holds and vault claims; see
# `docs/OPERATOR.md`. Keep this script working — it is what a community runs to prove its own
# instance by hand, and what we run when the daemon is the thing that is broken.
#
# Caveat on backends: `SP1_PROVER=mock` runs the guest for real and commits its real public values,
# but the SNARK itself is a stub — the on-chain gateway check is only meaningful with
# `SP1_PROVER=network` (or `cpu` on a 16-32 GiB box with `--features native-gnark`). Everything else
# in this loop — the params self-check, the exporter's re-fold proof, guest-vs-native byte equality,
# journal binding in `SP1JournalVerifier`, and the write path — is production code either way.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RPC="${RPC:-${RPC_URL:-http://127.0.0.1:8545}}"
REGISTRY="${REGISTRY:-}"
PK="${PK:-${FUNDED_KEY:-}}"
IPFS_API="${IPFS_API:-http://127.0.0.1:5001}"
FROM_BLOCK="${FROM_BLOCK:-0}"
ONLY="${ONLY:-}"
DRY_RUN="${DRY_RUN:-0}"
# Journal v3: the bounty payee the guest commits and submitProof binds. Zero (the default) means
# "no bounty" — correct for this script, which is the manual fallback, not the paid operator.
RECIPIENT="${RECIPIENT:-0x0000000000000000000000000000000000000000}"
GROTH16="${GROTH16:-1}"
# The prover backend. Default mock so the loop runs on any box; override for a real proof.
export SP1_PROVER="${SP1_PROVER:-mock}"
# Never rebuild the guest ELFs from here: a rebuild mid-loop changes every vkey after the deploy
# pinned the old ones, and each verifier then rejects (or the daemon holds) forever. Only
# `task zk:build` builds guests.
export SP1_SKIP_PROGRAM_BUILD="${SP1_SKIP_PROGRAM_BUILD:-true}"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
say()  { echo -e "$*"; }
warn() { echo -e "${YELLOW}warning:${NC} $*" >&2; }
die()  { echo -e "${RED}fatal:${NC} $*" >&2; exit 1; }

hex_file() { echo "0x$(od -An -v -tx1 "$1" | tr -d ' \n')"; }

# Cargo replays cached compiler warnings on every `cargo run`, which buries the tool's own output.
# Drop the diagnostic block (header, source spans, notes) and keep everything else verbatim.
strip_cargo_noise() {
  grep -vE '^(warning|note): |^ *--> |^ *= (note|help): |^ *[0-9]* *\| |^ *\|$|^$'
}

for tool in cast cargo jq od; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found in PATH"
done

# The registry address is the ONE piece of configuration. The dev-stack artifact is a convenience
# fallback for local runs; on a real chain you pass REGISTRY explicitly.
if [ -z "$REGISTRY" ]; then
  [ -f .docker/instance_registry_deploy.json ] \
    || die "set REGISTRY=0x… (no .docker/instance_registry_deploy.json to fall back on)"
  REGISTRY=$(jq -r .instance_registry .docker/instance_registry_deploy.json)
fi
[ "$DRY_RUN" = "1" ] || [ -n "$PK" ] || die "set PK=0x… (or FUNDED_KEY in .env) — trigger()/submitProof need a sender"

say "${BOLD}== scan: rebuild every instance from chain data ==${NC}"
if [ "$DRY_RUN" = "1" ]; then
  say "${DIM}rpc=$RPC registry=$REGISTRY (dry run — nothing is sent)${NC}"
else
  say "${DIM}rpc=$RPC registry=$REGISTRY prover=$SP1_PROVER${NC}"
fi

# `instance-scan` writes one params.json per instance plus the plan, and HARD-FAILS the whole run if
# any instance's `params_hash(InstanceCreated.params)` disagrees with its live snapshot.paramsHash().
PLAN=.trustgraph/trust-graph/instances.json
cargo run -q -p input-exporter --bin instance-scan -- \
  --rpc "$RPC" --registry "$REGISTRY" --from-block "$FROM_BLOCK" 2> >(strip_cargo_noise >&2) >/dev/null \
  || die "instance-scan failed — refusing to prove anything (see the error above)"

TOTAL=$(jq -r '.instances | length' "$PLAN")
READY=$(jq -r '.readyCount' "$PLAN")
say "${DIM}$TOTAL instance(s) in the directory, $READY ready${NC}"

if [ "$DRY_RUN" = "1" ]; then
  say "${GREEN}dry run: params self-check passed for every reconstructed instance${NC}"
  exit 0
fi

PROVEN=0
FAILED=0
# instanceId -> what actually happened, so the summary reports the run and not the plan. Kept as
# "<instanceId> <outcome>" lines rather than an associative array: macOS ships bash 3.2, where
# `declare -A` is a syntax error and every lookup below would silently report nothing.
OUTCOMES=""
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ZERO_ADDR=0x0000000000000000000000000000000000000000

record_outcome() { OUTCOMES="${OUTCOMES}$1 $2
"; }
outcome_of() { printf '%s' "$OUTCOMES" | awk -v id="$1" '$1 == id { last = $2 } END { print last }'; }

# A failing step for one instance must not take the run down with it: record it, move on, and exit
# non-zero at the end. `set -e` is deliberately off for exactly this reason.
fail_instance() { warn "$2"; record_outcome "$1" failed; FAILED=$((FAILED + 1)); }

while read -r row; do
  ID=$(jq -r .instanceId <<<"$row")
  [ -z "$ONLY" ] || [ "$ONLY" = "$ID" ] || continue

  NAME=$(jq -r .name <<<"$row")
  SNAPSHOT=$(jq -r .snapshot <<<"$row")
  ACC=$(jq -r .accumulator <<<"$row")
  EAS=$(jq -r .eas <<<"$row")
  PARAMS=$(jq -r .paramsPath <<<"$row")
  OUTDIR=$(jq -r .outDir <<<"$row")
  CREATED=$(jq -r .createdBlock <<<"$row")

  say ""
  say "${BOLD}== $NAME ==${NC}"
  say "${DIM}$ID${NC}"
  say "${DIM}snapshot=$SNAPSHOT accumulator=$ACC${NC}"

  # 1. Freeze the inputs. Permissionless; the contract, not the prover, picks the boundary.
  cast send "$SNAPSHOT" "trigger()" --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1 || {
    fail_instance "$ID" "$NAME: trigger() reverted"; continue
  }
  CPID=$(( $(cast call "$ACC" "checkpointCount()(uint256)" --rpc-url "$RPC") - 1 ))
  say "   checkpoint #$CPID frozen"

  # 2. Reconstruct this checkpoint's exact edge set from chain (self-checks re-fold == acc), using
  #    the params this instance's own creation event committed to.
  # Clear last pass's artifacts first: a silently-failing step must not leave a STALE input.json or
  # proof.bin behind for the next step to pick up and submit as if it were this checkpoint's.
  rm -f "$OUTDIR/input.json" "$OUTDIR/proof.bin"
  cargo run -q -p input-exporter -- \
    --rpc "$RPC" --accumulator "$ACC" --eas "$EAS" --checkpoint "$CPID" \
    --params "$PARAMS" --snapshot "$SNAPSHOT" --recipient "$RECIPIENT" \
    --out "$OUTDIR/input.json" --from-block "$CREATED" 2>&1 \
    | strip_cargo_noise | sed 's/^/   /'
  if [ "${PIPESTATUS[0]}" -ne 0 ] || [ ! -f "$OUTDIR/input.json" ]; then
    fail_instance "$ID" "$NAME: input-exporter failed (no verified input set for checkpoint #$CPID)"
    continue
  fi

  # 3. Run the guest and byte-assert it against native `compute` — this is what makes the journal
  #    values below trustworthy, and it is the same assertion the parity gate runs.
  EXEC=$( cd zk/prover && cargo run -q --release -- trust-graph execute "$OUTDIR/input.json" --out-dir "$OUTDIR" 2>/dev/null ) || {
    fail_instance "$ID" "$NAME: guest execute failed"; continue
  }
  OUTPUT_ROOT=$(awk '/^outputRoot:/{print $2}'    <<<"$EXEC")
  IPFS_HASH=$(awk '/^ipfsHash:/{print $2}'        <<<"$EXEC")
  CID=$(awk '/^cid:/{print $2}'                   <<<"$EXEC")
  TOTAL_VALUE=$(awk '/^totalValue:/{print $2}'    <<<"$EXEC")
  SKIPPED=$(awk '/^skippedDigest:/{print $2}'     <<<"$EXEC")
  SKIPPED="${SKIPPED:-$ZERO32}"
  # Journal v3: submitProof folds `recipient` into the digest, so the submit MUST echo exactly the
  # value the guest committed. Read it back from the guest rather than re-deriving it here.
  PROVEN_RECIPIENT=$(awk '/^recipient:/{print $2}'  <<<"$EXEC")
  PROVEN_RECIPIENT="${PROVEN_RECIPIENT:-$ZERO_ADDR}"
  say "   guest == native ✓  root=$OUTPUT_ROOT"

  # 4. Prove.
  ( cd zk/prover && cargo run -q --release -- trust-graph prove "$OUTDIR/input.json" \
      $([ "$GROTH16" = "1" ] && echo --groth16) --out-dir "$OUTDIR" ) >/dev/null 2>&1 || {
    fail_instance "$ID" "$NAME: prove failed"; continue
  }
  [ -f "$OUTDIR/proof.bin" ] || { fail_instance "$ID" "$NAME: prove wrote no proof.bin"; continue; }
  say "   proof written to $OUTDIR/proof.bin"

  # 5. Pin the score blob. `submitProof` binds the CID *string* in the journal and lands without it,
  #    but the UI resolves scores through IPFS, so an unreachable node is a warning, not a failure.
  if curl -s --max-time 5 -X POST "$IPFS_API/api/v0/version" >/dev/null 2>&1; then
    PINNED=$(curl -sF "file=@$OUTDIR/blob.json" "$IPFS_API/api/v0/add?cid-version=1&raw-leaves=true" | jq -r .Hash)
    if [ "$PINNED" = "$CID" ]; then
      say "   pinned $CID ✓"
    else
      warn "$NAME: pinned CID $PINNED != proven CID $CID"
    fi
  else
    warn "$NAME: IPFS API $IPFS_API unreachable — blob NOT pinned (the proof still lands; the UI will not resolve scores)"
  fi

  # 6. Submit.
  cast send "$SNAPSHOT" "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
    "$CPID" "$OUTPUT_ROOT" "$IPFS_HASH" "$CID" "$TOTAL_VALUE" "$SKIPPED" "$PROVEN_RECIPIENT" \
    "$(hex_file "$OUTDIR/proof.bin")" \
    --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1 || {
    fail_instance "$ID" "$NAME: submitProof reverted"; continue
  }

  ONCHAIN=$(cast call "$SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" \
    --rpc-url "$RPC" | grep -o '0x[0-9a-f]\{64\}' | head -1)
  APPLIED=$(cast call "$SNAPSHOT" "hasAppliedCheckpoint()(bool)" --rpc-url "$RPC")
  if [ "$ONCHAIN" != "$OUTPUT_ROOT" ]; then
    fail_instance "$ID" "$NAME: on-chain root $ONCHAIN != proven $OUTPUT_ROOT"; continue
  fi
  say "   ${GREEN}submitted — hasAppliedCheckpoint=$APPLIED, root $ONCHAIN ✓${NC}"
  record_outcome "$ID" proven
  PROVEN=$((PROVEN + 1))
done < <(jq -c '.instances[] | select(.status == "ready")' "$PLAN")

say ""
say "${BOLD}== summary ==${NC}"
while read -r row; do
  ID=$(jq -r .instanceId <<<"$row")
  NAME=$(jq -r '.name // "(no InstanceCreated event)"' <<<"$row")
  REASON=$(jq -r .reason <<<"$row")
  if [ "$(jq -r .status <<<"$row")" = "ready" ]; then
    case "$(outcome_of "$ID")" in
      proven) say "   ${GREEN}proven ${NC}  $NAME  ${DIM}$ID${NC}" ;;
      failed) say "   ${RED}failed ${NC}  $NAME  ${DIM}$ID${NC}" ;;
      *)      say "   ${DIM}skipped${NC}  $NAME  ${DIM}$ID${NC}\n             └─ not attempted (ONLY=$ONLY)" ;;
    esac
  else
    say "   ${DIM}skipped${NC}  $NAME  ${DIM}$ID${NC}\n             └─ $REASON"
  fi
done < <(jq -c '.instances[]' "$PLAN")

say ""
if [ "$FAILED" -gt 0 ]; then
  say "${RED}$PROVEN instance(s) proven and submitted, $FAILED failed${NC}"
  exit 1
fi
say "${GREEN}$PROVEN instance(s) proven and submitted from chain data + RPC alone${NC}"
