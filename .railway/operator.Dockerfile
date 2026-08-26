# syntax=docker/dockerfile:1

# The release image is the reviewed multi-platform artifact. This Railway-only layer adds the two
# public files that Docker Compose previously bind-mounted; it does not rebuild or replace any
# operator binary or guest ELF.
FROM ghcr.io/ainima-collective/trustgraphs-operator@sha256:876aa9e9569e2de4366404a96b24ae4222e75763cbc692820bd9cdbfd15e0a40

COPY --chown=10001:10001 deployments/operator.sepolia.toml /etc/trustgraph/operator.toml
COPY --chown=10001:10001 deployments/sepolia.json /etc/trustgraph/sepolia.json

# Inherited ENTRYPOINT: /usr/local/bin/operator
CMD ["--config", "/etc/trustgraph/operator.toml"]
