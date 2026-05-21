FROM node:20-alpine AS base
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ─── deps ──────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY services/api/package.json services/api/
COPY packages/shared/package.json packages/shared/
COPY packages/ai-core/package.json packages/ai-core/
RUN pnpm install --frozen-lockfile

# ─── build ─────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ai-core packages/ai-core
COPY services/api services/api
RUN pnpm --filter @grace/api build

# ─── runtime ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages packages
COPY --from=build /repo/services/api/package.json services/api/package.json
COPY --from=build /repo/services/api/dist services/api/dist
RUN pnpm install --prod --frozen-lockfile=false
EXPOSE 3001
CMD ["node", "services/api/dist/server.js"]
