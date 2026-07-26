#!/usr/bin/env bash
#
# Resolve one factory instance from chain data alone: given an instanceId or a piece of a network's
# name, recover its schema uid, resolver and trusted seed from its own `InstanceCreated` event.
#
# Sourced by `taskfile/vouch.sh` and `taskfile/seed-graph.sh` so neither has to hard-code an address
# a redeploy would invalidate, and so the event ABI lives in exactly one place.
#
# bash 3.2 compatible (macOS's system bash): no associative arrays, no `${x,,}`.
#
#     resolve_instance "<id-or-name>" "<factory>" "<rpc>"
#       -> INSTANCE_ID INSTANCE_NAME INSTANCE_RESOLVER INSTANCE_SCHEMA INSTANCE_SEED

INSTANCE_SIG='InstanceCreated(bytes32 indexed,address indexed,address indexed,string,string,address,bytes32,address,address,address,uint64,(uint256,uint256,uint32,uint256,uint256,uint256,uint256,uint256,address[],uint256,uint256,bytes32,uint32,bytes32[],uint64,address,uint64))'
INSTANCE_DEC='x()(string,string,address,bytes32,address,address,address,uint64,(uint256,uint256,uint32,uint256,uint256,uint256,uint256,uint256,address[],uint256,uint256,bytes32,uint32,bytes32[],uint64,address,uint64))'

resolve_instance() {
  _want="$1"; _factory="$2"; _rpc="$3"

  INSTANCE_ID=""; INSTANCE_NAME=""; INSTANCE_RESOLVER=""; INSTANCE_SCHEMA=""; INSTANCE_SEED=""

  while read -r _row; do
    _id=$(printf '%s' "$_row" | jq -r '.topics[1]')
    _fields=$(cast abi-decode "$INSTANCE_DEC" "$(printf '%s' "$_row" | jq -r .data)")
    _name=$(printf '%s' "$_fields" | sed -n 1p | tr -d '"')
    # An exact id wins; otherwise match on a substring of the display name.
    if [ "$_want" != "$_id" ]; then
      case "$_name" in *"$_want"*) ;; *) continue ;; esac
    fi
    if [ -n "$INSTANCE_ID" ]; then
      echo "fatal: '$_want' matches both '$INSTANCE_NAME' and '$_name' — pass the instanceId" >&2
      return 1
    fi
    INSTANCE_ID="$_id"
    INSTANCE_NAME="$_name"
    INSTANCE_RESOLVER=$(printf '%s' "$_fields" | sed -n 3p)
    INSTANCE_SCHEMA=$(printf '%s' "$_fields" | sed -n 4p)
    # The params tuple prints on one line; the seed list is its only bracketed address array.
    INSTANCE_SEED=$(printf '%s' "$_fields" | sed -n 9p | grep -oE '\[0x[0-9a-fA-F]{40}\]' | tr -d '[]')
  done < <(cast logs --from-block 0 --address "$_factory" "$INSTANCE_SIG" --rpc-url "$_rpc" --json | jq -c '.[]')

  if [ -z "$INSTANCE_ID" ]; then
    echo "fatal: no instance matching '$_want' on $_rpc" >&2
    echo "       known instances:" >&2
    list_instances "$_factory" "$_rpc" | sed 's/^/         /' >&2
    return 1
  fi
}

list_instances() {
  cast logs --from-block 0 --address "$1" "$INSTANCE_SIG" --rpc-url "$2" --json \
  | jq -r '.[].data' \
  | while read -r _d; do cast abi-decode "$INSTANCE_DEC" "$_d" | sed -n 1p | tr -d '"'; done
}
