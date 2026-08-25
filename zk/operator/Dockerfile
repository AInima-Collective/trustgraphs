# The operator, as one image: a daemon, its four helper binaries, and nothing else.
#
# Build context is the REPOSITORY ROOT, not this directory:
#
#   task zk:build                                   # the guest ELFs, once (needs Docker + SP1)
#   docker build -f zk/operator/Dockerfile -t trustgraphs-operator .
#
# Two things about the guests. First, they are NOT built here: `cargo prove build --docker` runs
# `docker run`, and there is no daemon inside a `docker build`. They are built beforehand, on the
# host or in CI, and copied in from the context — which is also what makes the ELF in this image
# the same bytes CI published a digest for. Second, every cargo invocation below sets
# SP1_SKIP_PROGRAM_BUILD=true, so `include_elf!` embeds those exact ELFs rather than quietly
# rebuilding them under a different toolchain and returning proofs under a vkey no verifier pinned.

# ---------------------------------------------------------------------------------------------
# Latest stable 1.x, not the workspace's declared `rust-version = "1.87.0"`. That claim is stale:
# `pagerank-core` reaches `base45` through `ipld-core`/`cid`/`multibase`, and it uses a library
# feature that was unstable in 1.87, so the tree does not actually build on its stated MSRV.
# Nothing noticed because `rust.yml` builds with `@stable` and this Dockerfile was the first thing
# ever to honour the pin.
#
# Not pinning an exact rustc is deliberate. The reproducibility guarantee lives in the GUESTS,
# which are compiled separately inside the pinned SP1 container and whose digests two machines
# must agree on. These host binaries carry no such claim — the release attests the image digest
# it actually published, not the ability to recreate it byte-for-byte later.
FROM rust:1-bookworm AS builder

# protobuf-compiler is for the operator's `network` feature: SP1_PROVER=network pulls the
# prover-network gRPC client, which generates its stubs at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      protobuf-compiler pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

# Fail here, with a sentence, rather than several minutes later inside a Rust build with a
# missing-file error from `include_elf!` that reads like a broken checkout.
RUN set -eu; \
    T=riscv64im-succinct-zkvm-elf/release; \
    for elf in \
      "zk/trustgraph-program-v2/target/elf-compilation/docker/$T/trustgraph-program-v2" \
      "zk/program/target/elf-compilation/docker/$T/trustgraph-signer-program" \
      "zk/nostr-program/target/elf-compilation/docker/$T/nostr-workspace" \
      ; do \
      [ -f "$elf" ] || { \
        echo "missing REPRODUCIBLE guest ELF: $elf" >&2; \
        echo "The guests are built outside this image, in the pinned SP1 builder container:" >&2; \
        echo "    sh scripts/build-guests.sh" >&2; \
        echo "A plainly-built ELF under target/elf-compilation/ is deliberately not accepted" >&2; \
        echo "here: its vkey is a property of the machine that produced it." >&2; \
        exit 1; \
      }; \
    done

ENV SP1_SKIP_PROGRAM_BUILD=true

# The input reconstruction tools. `input-exporter` is the only one the trust-graph and signer
# lanes need; `envelope0-preflight` is a second binary of the same crate.
RUN cargo build --release --locked -p input-exporter --bins

# The prover host, with the two feature sets the heavier lanes shell out to. One binary carries
# both: `tools::Tool` looks for `trustgraph-prover` when no lane-specific binary is present.
RUN cargo build --release --locked --manifest-path zk/prover/Cargo.toml \
      --features fetch,witness-nostr

# The daemon. `network` is what makes SP1_PROVER=network work, which is how a self-hoster proves
# without owning a proving rig.
RUN cargo build --release --locked --manifest-path zk/operator/Cargo.toml --features network

# The guest identity, shipped with the image so "which guest is this container running?" is one
# command rather than an archaeology project. The entrypoint is the daemon, so ask for another:
#   docker run --rm --entrypoint cat IMAGE /etc/trustgraph/elf-digests.txt
RUN set -eu; mkdir -p /out/bin /out/etc; \
    sh scripts/guest-elf-digests.sh > /out/etc/elf-digests.txt; \
    cp target/release/input-exporter target/release/envelope0-preflight /out/bin/; \
    cp zk/prover/target/release/trustgraph-prover /out/bin/; \
    cp zk/operator/target/release/operator /out/bin/

# ---------------------------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates for TLS to the RPC, the prover network and IPFS gateways. curl is the container
# healthcheck below and nothing else. No compiler, no toolchain, no source tree.
# The user is `trustgraphs`, not `operator`, and the reason is not taste: `operator` is already
# a system GROUP in Debian (legacy, GID 37), so `useradd operator` fails at its default "create a
# group of the same name" step with exit 9. Naming our own group explicitly also stops the daemon
# from inheriting a legacy admin group by accident.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 trustgraphs \
    && useradd --system --uid 10001 --gid 10001 \
         --home-dir /data --shell /usr/sbin/nologin trustgraphs

COPY --from=builder /out/bin/ /usr/local/bin/
COPY --from=builder /out/etc/elf-digests.txt /etc/trustgraph/elf-digests.txt

# The state directory. Mount a volume here: `journal.jsonl` is the one file whose loss costs real
# money, and the daemon REFUSES to start if this path's parent is missing — which is exactly what
# an unmounted volume looks like.
RUN mkdir -p /data && chown trustgraphs:trustgraphs /data
VOLUME ["/data"]
USER trustgraphs
WORKDIR /data

# `[ops] tool_dir` needs no configuration in this image: the daemon finds its tools beside itself.
# The start period covers the FIRST pass, not just process startup: `/ready` reports failure
# until one tick has completed end to end, and a first tick that proves can take as long as the
# prover's own timeout. Failing readiness there and restarting would burn exactly the proof it is
# waiting for.
ENV OPERATOR_HEALTH_URL=http://127.0.0.1:8080/ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
  CMD curl -fsS "$OPERATOR_HEALTH_URL" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/operator"]
CMD ["--config", "/etc/trustgraph/operator.toml"]

# Filled in by the release workflow: the source commit, and the digest of the trust-graph guest
# whose vkey the deployed verifier is pinned to.
ARG SOURCE_COMMIT=unknown
ARG TRUST_GRAPH_ELF_SHA256=unknown
LABEL org.opencontainers.image.title="trustgraphs-operator" \
      org.opencontainers.image.description="Keeps proven trustgraphs scores fresh, unattended." \
      org.opencontainers.image.source="https://github.com/JakeHartnell/trustgraphs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.trustgraphs.guest.trust-graph.sha256="${TRUST_GRAPH_ELF_SHA256}"
