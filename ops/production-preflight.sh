#!/usr/bin/env sh
set -eu

case "${OPERATOR_IMAGE:-}" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "OPERATOR_IMAGE must be pinned by sha256 digest, not a tag" >&2; exit 1 ;;
esac
operator_digest=${OPERATOR_IMAGE##*@sha256:}
case "$operator_digest" in
  *[!0-9a-fA-F]*) echo "OPERATOR_IMAGE sha256 digest must contain exactly 64 hexadecimal characters" >&2; exit 1 ;;
esac

for name in INDEXER_IMAGE_TAG POSTGRES_PASSWORD PONDER_DATABASE_SCHEMA \
  RPC_URL_11155111 PONDER_RPC_URLS_11155111 \
  RPC_URL_11155111_0 RPC_URL_11155111_1 \
  IPFS_GATEWAY IPFS_GATEWAY_PUBLIC PONDER_URL FRONTEND_URL \
  SUBMITTER_PRIVATE_KEY NETWORK_PRIVATE_KEY IPFS_PIN_API_KEY OPERATOR_ALERT_WEBHOOK; do
  eval "value=\${$name:-}"
  test -n "$value" || { echo "$name is required" >&2; exit 1; }
done

case ",$PONDER_RPC_URLS_11155111," in
  *",$RPC_URL_11155111,"*)
    echo "PONDER_RPC_URLS_11155111 must contain an endpoint independent of the primary" >&2
    exit 1
    ;;
esac

if [ "$RPC_URL_11155111_0" = "$RPC_URL_11155111_1" ]; then
  echo "RPC_URL_11155111_0 and RPC_URL_11155111_1 must use independent endpoints" >&2
  exit 1
fi

docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}" config --quiet
echo "production compose preflight passed"
