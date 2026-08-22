FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/eas-offchain-client/package.json packages/eas-offchain-client/package.json
COPY services/eas-offchain-relay/package.json services/eas-offchain-relay/package.json
RUN pnpm install --frozen-lockfile --prod --filter @trustgraphs/eas-offchain-relay...

COPY packages/eas-offchain-client packages/eas-offchain-client
COPY services/eas-offchain-relay services/eas-offchain-relay

USER node
EXPOSE 8787
CMD ["pnpm", "--filter", "@trustgraphs/eas-offchain-relay", "start"]
