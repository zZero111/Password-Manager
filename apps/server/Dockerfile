# Build from the repository root:  docker build -f apps/server/Dockerfile -t keyhold-server .
FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @pm/server...
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter @pm/server build

FROM node:22-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /src/apps/server/dist/server.js ./server.js
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
