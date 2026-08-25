#!/usr/bin/env bash
#
# Post-deploy invariants for a public-chain stack. Reads the chain, changes nothing.
#
# The deploy prints role-granting commands for a human to run afterwards, and a printed command
# is not evidence that it landed. This asserts the end state instead: what the contracts point
# at, who holds which role, and who no longer holds one. Every check is worded so that the
# failure tells you what is wrong rather than that something is.
#
# Run it after the broadcast, again after the registrar grant, and again after the vault
# handoff. The checks that are meant to fail before those steps say so.
#
# Usage:  bash scripts/sepolia-postdeploy-check.sh
# Exit code is the number of failed checks.

set -uo pipefail
cd "$(dirname "$0")/.."

if [ "${TRUSTGRAPHS_TARGET_ENV_LOADED:-}" != "1" ]; then
  exec node scripts/run-with-target-env.cjs sepolia bash "$0" "$@"
fi

MANIFEST=deployments/sepolia.json
R=--rpc-url
U="${RPC_URL:-}"

pass=0; fail=0
ok()   { echo "  ok    $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
note() { echo "        $1"; }

# Compare case-insensitively: addresses come back checksummed from some calls and lowercase from
# others, and a spurious failure here would train someone to skim the output.
same() { [ "$(echo "$1" | tr 'A-Z' 'a-z')" = "$(echo "$2" | tr 'A-Z' 'a-z')" ]; }

call() { cast call "$1" "$2" $R "$U" 2>/dev/null | head -1; }

addr() { jq -r --arg k "$1" '.contracts[$k].address // empty' "$MANIFEST"; }
ext()  { jq -r --arg k "$1" '.external[$k] // empty' "$MANIFEST"; }

REGISTRAR=$(addr schemaRegistrar)
VERIFIER=$(addr rootVerifier)
REGISTRY=$(addr instanceRegistry)
VAULT=$(addr provingVault)
FACTORY=$(addr trustgraphsFactory)
SIGNER_VERIFIER=$(addr signerVerifier)
GOVERNED_FACTORY=$(addr governedTrustgraphsFactory)
SIGNER_DEPLOYER=$(addr signerSyncModuleDeployer)
SAFE_SINGLETON=$(addr safeSingleton)
SAFE_FACTORY=$(addr safeProxyFactory)
ADMIN="${INSTANCE_REGISTRY_ADMIN:-}"
DEPLOYER=$(cast wallet address --private-key "${FUNDED_KEY:-}" 2>/dev/null || echo unknown)

for pair in "schemaRegistrar:$REGISTRAR" "rootVerifier:$VERIFIER" "instanceRegistry:$REGISTRY" \
            "provingVault:$VAULT" "trustgraphsFactory:$FACTORY" "signerVerifier:$SIGNER_VERIFIER" \
            "governedTrustgraphsFactory:$GOVERNED_FACTORY" "signerSyncModuleDeployer:$SIGNER_DEPLOYER" \
            "safeSingleton:$SAFE_SINGLETON" "safeProxyFactory:$SAFE_FACTORY"; do
  [ -n "${pair##*:}" ] || { echo "$MANIFEST has no address for ${pair%%:*}; deploy first" >&2; exit 1; }
done

DEFAULT_ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
REGISTRAR_ROLE=$(cast keccak "REGISTRAR_ROLE")
OPERATOR_ROLE=$(cast keccak "OPERATOR_ROLE")
FEE_SETTER_ROLE=$(cast keccak "FEE_SETTER_ROLE")

echo "=== the verifier pins the released guest, and nothing else ==="
# The failure this whole redeploy exists for. `programVKey` is immutable, so this is the last
# moment it can be caught cheaply rather than by a proof that will not verify.
PVK=$(call "$VERIFIER" "programVKey()(bytes32)")
same "$PVK" "${SP1_PROGRAM_VKEY:-}" && ok "programVKey is SP1_PROGRAM_VKEY" \
  || bad "programVKey is $PVK, .env says ${SP1_PROGRAM_VKEY:-unset}"
if [ -f guest-manifest.json ]; then
  RELEASED=$(jq -r '.programs[] | select(.program=="trust-graph") | .vkey' guest-manifest.json)
  same "$PVK" "$RELEASED" && ok "programVKey is the vkey the release published" \
    || bad "programVKey is $PVK, the release published $RELEASED"
fi
GW=$(call "$VERIFIER" "gateway()(address)")
same "$GW" "$(ext sp1Gateway)" && ok "verifier delegates to the canonical SP1 gateway" \
  || bad "verifier delegates to $GW, expected $(ext sp1Gateway)"

echo "=== the signer verifier and governed wrapper pin the released signer guest ==="
SPVK=$(call "$SIGNER_VERIFIER" "programVKey()(bytes32)")
same "$SPVK" "${SP1_SIGNER_PROGRAM_VKEY:-}" && ok "signer verifier pins SP1_SIGNER_PROGRAM_VKEY" \
  || bad "signer verifier pins $SPVK, .env.sepolia says ${SP1_SIGNER_PROGRAM_VKEY:-unset}"
SGW=$(call "$SIGNER_VERIFIER" "gateway()(address)")
same "$SGW" "$(ext sp1Gateway)" && ok "signer verifier delegates to the canonical SP1 gateway" \
  || bad "signer verifier delegates to $SGW, expected $(ext sp1Gateway)"
for pair in "FACTORY()(address):$FACTORY" "SAFE_SINGLETON()(address):$SAFE_SINGLETON" \
            "SAFE_FACTORY()(address):$SAFE_FACTORY" "SIGNER_SYNC_VERIFIER()(address):$SIGNER_VERIFIER" \
            "SIGNER_SYNC_DEPLOYER()(address):$SIGNER_DEPLOYER"; do
  sig=${pair%%:*}; want=${pair##*:}
  got=$(call "$GOVERNED_FACTORY" "$sig")
  same "$got" "$want" && ok "governed factory ${sig%%(*} is $want" \
    || bad "governed factory ${sig%%(*} is $got, expected $want"
done
GSPVK=$(call "$GOVERNED_FACTORY" "SIGNER_SYNC_PROGRAM_VKEY()(bytes32)")
same "$GSPVK" "${SP1_SIGNER_PROGRAM_VKEY:-}" && ok "governed factory pins the released signer vkey" \
  || bad "governed factory signer vkey is $GSPVK, expected ${SP1_SIGNER_PROGRAM_VKEY:-unset}"

echo "=== the factory points at the contracts we just deployed ==="
for pair in "VERIFIER()(address):$VERIFIER" "VAULT()(address):$VAULT" \
            "INSTANCE_REGISTRY()(address):$REGISTRY" "EAS()(address):$(ext eas)" \
            "SCHEMA_REGISTRAR()(address):$REGISTRAR"; do
  sig=${pair%%:*}; want=${pair##*:}
  got=$(call "$FACTORY" "$sig")
  same "$got" "$want" && ok "factory ${sig%%(*} is $want" || bad "factory ${sig%%(*} is $got, expected $want"
done
FLOOR=$(call "$FACTORY" "EPOCH_FLOOR()(uint64)" | tr -d ' ')
[ "$FLOOR" = "${FACTORY_EPOCH_FLOOR:-}" ] && ok "factory EPOCH_FLOOR is $FLOOR" \
  || bad "factory EPOCH_FLOOR is $FLOOR, .env says ${FACTORY_EPOCH_FLOOR:-unset}"

echo "=== the vault points at the registry and the real feed ==="
for pair in "REGISTRY()(address):$REGISTRY" "USDC()(address):$(ext usdc)" \
            "ETH_USD_FEED()(address):$(ext ethUsdFeed)"; do
  sig=${pair%%:*}; want=${pair##*:}
  got=$(call "$VAULT" "$sig")
  same "$got" "$want" && ok "vault ${sig%%(*} is $want" || bad "vault ${sig%%(*} is $got, expected $want"
done

echo "=== who can register networks (step 3 of the deploy) ==="
# The registry is built with the admin EOA as its admin from birth, so the deployer cannot make
# this grant and the deploy does not try. Until someone does, every network creation reverts.
HAS=$(cast call "$REGISTRY" "hasRole(bytes32,address)(bool)" "$REGISTRAR_ROLE" "$FACTORY" $R "$U" 2>/dev/null)
[ "$HAS" = "true" ] && ok "factory holds REGISTRAR_ROLE" \
  || bad "factory does NOT hold REGISTRAR_ROLE: network creation will revert until the admin grants it"
OP=$(cast call "$REGISTRY" "hasRole(bytes32,address)(bool)" "$OPERATOR_ROLE" "$FACTORY" $R "$U" 2>/dev/null)
# The negative one. OPERATOR_ROLE would let the factory rewrite existing records rather than only
# append its own, so this must stay false for as long as the registry exists.
[ "$OP" = "false" ] && ok "factory does not hold OPERATOR_ROLE (it must not)" \
  || bad "factory HOLDS OPERATOR_ROLE: it could rewrite records it did not create"
RA=$(cast call "$REGISTRY" "hasRole(bytes32,address)(bool)" "$DEFAULT_ADMIN_ROLE" "$ADMIN" $R "$U" 2>/dev/null)
[ "$RA" = "true" ] && ok "registry admin is the admin EOA" || bad "admin EOA does not hold registry DEFAULT_ADMIN_ROLE"

echo "=== who controls vault fees (step 4 of the deploy) ==="
# `DeployProvingVault` hardcodes the deployer as admin and fee setter and the plan has no handoff,
# so left alone a key made for one afternoon holds fee authority forever. Grant before renounce:
# reversed, the vault has no admin and can never be given one.
for pair in "admin EOA:DEFAULT_ADMIN:$ADMIN:$DEFAULT_ADMIN_ROLE:true" \
            "admin EOA:FEE_SETTER:$ADMIN:$FEE_SETTER_ROLE:true" \
            "deployer:DEFAULT_ADMIN:$DEPLOYER:$DEFAULT_ADMIN_ROLE:false" \
            "deployer:FEE_SETTER:$DEPLOYER:$FEE_SETTER_ROLE:false"; do
  IFS=':' read -r who role account hash want <<EOF2
$pair
EOF2
  got=$(cast call "$VAULT" "hasRole(bytes32,address)(bool)" "$hash" "$account" $R "$U" 2>/dev/null)
  if [ "$got" = "$want" ]; then ok "$who holds ${role}_ROLE: $got"
  else bad "$who ${role}_ROLE is $got, must be $want"; fi
done

echo "=== networks created so far ==="
COUNT=$(cast call "$REGISTRY" "instanceCount()(uint256)" $R "$U" 2>/dev/null | tr -d ' ')
note "instanceCount = ${COUNT:-unknown}"

echo
echo "=== $pass passed, $fail failed ==="
exit "$fail"
