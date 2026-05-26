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
RUN pnpm --filter @grace/shared build \
 && pnpm --filter @grace/ai-core build \
 && pnpm --filter @grace/api build \
 && cd services/api && npx tsc -p tsconfig.auto-eval.json

# ─── runtime ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml ./
COPY --from=build /repo/packages packages
COPY --from=build /repo/services/api/package.json services/api/package.json
COPY --from=build /repo/services/api/dist services/api/dist
COPY --from=build /repo/services/api/dist-auto-eval/auto-eval services/api/auto-eval
COPY --from=build /repo/services/api/dist-auto-eval/eval services/api/eval
RUN pnpm install --prod --frozen-lockfile
# auto-eval modules import from ../src/llm — symlink src→dist so paths resolve
RUN ln -s dist services/api/src
# Create results directory for auto-eval output
RUN mkdir -p services/api/auto-eval/results
EXPOSE 3001
CMD ["node", "services/api/dist/server.js"]
