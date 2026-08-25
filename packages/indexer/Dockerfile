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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter trustgraphs-indexer...

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV TRUSTGRAPHS_CONTAINER_ENV=1
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/indexer/node_modules ./packages/indexer/node_modules
COPY --from=dependencies /app/packages/eas-offchain-client/node_modules ./packages/eas-offchain-client/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .env.example ./.env
COPY packages/indexer ./packages/indexer
COPY packages/eas-offchain-client ./packages/eas-offchain-client
COPY packages/frontend/lib ./packages/frontend/lib
COPY contracts/deploy ./contracts/deploy
COPY config ./config
COPY deployments ./deployments
COPY scripts/load-env.cjs ./scripts/load-env.cjs
COPY ops/monitor-production.mjs ./ops/monitor-production.mjs

# The target is selected explicitly at runtime. A blank tracked-target overlay lets the common
# loader keep its public-target fail-closed contract while all deploy-specific values arrive as
# container environment variables. The static fallback catalog is fixed at image-build time, so
# startup never mutates the read-only application tree.
RUN touch .env.sepolia \
    && rm -f packages/indexer/networks.json \
    && ln -s ../../config/networks.sepolia.json packages/indexer/networks.json \
    && chown -R node:node /app

USER node
EXPOSE 65421 65422

HEALTHCHECK --interval=30s --timeout=5s --start-period=2m --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PONDER_HEALTH_PORT:-65421}/ready" || exit 1

ENTRYPOINT ["node", "/app/packages/indexer/scripts/launch-indexer.mjs"]
CMD ["start"]
