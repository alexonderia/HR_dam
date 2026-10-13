FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY apps/worker/package.json ./apps/worker/
COPY apps/ranker/package.json ./apps/ranker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/documents/package.json ./packages/documents/
COPY packages/data-access/package.json ./packages/data-access/
RUN --mount=type=cache,id=hr-dam-npm,target=/root/.npm,sharing=locked npm ci --workspace=@hr/frontend --workspace=@hr/contracts --include-workspace-root --fetch-timeout=30000 --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/frontend ./apps/frontend
COPY public ./public
RUN npm run build -w @hr/contracts && npm run build -w @hr/frontend

FROM nginx:stable-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
