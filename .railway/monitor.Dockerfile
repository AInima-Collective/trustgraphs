# syntax=docker/dockerfile:1

# The monitor uses only Node's built-in fetch/process APIs. Keep it separate from the indexer image
# so a monitor deployment does not install or copy the Ponder application and its dependencies.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node ops/monitor-production.mjs /app/monitor-production.mjs

USER node
CMD ["node", "/app/monitor-production.mjs"]
