#!/usr/bin/env bash
#
# Read-only preflight for a public-chain deploy. Broadcasts nothing, writes nothing, and prints
# no secret: it derives addresses from the keys in `.env.sepolia` but never echoes a key, an RPC URL or
# an API token.
#
# It exists because the checks that matter before a deploy were spread across a checklist, a dry
# run and several people's heads. On 2026-08-25 a verifier went out holding a vkey from a local
# guest build, which is immutable and cost a redeploy of two contracts. Everything below is
# either that failure or a neighbour of it.
#
# Usage:  bash scripts/sepolia-preflight.sh
# Exit code is the number of failed checks, so it composes with `&&`.

set -uo pipefail
cd "$(dirname "$0")/.."

if [ "${TRUSTGRAPHS_TARGET_ENV_LOADED:-}" != "1" ]; then
  exec node scripts/run-with-target-env.cjs sepolia bash "$0" "$@"
fi

# The release the deploy is pinned to. Bump both together.
RELEASE_TAG=v0.0.5
RELEASE_COMMIT=f64a4c7c9b5e552e2392894a2e0d6f6c40973549

# The expansion adds weighted, composition and contributions factory families. Their latest local
# receipts total 39,406,718 gas with registry grants enabled; Sepolia disables those grants, but
# budget 50m anyway so a base-fee move cannot strand a continuation between families.
GAS_TOTAL=50000000

# A key that was exposed and must never be funded or used again.
BURNED_KEY_ADDRESS=0x3ed16f90e8ea54d9a1bae67ab2d6bdc177eadeec

# The SP1 verifier gateway routes proofs by a 4-byte selector taken from the proof itself, and
# that selector is sha256 of the Groth16 verifying key shipped with the prover's sp1 version.
# Stable across sp1-verifier 6.1.0 through 6.3.1. Derived, not copied: see check 9.
EXPECTED_SELECTOR=0x4388a21c

pass=0; fail=0
ok()   { echo "  ok    $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
note() { echo "        $1"; }

# macOS ships shasum rather than sha256sum.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

for tool in cast jq curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found" >&2; exit 1; }
done

echo "=== 1. the checkout is the release we mean to deploy ==="
[ "${DEPLOYMENT_COMMIT:-}" = "$RELEASE_COMMIT" ] \
  && ok "DEPLOYMENT_COMMIT is $RELEASE_TAG ($RELEASE_COMMIT)" \
  || bad "DEPLOYMENT_COMMIT=${DEPLOYMENT_COMMIT:-unset}, expected $RELEASE_COMMIT"
note "HEAD is $(git rev-parse HEAD)"
note "working tree: $(git status --porcelain | wc -l | tr -d ' ') modified path(s)"

echo "=== 2. every vkey came from that release, not from this machine ==="
# The one that failed. A locally built vkey is well-formed bytes32 and passes every shape check,
# so the only thing that can tell it apart from a real one is the table the release published.
if [ -f guest-manifest.json ]; then
  GM_TAG=$(jq -r .tag guest-manifest.json)
  GM_COMMIT=$(jq -r .commit guest-manifest.json)
  [ "$GM_TAG" = "$RELEASE_TAG" ] && ok "guest-manifest.json is $GM_TAG" \
    || bad "guest-manifest.json is $GM_TAG, expected $RELEASE_TAG"
  [ "$GM_COMMIT" = "${DEPLOYMENT_COMMIT:-}" ] && ok "manifest commit matches DEPLOYMENT_COMMIT" \
    || bad "manifest was built at $GM_COMMIT, not ${DEPLOYMENT_COMMIT:-unset}"
  for pair in "trust-graph:SP1_PROGRAM_VKEY" \
              "trust-graph-weighted:SP1_WEIGHTED_PROGRAM_VKEY" \
              "trust-compose:SP1_COMPOSITION_PROGRAM_VKEY" \
              "signer-sync:SP1_SIGNER_PROGRAM_VKEY" \
              "contributions:CONTRIBUTIONS_PROGRAM_VKEY"; do
    prog=${pair%%:*}; var=${pair##*:}
    want=$(jq -r --arg p "$prog" '.programs[] | select(.program==$p) | .vkey' guest-manifest.json)
    eval "have=\${$var:-unset}"
    { [ -n "$want" ] && [ "$want" = "$have" ]; } \
      && ok "$var is the released $prog vkey" \
      || bad "$var is $have, release says $want"
  done
  ELF=$(jq -r '.programs[] | select(.program=="trust-graph") | .elf_sha256' guest-manifest.json)
  [ "0x$ELF" = "${SP1_PROGRAM_ELF_SHA256:-}" ] \
    && ok "SP1_PROGRAM_ELF_SHA256 describes the same ELF as the vkey" \
    || bad "SP1_PROGRAM_ELF_SHA256=${SP1_PROGRAM_ELF_SHA256:-unset}, release says 0x$ELF"
else
  bad "guest-manifest.json absent: gh release download $RELEASE_TAG -R AInima-Collective/trustgraphs -p guest-manifest.json"
fi

echo "=== 3. scratch artifacts cannot steer the continuation ==="
# The continuation ignores all five core artifacts and preserves those addresses from the tracked
# manifest. Matching originals are useful deployment evidence, so do not demand their deletion.
# Every scratch artifact either has to agree with a recorded live address or be absent. An artifact
# for a still-null family could be a fork rehearsal or a partial prior run; guessing which would
# let local JSON steer a public continuation.
for item in \
  ".docker/eas_deploy.json:schema_registrar:schemaRegistrar" \
  ".docker/zk_verifier_deploy.json:zk_verifier:rootVerifier" \
  ".docker/instance_registry_deploy.json:instance_registry:instanceRegistry" \
  ".docker/proving_vault_deploy.json:proving_vault:provingVault" \
  ".docker/factory_deploy.json:factory:trustgraphsFactory" \
  ".docker/zk_verifier_signer_deploy.json:zk_verifier:signerVerifier" \
  ".docker/governed_factory_deploy.json:governed_factory:governedTrustgraphsFactory" \
  ".docker/zk_verifier_weighted_deploy.json:zk_verifier:weightedVerifier" \
  ".docker/weighted_factory_deploy.json:weighted_factory:weightedTrustgraphsFactory" \
  ".docker/governed_weighted_factory_deploy.json:governed_weighted_factory:governedWeightedTrustgraphsFactory" \
  ".docker/zk_verifier_composition_deploy.json:zk_verifier:compositionVerifier" \
  ".docker/trust_compose_factory_deploy.json:trust_compose_factory:trustComposeFactory" \
  ".docker/governed_compose_factory_deploy.json:governed_compose_factory:governedTrustComposeFactory" \
  ".docker/contributions_factory_deploy.json:zk_verifier:contributionsVerifier" \
  ".docker/contributions_factory_deploy.json:contributions_factory:contributionsFactory"; do
  file=${item%%:*}; rest=${item#*:}; field=${rest%%:*}; key=${rest##*:}
  [ -f "$file" ] || { note "$file absent (the manifest remains authoritative)"; continue; }
  have=$(jq -r --arg field "$field" '.[$field] // empty' "$file")
  want=$(jq -r --arg key "$key" '.contracts[$key].address // empty' deployments/sepolia.json)
  if [ -z "$want" ]; then
    bad "$file exists while manifest.contracts.$key is null; determine whether it is live or a rehearsal"
  elif [ "$(echo "$have" | tr 'A-Z' 'a-z')" = "$(echo "$want" | tr 'A-Z' 'a-z')" ]; then
    ok "$file agrees with manifest.contracts.$key"
  else
    bad "$file disagrees with manifest.contracts.$key (the continuation will ignore it)"
  fi
done

echo "=== 4. .env.sepolia points at the chain we mean ==="
# `pnpm deploy:contracts` with no flags follows these. A demo once inherited them and deployed
# the production plan to a public chain.
[ "${DEPLOY_TARGET:-}" = "sepolia" ]   && ok "DEPLOY_TARGET=sepolia"     || bad "DEPLOY_TARGET=${DEPLOY_TARGET:-unset}"
[ "${DEPLOY_STAGE:-}" = "production" ] && ok "DEPLOY_STAGE=production"   || bad "DEPLOY_STAGE=${DEPLOY_STAGE:-unset}"
[ "${CHAIN_ID:-}" = "11155111" ]       && ok "CHAIN_ID=11155111"         || bad "CHAIN_ID=${CHAIN_ID:-unset}"

echo "=== 5. the RPC is the chain it claims to be ==="
CHAIN=$(cast chain-id --rpc-url "${RPC_URL:-}" 2>/dev/null || echo 0)
[ "$CHAIN" = "11155111" ] && ok "RPC answers chain-id 11155111" || bad "RPC answers chain-id $CHAIN"
note "head block $(cast block-number --rpc-url "${RPC_URL:-}" 2>/dev/null || echo unknown)"

echo "=== 6. the keys, by address and balance ==="
DEPLOYER=$(cast wallet address --private-key "${FUNDED_KEY:-}" 2>/dev/null || echo unknown)
SUBMITTER=$(cast wallet address --private-key "${SUBMITTER_PRIVATE_KEY:-}" 2>/dev/null || echo unknown)
for pair in "deployer:$DEPLOYER" "admin:${INSTANCE_REGISTRY_ADMIN:-unknown}" "submitter:$SUBMITTER"; do
  who=${pair%%:*}; addr=${pair##*:}
  [ "$addr" = "unknown" ] && { bad "$who key missing from .env"; continue; }
  WEI=$(cast balance "$addr" --rpc-url "${RPC_URL:-}" 2>/dev/null || echo 0)
  NONCE=$(cast nonce "$addr" --rpc-url "${RPC_URL:-}" 2>/dev/null || echo "?")
  note "$(printf '%-9s %s  %s ETH  nonce %s' "$who" "$addr" "$(cast to-unit "$WEI" ether | cut -c1-8)" "$NONCE")"
done
[ "$(echo "$DEPLOYER" | tr 'A-Z' 'a-z')" != "$BURNED_KEY_ADDRESS" ] \
  && ok "deployer is not the burned key" || bad "deployer IS the burned key, stop"

echo "=== 7. what the broadcast costs at the gas price right now ==="
BASEFEE=$(cast base-fee --rpc-url "${RPC_URL:-}" 2>/dev/null || echo 0)
DEP_WEI=$(cast balance "$DEPLOYER" --rpc-url "${RPC_URL:-}" 2>/dev/null || echo 0)
COST_WEI=$(( GAS_TOTAL * BASEFEE ))
note "base fee $(cast to-unit "$BASEFEE" gwei) gwei"
note "$GAS_TOTAL gas at that price = $(cast to-unit "$COST_WEI" ether | cut -c1-8) ETH"
note "deployer holds                = $(cast to-unit "$DEP_WEI" ether | cut -c1-8) ETH"
# Threefold, because the risk is not the price now but a spike partway through a 16-transaction run.
if [ "$COST_WEI" -gt 0 ] && [ "$DEP_WEI" -gt $(( COST_WEI * 3 )) ]; then
  ok "at least 3x headroom over the current base fee"
else
  bad "under 3x headroom, a spike mid-run could strand the deploy half-finished"
fi

echo "=== 8. the contracts the plan reuses rather than deploys ==="
for key in eas schemaRegistry sp1Gateway ethUsdFeed usdc; do
  ADDR=$(jq -r --arg k "$key" '.external[$k] // empty' deployments/sepolia.json)
  [ -z "$ADDR" ] && { bad "deployments/sepolia.json has no external.$key"; continue; }
  SIZE=$(cast code "$ADDR" --rpc-url "${RPC_URL:-}" 2>/dev/null | wc -c | tr -d ' ')
  [ "${SIZE:-0}" -gt 4 ] && ok "$key $ADDR has code" || bad "$key $ADDR has NO code on this chain"
done

echo "=== 9. the gateway will route the proofs this prover produces ==="
# Worth its own check because of what it costs to get wrong. SP1JournalVerifier holds the gateway
# address in an immutable, and the gateway dispatches on a 4-byte selector carried in the proof.
# If that selector has no route, or a frozen one, proofs cannot verify and the only fix is a new
# verifier and therefore a new factory. The selector is sha256 of the Groth16 verifying key that
# ships inside the sp1-verifier crate the prover pins, so it can be derived offline: no proof, no
# gas, no guessing. Derived here when that crate is unpacked locally, checked against the pin
# otherwise, and either way the route is read from the chain.
SP1_VERSION=$(sed -n 's/.*sp1-sdk = { version = "=\([0-9][0-9.]*\)".*/\1/p' zk/prover/Cargo.toml | head -1)
note "prover pins sp1 ${SP1_VERSION:-unknown}"
SELECTOR="$EXPECTED_SELECTOR"
VK=$(ls "$HOME"/.cargo/registry/src/*/sp1-verifier-"${SP1_VERSION}"/vk-artifacts/groth16_vk.bin 2>/dev/null | head -1)
if [ -n "$VK" ]; then
  DERIVED="0x$(sha256_of "$VK" | cut -c1-8)"
  [ "$DERIVED" = "$EXPECTED_SELECTOR" ] \
    && ok "selector $DERIVED derived from the local sp1-verifier $SP1_VERSION artifacts" \
    || bad "sp1-verifier $SP1_VERSION emits $DERIVED, this script expects $EXPECTED_SELECTOR"
  SELECTOR="$DERIVED"
else
  note "sp1-verifier $SP1_VERSION not unpacked locally, using the pinned selector"
  note "to derive: cargo fetch in zk/prover, then rerun"
fi
GATEWAY=$(jq -r '.external.sp1Gateway' deployments/sepolia.json)
ROUTE=$(cast call "$GATEWAY" "routes(bytes4)(address,bool)" "$SELECTOR" --rpc-url "${RPC_URL:-}" 2>/dev/null)
ROUTE_VERIFIER=$(echo "$ROUTE" | sed -n 1p)
ROUTE_FROZEN=$(echo "$ROUTE" | sed -n 2p)
if [ -z "$ROUTE_VERIFIER" ] || [ "$ROUTE_VERIFIER" = "0x0000000000000000000000000000000000000000" ]; then
  bad "gateway $GATEWAY has no route for $SELECTOR, proofs would revert RouteNotFound"
elif [ "$ROUTE_FROZEN" = "true" ]; then
  bad "the route for $SELECTOR is FROZEN, proofs cannot verify and the fix is a new verifier"
else
  ok "route $SELECTOR is live at $ROUTE_VERIFIER (version $(cast call "$ROUTE_VERIFIER" "VERSION()(string)" --rpc-url "${RPC_URL:-}" 2>/dev/null | tr -d '"'), not frozen)"
fi

echo "=== 10. the record this deploy will overwrite ==="
STATUS=$(jq -r .status deployments/sepolia.json)
if [ "$STATUS" = "deployed" ]; then
  note "deployments/sepolia.json already records a deploy. It is the release manifest file, so"
  note "the next run writes straight over it. Keep a copy if that record still matters."
else
  ok "deployments/sepolia.json is '$STATUS', so nothing is lost by deploying"
fi

echo
echo "=== $pass passed, $fail failed ==="
exit "$fail"
