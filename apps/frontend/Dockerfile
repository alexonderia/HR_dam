FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY .npmrc ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY apps/worker/package.json ./apps/worker/
COPY apps/auth-check/package.json ./apps/auth-check/
COPY apps/guest-api/package.json ./apps/guest-api/
COPY packages/security/package.json ./packages/security/
COPY packages/processing/package.json ./packages/processing/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/documents/package.json ./packages/documents/
COPY packages/data-access/package.json ./packages/data-access/
RUN --mount=type=cache,id=hr-dam-npm-frontend,target=/root/.npm,sharing=locked npm ci --workspace=@hr/frontend --workspace=@hr/contracts --include-workspace-root --include=optional --ignore-scripts --no-audit --no-fund --prefer-offline --fetch-timeout=15000 --fetch-retries=1
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/frontend ./apps/frontend
RUN npm run build -w @hr/contracts && npm run build -w @hr/frontend

FROM nginx:stable-alpine AS runtime
RUN nginx -V 2>&1 | grep -q -- --with-http_auth_request_module
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/frontend/api-proxy.conf /etc/nginx/api-proxy.conf
RUN nginx -t
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
