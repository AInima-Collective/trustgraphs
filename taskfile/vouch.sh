#!/usr/bin/env bash
#
# One vouch, into one instance, with nothing typed in by hand but the arguments.
#
# The EAS address comes from the dev deploy artifact and the schema uid is read off the instance's
# own `InstanceCreated` event, so this cannot drift from the chain — and it cannot attest against a
# foreign schema, which the resolver would reject anyway.
#
# Usage:
#
#     bash taskfile/vouch.sh <instance> <attester> <recipient> <confidence> [comment]
#
#     instance    instanceId (0x…32 bytes) or a substring of the network's name ("Demo Co-op")
#     attester    anvil account index 0-9, or a raw private key
#     recipient   anvil account index 0-13, or a raw address
#     confidence  0-100 (the schema's weight field; higher is a stronger vouch)
#
# Examples:
#
#     bash taskfile/vouch.sh "Demo Co-op" 0 10 90 "promoted to steward"
#     bash taskfile/vouch.sh "Demo Co-op" 2 4 75
#     DRY_RUN=1 bash taskfile/vouch.sh "Demo Co-op" 3 7 40      # simulate, send nothing
#
# Then produce the proof that picks it up:
#
#     REGISTRY=… PK=… ONLY=<instanceId> bash taskfile/instances.sh
#
# Environment: RPC (default http://127.0.0.1:8545), FACTORY / EAS (default: .docker artifacts),
# DRY_RUN=1 to `cast call` instead of `cast send`.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RPC="${RPC:-${RPC_URL:-http://127.0.0.1:8545}}"
DRY_RUN="${DRY_RUN:-0}"
MNEMONIC="test test test test test test test test test test test junk"
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000

die() { echo "fatal: $*" >&2; exit 1; }

[ $# -ge 4 ] || die "usage: bash taskfile/vouch.sh <instance> <attester> <recipient> <confidence> [comment]"
INSTANCE="$1"; ATTESTER="$2"; RECIPIENT="$3"; CONFIDENCE="$4"; COMMENT="${5:-vouched}"

FACTORY="${FACTORY:-$(jq -r .factory .docker/factory_deploy.json)}"
EAS="${EAS:-$(jq -r .eas .docker/eas_deploy.json)}"

# Anvil's well-known mnemonic — PUBLIC test keys, zero value. Local use only.
# An index is resolved through it; anything else is passed through as a literal key/address.
key_of()  { case "$1" in [0-9]) cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1" ;; *) echo "$1" ;; esac; }
addr_of() { case "$1" in [0-9]|1[0-3]) cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$1" ;; *) echo "$1" ;; esac; }

. taskfile/lib/instance.sh

# Resolve the instance from chain: name or id -> schema uid, resolver, trusted seed.
resolve_instance "$INSTANCE" "$FACTORY" "$RPC" || exit 1
FOUND="$INSTANCE_ID"; FOUND_NAME="$INSTANCE_NAME"
RESOLVER="$INSTANCE_RESOLVER"; SCHEMA="$INSTANCE_SCHEMA"; SEED="$INSTANCE_SEED"

PK=$(key_of "$ATTESTER")
FROM=$(cast wallet address --private-key "$PK")
TO=$(addr_of "$RECIPIENT")
DATA=$(cast abi-encode "f(string,uint256)" "$COMMENT" "$CONFIDENCE")
BEFORE=$(cast call "$RESOLVER" 'leafCount()(uint256)' --rpc-url "$RPC")

echo "$FOUND_NAME  ($FOUND)"
echo "  schema:      $SCHEMA"
# `${x,,}` is bash 4; macOS ships 3.2, so lowercase through tr for the seed comparison.
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
echo "  trusted seed:$SEED$([ "$(lower "$FROM")" = "$(lower "$SEED")" ] && echo '   <- this vouch comes FROM the seed')"
echo "  vouch:       $FROM -> $TO  confidence=$CONFIDENCE  \"$COMMENT\""

REQ="($SCHEMA,($TO,0,true,$ZERO32,$DATA,0))"
if [ "$DRY_RUN" = "1" ]; then
  # `UID` is readonly in bash; the attestation uid needs its own name.
  ATT_UID=$(cast call "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))(bytes32)' \
    "$REQ" --from "$FROM" --rpc-url "$RPC")
  echo "  dry run:     would succeed, uid $ATT_UID (nothing sent, leafCount stays $BEFORE)"
  exit 0
fi

cast send "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))' \
  "$REQ" --private-key "$PK" --rpc-url "$RPC" >/dev/null
AFTER=$(cast call "$RESOLVER" 'leafCount()(uint256)' --rpc-url "$RPC")
echo "  folded:      leafCount $BEFORE -> $AFTER"
echo
echo "next: REGISTRY=\$(jq -r .instance_registry .docker/instance_registry_deploy.json) PK=\$FUNDED_KEY ONLY=$FOUND bash taskfile/instances.sh"
