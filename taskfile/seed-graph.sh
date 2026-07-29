#!/usr/bin/env bash
#
# Seed one instance with a demo-sized vouching graph: 21 vouches over 14 accounts, rooted at that
# instance's own trusted seed.
#
# The schema uid and the seed are read off the instance's `InstanceCreated` event, so there is
# nothing to look up and nothing to paste — which matters, because vouching against a foreign schema
# reverts and vouching into a graph the seed cannot reach flattens every score to the same floor.
#
# Usage:
#
#     bash taskfile/seed-graph.sh <instance>          # id, or a piece of the name: "Demo Co-op"
#     bash taskfile/seed-graph.sh                     # lists what is on chain, then stops
#     DRY_RUN=1 bash taskfile/seed-graph.sh "RegenHub"
#
# Then prove it — normally by letting the proof scheduler do it:
#
#     task demo:prove
#
# or by hand, which is now the documented fallback (docs/trust-graph/RUNBOOK.md):
#
#     REGISTRY=$(jq -r .instance_registry .docker/instance_registry_deploy.json) \
#     PK=$(grep -E '^FUNDED_KEY=' .env | cut -d= -f2) bash taskfile/instances.sh
#
# Environment: RPC (default http://127.0.0.1:8545), FACTORY / EAS (default: .docker artifacts),
# DRY_RUN=1 to resolve and print the forge command without broadcasting.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
. taskfile/lib/instance.sh

RPC="${RPC:-${RPC_URL:-http://127.0.0.1:8545}}"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "fatal: $*" >&2; exit 1; }
for tool in cast forge jq; do command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found in PATH"; done

FACTORY="${FACTORY:-$(jq -r .factory .docker/factory_deploy.json)}"
EAS="${EAS:-$(jq -r .eas .docker/eas_deploy.json)}"

if [ $# -lt 1 ]; then
  echo "usage: bash taskfile/seed-graph.sh <instance>"
  echo "instances on $RPC:"
  list_instances "$FACTORY" "$RPC" | sed 's/^/  /'
  exit 1
fi

resolve_instance "$1" "$FACTORY" "$RPC"
BEFORE=$(cast call "$INSTANCE_RESOLVER" 'leafCount()(uint256)' --rpc-url "$RPC")

echo "$INSTANCE_NAME  ($INSTANCE_ID)"
echo "  eas:          $EAS"
echo "  schema:       $INSTANCE_SCHEMA"
echo "  trusted seed: $INSTANCE_SEED"
echo "  edges now:    $BEFORE"

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "would run:"
  echo "  forge script script/SeedGraph.s.sol:SeedGraph --sig 'run(address,bytes32,address)' \\"
  echo "    $EAS $INSTANCE_SCHEMA $INSTANCE_SEED --rpc-url $RPC --broadcast"
  exit 0
fi

forge script script/SeedGraph.s.sol:SeedGraph --sig 'run(address,bytes32,address)' \
  "$EAS" "$INSTANCE_SCHEMA" "$INSTANCE_SEED" --rpc-url "$RPC" --broadcast >/dev/null \
  || die "forge script failed — is the seed one of anvil accounts 0-9, and is anvil on $RPC?"

AFTER=$(cast call "$INSTANCE_RESOLVER" 'leafCount()(uint256)' --rpc-url "$RPC")
echo "  edges now:    $AFTER  (+$((AFTER - BEFORE)))"
echo
echo "next: task demo:prove          # the daemon freezes, proves and lands it"
echo "  or: REGISTRY=\$(jq -r .instance_registry .docker/instance_registry_deploy.json) PK=\$(grep -E '^FUNDED_KEY=' .env | cut -d= -f2) bash taskfile/instances.sh   # by hand"
