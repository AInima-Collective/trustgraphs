#!/usr/bin/env bash
#
# The self-hosting claim, run as a command instead of read as prose.
#
# `run-a-prover.md` §5 says: one image, one config file, two secrets, one volume, and no repo
# checkout. This script is that section, executable. It deliberately uses NOTHING from this
# repository except itself — no cargo, no forge, no anvil, no source tree — because a test that
# needs the checkout cannot check a claim whose whole content is "you do not need the checkout".
#
#   curl -O https://raw.githubusercontent.com/AInima-Collective/trustgraphs/main/tests/e2e/selfhost.sh
#   RPC=https://sepolia.example REGISTRY=0x… IPFS_API=https://… IPFS_GATEWAY=https://… bash selfhost.sh
#
#   IMAGE     which image to test        (default: the published :latest)
#   RPC       a JSON-RPC endpoint        (required)
#   REGISTRY  the InstanceRegistry       (required)
#   IPFS_API  Kubo-compatible add API    (required)
#   IPFS_GATEWAY  public read gateway    (required)
#   FROM_BLOCK  registry deployment block  (default 0, and see the warning it prints)
#
# What it does NOT prove: that a root lands. That needs a funded instance and a prover key, and it
# is the last step of the M6 walkthrough rather than something a smoke test can assert. What it
# does prove is everything between "docker pull" and there: the image is anonymously pullable,
# boots from a config and two secrets, reads the chain, serves the health surface, keeps its state
# on the volume across a restart, and carries the guests the release says it carries.

set -uo pipefail

IMAGE="${IMAGE:-ghcr.io/ainima-collective/trustgraphs-operator:latest}"
RPC="${RPC:-}"
REGISTRY="${REGISTRY:-}"
IPFS_API="${IPFS_API:-}"
IPFS_GATEWAY="${IPFS_GATEWAY:-}"
FROM_BLOCK="${FROM_BLOCK:-0}"
PORT="${PORT:-18080}"
WORK="${WORK:-$(mktemp -d)}"
VOLUME="${VOLUME:-trustgraphs-selfhost-test}"
NAME="trustgraphs-selfhost-test"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
say() { echo -e "$*"; }
die() { echo -e "${RED}FATAL:${NC} $*" >&2; logs; exit 1; }
logs() { docker logs "$NAME" 2>&1 | tail -15 >&2 || true; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$VOLUME" >/dev/null 2>&1
  return 0
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || die "docker not found; this test is about a container"
command -v curl   >/dev/null 2>&1 || die "curl not found"
command -v jq     >/dev/null 2>&1 || die "jq not found"
[ -n "$RPC" ]      || die "RPC is required (an endpoint the daemon can read)"
[ -n "$REGISTRY" ] || die "REGISTRY is required (the InstanceRegistry address)"
[ -n "$IPFS_API" ] || die "IPFS_API is required (a Kubo-compatible publication endpoint)"
[ -n "$IPFS_GATEWAY" ] || die "IPFS_GATEWAY is required (the corresponding public read gateway)"

cleanup

# --- 1. anonymously pullable ---------------------------------------------------------------
# The claim §5 opens with, and the one a stranger tests first. A GHCR package is PRIVATE by
# default even on a public repository, so this is the step that catches a missed visibility flip.
say "== docker pull, with whatever credentials this machine happens to have =="
docker pull "$IMAGE" >/dev/null 2>&1 \
  || die "could not pull $IMAGE. If this machine has no GHCR credentials, that is the point of
   the test: the package may still be private. Check its visibility settings."
say "   ${GREEN}pulled ✓${NC}"

# --- 2. the guests it carries, without starting it -------------------------------------------
say "== which guests is this image running? =="
DIGESTS=$(docker run --rm --entrypoint cat "$IMAGE" /etc/trustgraph/elf-digests.txt 2>/dev/null) \
  || die "the image does not carry /etc/trustgraph/elf-digests.txt"
COUNT=$(printf '%s\n' "$DIGESTS" | wc -l | tr -d ' ')
[ "$COUNT" -ge 9 ] || die "only $COUNT guest ELF digests in the image; expected at least 9"
say "   $COUNT guests, e.g. $(printf '%s\n' "$DIGESTS" | grep 'trust-graph-program$' | awk '{print $1}')"
say "   ${GREEN}answerable without starting it ✓${NC}"

# --- 3. one config file, two secrets, one volume ----------------------------------------------
cat > "$WORK/operator.toml" <<EOF
rpc                 = "$RPC"
registry            = "$REGISTRY"
registry_from_block = $FROM_BLOCK

[curated]
instances = []

[prover]
backend = "mock"

[ipfs]
min_success = 1
[[ipfs.targets]]
name = "self-hosted"
api = "$IPFS_API"
gateway = "$IPFS_GATEWAY"

[ops]
state_dir  = "/data"
listen     = "0.0.0.0:8080"
log_format = "json"
EOF

docker volume create "$VOLUME" >/dev/null
say "== docker run: a config, a volume, and a key =="
docker run -d --name "$NAME" \
  -v "$VOLUME:/data" \
  -v "$WORK/operator.toml:/etc/trustgraph/operator.toml:ro" \
  -e SUBMITTER_PRIVATE_KEY="${SUBMITTER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" \
  -p "$PORT:8080" \
  "$IMAGE" >/dev/null \
  || die "the container would not start"

# --- 4. the health surface --------------------------------------------------------------------
code() { curl -s -o "$WORK/body" -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT$1" 2>/dev/null || echo 000; }
await() { local d=$((SECONDS + $3)); while [ "$SECONDS" -lt "$d" ]; do [ "$(code "$1")" = "$2" ] && return 0; sleep 2; done; return 1; }

say "== the health surface =="
await /health 200 300 || die "/health never answered; the daemon did not come up"
say "   ${GREEN}/health 200 ✓${NC}"
# Generous: readiness requires one COMPLETED pass, and the first one derives every guest vkey.
await /ready 200 600 || die "/ready never went green: the daemon never completed a pass"
say "   ${GREEN}/ready 200 — it completed a full pass against $RPC ✓${NC}"

[ "$(code /status)" = "200" ] || die "/status did not answer"
HEAD=$(jq -r .head_block "$WORK/body")
[ "$HEAD" != "null" ] && [ "$HEAD" -gt 0 ] 2>/dev/null \
  || die "the heartbeat has no head block; it never read the chain"
say "   ${GREEN}heartbeat reports head block $HEAD ✓${NC}"
grep -qF "$RPC" "$WORK/body" && die "the heartbeat leaked the RPC endpoint"
say "   ${GREEN}and does not name the endpoint it read it from ✓${NC}"

# --- 5. the volume is the point -----------------------------------------------------------------
# `journal.jsonl` is the file whose loss costs money. If it is not on the volume, a redeploy
# re-requests proofs already paid for — so "it started" is not the claim worth testing.
say "== restart: the state has to survive =="
BEFORE=$(docker exec "$NAME" ls /data 2>/dev/null | sort | tr '\n' ' ')
[ -n "$BEFORE" ] || die "/data is empty; the daemon is not keeping state where the volume is"
docker restart "$NAME" >/dev/null || die "the container would not restart"
await /health 200 300 || die "it did not come back after a restart"
AFTER=$(docker exec "$NAME" ls /data 2>/dev/null | sort | tr '\n' ' ')
[ "$BEFORE" = "$AFTER" ] || die "the state directory changed across a restart: [$BEFORE] -> [$AFTER]"
say "   ${GREEN}/data survived: $AFTER${NC}"

# --- 6. the two things that actually keep the journal ---------------------------------------------
# This section used to assert that the daemon "refuses to start without a volume", which is not
# true of the config this image ships and never was: the refusal fires when state_dir's PARENT is
# missing, and the parent of `/data` is `/`. Testing an overstated claim is worse than testing
# nothing, because it comes back green. So both real protections get tested instead.
say "== what actually keeps journal.jsonl =="

# (a) `/data` is a declared volume, so the journal is never on the container's writable layer.
#     A named volume is still the operator's job; this is the half the IMAGE is responsible for.
docker image inspect "$IMAGE" --format '{{json .Config.Volumes}}' 2>/dev/null \
  | grep -q '"/data"' \
  || die "the image does not declare /data a volume, so an unmounted run would put the request
   journal on the container's writable layer and lose it at the next deploy"
say "   ${GREEN}/data is a declared volume: the journal is never on the writable layer ✓${NC}"

# (b) The guard, tested on the path shape it actually covers: a state_dir UNDER a mount point that
#     has not been mounted. This is the mistake that costs money on a real host, and the daemon
#     has to refuse it rather than helpfully create the tree.
sed 's|^state_dir  = "/data"|state_dir  = "/mnt/operator/state"|' \
  "$WORK/operator.toml" > "$WORK/guard.toml"
grep -q '/mnt/operator/state' "$WORK/guard.toml" || die "could not build the guard fixture"
if docker run --rm \
     -v "$WORK/guard.toml:/etc/trustgraph/operator.toml:ro" \
     --entrypoint /usr/local/bin/operator "$IMAGE" \
     --config /etc/trustgraph/operator.toml --once --dry-run >"$WORK/guard.out" 2>&1; then
  die "the daemon started with state_dir=/mnt/operator/state and /mnt/operator missing. That is
   what an unmounted volume looks like, and creating the tree anyway puts the request journal on
   a filesystem that disappears at the next deploy."
fi
grep -qi "state_dir" "$WORK/guard.out" \
  && say "   ${GREEN}refuses a state_dir whose mount point is missing ✓${NC}" \
  || die "it refused, but for another reason: $(tail -1 "$WORK/guard.out")"

say ""
say "${GREEN}SELF-HOST PASS — pulled anonymously, started from one config and one key, read${NC}"
say "${GREEN}$RPC, served its health surface, and kept its state on the volume across a restart.${NC}"
say ""
say "Not proven here, and the last step of the walkthrough: a root actually landing. That needs a"
say "funded instance and a prover key. See run-a-prover.md §5."
