# syntax=docker/dockerfile:1

# The release image is the reviewed multi-platform artifact. This Railway-only layer adds the two
# public files that Docker Compose previously bind-mounted; it does not rebuild or replace any
# operator binary or guest ELF.
FROM ghcr.io/ainima-collective/trustgraphs-operator@sha256:d37fad30f3007a1f0f515ffec1f8a1542248296d71b796705146f086e94f22e6

COPY --chown=10001:10001 deployments/operator.sepolia.toml /etc/trustgraph/operator.toml
COPY --chown=10001:10001 deployments/sepolia.json /etc/trustgraph/sepolia.json

# Inherited ENTRYPOINT: /usr/local/bin/operator
CMD ["--config", "/etc/trustgraph/operator.toml"]
