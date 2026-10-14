FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
COPY .npmrc ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY apps/worker/package.json ./apps/worker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/documents/package.json ./packages/documents/
COPY packages/data-access/package.json ./packages/data-access/
RUN --mount=type=cache,id=hr-dam-npm,target=/root/.npm,sharing=locked npm ci --omit=dev --workspace=@hr/worker --workspace=@hr/documents --workspace=@hr/contracts --workspace=@hr/data-access --include-workspace-root=false --fetch-timeout=30000 --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY .npmrc ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY apps/worker/package.json ./apps/worker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/documents/package.json ./packages/documents/
COPY packages/data-access/package.json ./packages/data-access/
RUN --mount=type=cache,id=hr-dam-npm,target=/root/.npm,sharing=locked npm ci --workspace=@hr/worker --workspace=@hr/documents --workspace=@hr/contracts --workspace=@hr/data-access --include-workspace-root --fetch-timeout=30000 --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY packages/documents ./packages/documents
COPY packages/data-access ./packages/data-access
COPY apps/worker ./apps/worker
RUN npm run build -w @hr/contracts && npm run build -w @hr/documents && npm run build -w @hr/data-access && npm run build -w @hr/worker

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=dependencies --chown=node:node /app/packages/data-access/node_modules ./packages/data-access/node_modules
COPY --from=dependencies --chown=node:node /app/packages/documents/node_modules ./packages/documents/node_modules
COPY --from=build --chown=node:node /app/packages/documents/dist ./packages/documents/dist
COPY --from=build --chown=node:node /app/packages/documents/package.json ./packages/documents/
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build --chown=node:node /app/packages/data-access/dist ./packages/data-access/dist
COPY --from=build --chown=node:node /app/packages/data-access/package.json ./packages/data-access/
USER node
CMD ["node", "apps/worker/dist/index.js"]
