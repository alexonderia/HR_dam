FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json .npmrc ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/worker/package.json ./apps/worker/
COPY apps/auth-check ./apps/auth-check
COPY apps/guest-api ./apps/guest-api
RUN --mount=type=cache,target=/root/.npm npm ci --include=optional --ignore-scripts --no-audit --no-fund --prefer-offline --fetch-timeout=15000 --fetch-retries=1
RUN npm run build:packages
ARG SERVICE
RUN npm run build -w @hr/${SERVICE}

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ARG SERVICE
COPY package*.json .npmrc ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/worker/package.json ./apps/worker/
COPY apps/auth-check/package.json ./apps/auth-check/
COPY apps/guest-api/package.json ./apps/guest-api/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/security/package.json ./packages/security/
COPY packages/processing/package.json ./packages/processing/
COPY packages/documents/package.json ./packages/documents/
COPY packages/data-access/package.json ./packages/data-access/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace=@hr/${SERVICE} --include-workspace-root --ignore-scripts --no-audit --no-fund

FROM build AS artifacts
ARG SERVICE
RUN mkdir -p /runtime/apps/${SERVICE} /runtime/packages && \
    cp -a apps/${SERVICE}/dist apps/${SERVICE}/package.json /runtime/apps/${SERVICE}/ && \
    case "$SERVICE" in auth-check) packages="security";; guest-api) packages="contracts security processing documents";; backend) packages="contracts security processing documents data-access";; esac && \
    for package in $packages; do mkdir -p /runtime/packages/$package; cp -a packages/$package/dist packages/$package/package.json /runtime/packages/$package/; done

FROM node:24-bookworm-slim AS runtime
ARG SERVICE
ENV NODE_ENV=production HR_SERVICE=${SERVICE}
WORKDIR /app
COPY --from=dependencies --chown=node:node /app ./
COPY --from=artifacts --chown=node:node /runtime ./
RUN mkdir -p /var/lib/hr-dam/resume-spool && chown node:node /var/lib/hr-dam/resume-spool
USER node
CMD ["sh", "-c", "exec node apps/$HR_SERVICE/dist/index.js"]
