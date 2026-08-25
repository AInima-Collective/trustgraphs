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
numeric() { call "$1" "$2" | sed 's/\[.*//' | tr -d ' '; }

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
WEIGHTED_VERIFIER=$(addr weightedVerifier)
WEIGHTED_FACTORY=$(addr weightedTrustgraphsFactory)
GOVERNED_WEIGHTED_FACTORY=$(addr governedWeightedTrustgraphsFactory)
COMPOSITION_VERIFIER=$(addr compositionVerifier)
COMPOSITION_FACTORY=$(addr trustComposeFactory)
GOVERNED_COMPOSITION_FACTORY=$(addr governedTrustComposeFactory)
CONTRIBUTIONS_VERIFIER=$(addr contributionsVerifier)
CONTRIBUTIONS_FACTORY=$(addr contributionsFactory)
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

echo "=== every factory-backed hosted program is deployed and correctly bound ==="
if [ -z "$WEIGHTED_VERIFIER" ] || [ -z "$WEIGHTED_FACTORY" ] || [ -z "$GOVERNED_WEIGHTED_FACTORY" ]; then
  bad "weighted deployment family is incomplete"
else
  W_VKEY=$(call "$WEIGHTED_VERIFIER" "programVKey()(bytes32)")
  same "$W_VKEY" "${SP1_WEIGHTED_PROGRAM_VKEY:-}" && ok "weighted verifier pins its released vkey" \
    || bad "weighted verifier vkey is $W_VKEY, expected ${SP1_WEIGHTED_PROGRAM_VKEY:-unset}"
  same "$(call "$WEIGHTED_VERIFIER" "gateway()(address)")" "$(ext sp1Gateway)" \
    && ok "weighted verifier delegates to the canonical SP1 gateway" \
    || bad "weighted verifier gateway is wrong"
  for pair in "VERIFIER()(address):$WEIGHTED_VERIFIER" "INSTANCE_REGISTRY()(address):$REGISTRY" \
              "EAS()(address):$(ext eas)" "SCHEMA_REGISTRAR()(address):$REGISTRAR" \
              "VAULT()(address):$VAULT"; do
    sig=${pair%%:*}; want=${pair##*:}; got=$(call "$WEIGHTED_FACTORY" "$sig")
    same "$got" "$want" && ok "weighted factory ${sig%%(*} is $want" \
      || bad "weighted factory ${sig%%(*} is $got, expected $want"
  done
  same "$(call "$GOVERNED_WEIGHTED_FACTORY" "FACTORY()(address)")" "$WEIGHTED_FACTORY" \
    && ok "governed weighted wrapper points at the weighted factory" \
    || bad "governed weighted wrapper points at the wrong factory"
  W_FLOOR=$(numeric "$WEIGHTED_FACTORY" "EPOCH_FLOOR()(uint64)")
  [ "$W_FLOOR" = "${FACTORY_EPOCH_FLOOR:-}" ] && ok "weighted factory EPOCH_FLOOR is $W_FLOOR" \
    || bad "weighted factory EPOCH_FLOOR is $W_FLOOR, expected ${FACTORY_EPOCH_FLOOR:-unset}"
  W_DELAY=$(numeric "$WEIGHTED_FACTORY" "PRIOR_ACTIVATION_DELAY()(uint48)")
  [ "$W_DELAY" = "${WEIGHTED_PRIOR_ACTIVATION_DELAY:-86400}" ] && ok "weighted prior delay is $W_DELAY seconds" \
    || bad "weighted prior delay is $W_DELAY, expected ${WEIGHTED_PRIOR_ACTIVATION_DELAY:-86400}"
fi

if [ -z "$COMPOSITION_VERIFIER" ] || [ -z "$COMPOSITION_FACTORY" ] || [ -z "$GOVERNED_COMPOSITION_FACTORY" ]; then
  bad "composition deployment family is incomplete"
else
  C_VKEY=$(call "$COMPOSITION_VERIFIER" "programVKey()(bytes32)")
  same "$C_VKEY" "${SP1_COMPOSITION_PROGRAM_VKEY:-}" && ok "composition verifier pins its released vkey" \
    || bad "composition verifier vkey is $C_VKEY, expected ${SP1_COMPOSITION_PROGRAM_VKEY:-unset}"
  same "$(call "$COMPOSITION_VERIFIER" "gateway()(address)")" "$(ext sp1Gateway)" \
    && ok "composition verifier delegates to the canonical SP1 gateway" \
    || bad "composition verifier gateway is wrong"
  for pair in "VERIFIER()(address):$COMPOSITION_VERIFIER" "INSTANCE_REGISTRY()(address):$REGISTRY" \
              "VAULT()(address):$VAULT"; do
    sig=${pair%%:*}; want=${pair##*:}; got=$(call "$COMPOSITION_FACTORY" "$sig")
    same "$got" "$want" && ok "composition factory ${sig%%(*} is $want" \
      || bad "composition factory ${sig%%(*} is $got, expected $want"
  done
  same "$(call "$GOVERNED_COMPOSITION_FACTORY" "FACTORY()(address)")" "$COMPOSITION_FACTORY" \
    && ok "governed composition wrapper points at the composition factory" \
    || bad "governed composition wrapper points at the wrong factory"
  same "$(call "$COMPOSITION_FACTORY" "PROGRAM_VKEY()(bytes32)")" "${SP1_COMPOSITION_PROGRAM_VKEY:-}" \
    && ok "composition factory pins its released vkey" \
    || bad "composition factory PROGRAM_VKEY is wrong"
  C_FLOOR=$(numeric "$COMPOSITION_FACTORY" "EPOCH_FLOOR()(uint64)")
  [ "$C_FLOOR" = "${FACTORY_EPOCH_FLOOR:-}" ] && ok "composition factory EPOCH_FLOOR is $C_FLOOR" \
    || bad "composition factory EPOCH_FLOOR is $C_FLOOR, expected ${FACTORY_EPOCH_FLOOR:-unset}"
  C_DELAY=$(numeric "$COMPOSITION_FACTORY" "POLICY_ACTIVATION_DELAY()(uint48)")
  [ "$C_DELAY" = "${COMPOSE_POLICY_ACTIVATION_DELAY:-86400}" ] && ok "composition policy delay is $C_DELAY seconds" \
    || bad "composition policy delay is $C_DELAY, expected ${COMPOSE_POLICY_ACTIVATION_DELAY:-86400}"
fi

if [ -z "$CONTRIBUTIONS_VERIFIER" ] || [ -z "$CONTRIBUTIONS_FACTORY" ]; then
  bad "contributions deployment family is incomplete"
else
  K_VKEY=$(call "$CONTRIBUTIONS_VERIFIER" "programVKey()(bytes32)")
  same "$K_VKEY" "${CONTRIBUTIONS_PROGRAM_VKEY:-}" && ok "contributions verifier pins its released vkey" \
    || bad "contributions verifier vkey is $K_VKEY, expected ${CONTRIBUTIONS_PROGRAM_VKEY:-unset}"
  same "$(call "$CONTRIBUTIONS_VERIFIER" "gateway()(address)")" "$(ext sp1Gateway)" \
    && ok "contributions verifier delegates to the canonical SP1 gateway" \
    || bad "contributions verifier gateway is wrong"
  for pair in "VERIFIER()(address):$CONTRIBUTIONS_VERIFIER" "INSTANCE_REGISTRY()(address):$REGISTRY" \
              "EAS()(address):$(ext eas)" "SCHEMA_REGISTRAR()(address):$REGISTRAR"; do
    sig=${pair%%:*}; want=${pair##*:}; got=$(call "$CONTRIBUTIONS_FACTORY" "$sig")
    same "$got" "$want" && ok "contributions factory ${sig%%(*} is $want" \
      || bad "contributions factory ${sig%%(*} is $got, expected $want"
  done
  same "$(call "$CONTRIBUTIONS_FACTORY" "PROGRAM_VKEY()(bytes32)")" "${CONTRIBUTIONS_PROGRAM_VKEY:-}" \
    && ok "contributions factory pins its released vkey" \
    || bad "contributions factory PROGRAM_VKEY is wrong"
  K_FLOOR=$(numeric "$CONTRIBUTIONS_FACTORY" "EPOCH_FLOOR()(uint64)")
  [ "$K_FLOOR" = "${FACTORY_EPOCH_FLOOR:-}" ] && ok "contributions factory EPOCH_FLOOR is $K_FLOOR" \
    || bad "contributions factory EPOCH_FLOOR is $K_FLOOR, expected ${FACTORY_EPOCH_FLOOR:-unset}"
fi

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
for pair in "weighted:$WEIGHTED_FACTORY" "composition:$COMPOSITION_FACTORY" \
            "contributions:$CONTRIBUTIONS_FACTORY"; do
  label=${pair%%:*}; factory=${pair##*:}
  [ -n "$factory" ] || continue
  HAS=$(cast call "$REGISTRY" "hasRole(bytes32,address)(bool)" "$REGISTRAR_ROLE" "$factory" $R "$U" 2>/dev/null)
  [ "$HAS" = "true" ] && ok "$label factory holds REGISTRAR_ROLE" \
    || bad "$label factory does NOT hold REGISTRAR_ROLE: creation will revert"
  OP=$(cast call "$REGISTRY" "hasRole(bytes32,address)(bool)" "$OPERATOR_ROLE" "$factory" $R "$U" 2>/dev/null)
  [ "$OP" = "false" ] && ok "$label factory does not hold OPERATOR_ROLE" \
    || bad "$label factory HOLDS OPERATOR_ROLE and can rewrite registry rows"
done
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
