#!/usr/bin/env bash
# Secret scan (audit F-1, the H-2 follow-through) — fail CI if a bespoke private key re-enters
# the tree. This is the THIRD occurrence of a committed key (July scrub, then H-2), so the gate
# is tailored to the failure mode we actually have: raw 64-hex secp256k1 keys in key-shaped
# context, and PEM private-key blocks. The well-known anvil/hardhat dev keys are allowlisted —
# they are publicly documented and gate nothing.
#
# Usage: scripts/secret-scan.sh   (scans all git-tracked files; exits 1 on findings)
set -euo pipefail
cd "$(dirname "$0")/.."

# The ten standard anvil/hardhat dev keys (accounts 0-9) — public knowledge, allowed.
ALLOW=(
  ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
  7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
  47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
  8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
  92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
  4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
  dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
  2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6
  # Fixture-only throwaway generated with the atproto hypercerts test fixture
  # (tests/fixtures/atproto/hypercerts/fixtures/meta.json): it signed the fixture's link.evm
  # EIP-712 binding for 0xD030e5..., which the guest tests verify. It controls no funds and no
  # real identity; it is committed so the fixture's signatures are reproducible.
  b9b280a1522bdcb9d608975e9c17b2e1237e8ea8dc616c2532d3e893617dc75a
)

# Key-shaped context: a 64-hex blob on a line that also says it is a key. Plain 64-hex alone is
# NOT flagged — this tree is full of legitimate hashes, digests, and golden vectors.
CONTEXT='(PRIVATE_KEY|PRIVATE-KEY|private_key|privateKey|SECRET_KEY|secret_key|secretKey|signing_key|signingKey|SIGNER_KEY|FUNDED_KEY|MNEMONIC|--key)'

fail=0

# 1. Raw hex keys in key-shaped context.
matches=$(git grep -nIE "${CONTEXT}[^0-9a-fA-F]{0,40}(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)" -- \
  ':!*.lock' ':!pnpm-lock.yaml' ':!scripts/secret-scan.sh' || true)
if [ -n "$matches" ]; then
  while IFS= read -r line; do
    hexes=$(printf '%s' "$line" | grep -oE '[0-9a-fA-F]{64}' || true)
    allowed_all=1
    while IFS= read -r h; do
      [ -z "$h" ] && continue
      hit=0
      for a in "${ALLOW[@]}"; do
        if [ "${h,,}" = "$a" ]; then hit=1; break; fi
      done
      if [ "$hit" -eq 0 ]; then allowed_all=0; fi
    done <<<"$hexes"
    if [ "$allowed_all" -eq 0 ]; then
      echo "POSSIBLE COMMITTED KEY: $line"
      fail=1
    fi
  done <<<"$matches"
fi

# 2. PEM private-key blocks, anywhere (except this script's own pattern).
pem=$(git grep -nI -e '-----BEGIN .*PRIVATE KEY-----' -- ':!scripts/secret-scan.sh' || true)
if [ -n "$pem" ]; then
  echo "PEM PRIVATE KEY BLOCK:"
  echo "$pem"
  fail=1
fi

# 3. An ignored dotenv file may legitimately contain the active secret assignment, but never a
# second copy in a comment. Besides multiplying the places that need rotation, commented copies
# bypass tooling that redacts NAME=value lines. Report only file and line number here: printing the
# matching line would repeat the leak this check is meant to catch.
shopt -s nullglob
local_env_files=(.env .env.* packages/*/.env packages/*/.env.*)
for file in "${local_env_files[@]}"; do
  [ -f "$file" ] || continue
  while IFS= read -r line_number; do
    [ -n "$line_number" ] || continue
    echo "CREDENTIAL COPY IN DOTENV COMMENT: ${file}:${line_number}"
    fail=1
  done < <(
    grep -nEi \
      '^[[:space:]]*#[[:space:]]*(API Key|API Secret|JWT):[[:space:]]*[^<[:space:]]|^[[:space:]]*#[[:space:]]*(FORK_RPC_URL|RPC_URL|PONDER_RPC_URL_[0-9]+)=https?://[^[:space:]]*(alchemy|infura|quicknode)[^[:space:]]*/[A-Za-z0-9_-]{12,}' \
      "$file" | cut -d: -f1 || true
  )
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Secret scan FAILED. If a hit is a well-known public dev key, add it to the allowlist"
  echo "in scripts/secret-scan.sh with a comment saying where it is documented. If it is a"
  echo "real key: rotate it FIRST, then scrub the history — deleting the line does not unleak it."
  exit 1
fi
echo "secret scan clean"
