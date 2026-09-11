# syntax=docker/dockerfile:1

# The release image is the reviewed multi-platform artifact. This Railway-only layer adds the two
# public files that Docker Compose previously bind-mounted; it does not rebuild or replace any
# operator binary or guest ELF.
#
# DEPLOY_TARGET selects the tracked profile, `sepolia` (default) or `mainnet`; Railway passes the
# service variable of that name as a build argument. The profile's `release_manifest` is a path
# relative to the config file (zk/operator/src/config.rs, `Config::load`), so the manifest is
# copied beside it under its own name and `release_manifest = "<target>.json"` resolves.
FROM ghcr.io/ainima-collective/trustgraphs-operator@sha256:645944e4ed08277bdbd1a9efc8e841af621565b02f82acaf251e39fdea301092

ARG DEPLOY_TARGET=sepolia
COPY --chown=10001:10001 deployments/operator.${DEPLOY_TARGET}.toml /etc/trustgraph/operator.toml
COPY --chown=10001:10001 deployments/${DEPLOY_TARGET}.json /etc/trustgraph/${DEPLOY_TARGET}.json

# Inherited ENTRYPOINT: /usr/local/bin/operator
CMD ["--config", "/etc/trustgraph/operator.toml"]
