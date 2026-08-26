# syntax=docker/dockerfile:1
# Build context is the repository root:
#   docker build -f packages/indexer/Dockerfile -t trustgraphs-indexer .

FROM node:22-alpine AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Cache the dependency layer independently from source changes. The indexer deliberately keeps
# dev dependencies: its production startup runs drizzle-kit migrations and TypeScript sources.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/indexer/package.json packages/indexer/package.json
COPY packages/eas-offchain-client/package.json packages/eas-offchain-client/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter trustgraphs-indexer...

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV TRUSTGRAPHS_ENV_FROM_PROCESS=1
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/indexer/node_modules ./packages/indexer/node_modules
COPY --from=dependencies /app/packages/eas-offchain-client/node_modules ./packages/eas-offchain-client/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/indexer ./packages/indexer
COPY packages/eas-offchain-client ./packages/eas-offchain-client
COPY packages/frontend/lib ./packages/frontend/lib
COPY contracts/deploy ./contracts/deploy
COPY config ./config
COPY deployments ./deployments
COPY scripts/load-env.cjs ./scripts/load-env.cjs
COPY scripts/redact-secrets.cjs ./scripts/redact-secrets.cjs

# Hosted services explicitly load their complete configuration from the process environment.
# The static fallback catalog is fixed at image-build time, so startup never mutates the read-only
# application tree.
#
# Ponder executes every file under `src/` when it builds indexing functions, ignoring only the API
# directory, and this repository keeps unit tests beside the modules they cover. Several of those
# tests read golden vectors from repository paths this image deliberately does not carry, so a test
# file left in the tree fails the indexing build over a fixture the indexer never needs to run.
#
# `.dockerignore` excludes those tests before `COPY`. Do not delete them in this layer: that records
# OCI whiteouts over the earlier copy layer, and Railway Runtime V2 can expose whiteouted files when
# it materializes the container. Keep the assertion so an ignore-rule regression fails the image
# build instead of crash-looping the service at startup.
RUN rm -f packages/indexer/networks.json \
    && ln -s ../../config/networks.sepolia.json packages/indexer/networks.json \
    && remaining="$(find packages/indexer/src -name '*.test.ts')" \
    && if [ -n "$remaining" ]; then \
         echo "image still carries indexer test files:" >&2; echo "$remaining" >&2; exit 1; \
       fi \
    && chown -R node:node /app

USER node
EXPOSE 65421

ENTRYPOINT ["node", "/app/packages/indexer/scripts/launch-indexer.mjs"]
CMD ["start"]
