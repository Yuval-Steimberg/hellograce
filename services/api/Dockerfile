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
 && cd services/api && npx tsc -p tsconfig.auto-eval.json \
 && npx tsc -p tsconfig.coverage.json

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
COPY --from=build /repo/services/api/dist-coverage/coverage services/api/coverage
# Data assets (intents.json + safety-framework.json + journey-map.json) must
# be present at runtime — they're not compiled, just read by the runner.
COPY --from=build /repo/services/api/coverage/intents.json services/api/coverage/intents.json
COPY --from=build /repo/services/api/coverage/safety-framework.json services/api/coverage/safety-framework.json
COPY --from=build /repo/services/api/coverage/journey-map.json services/api/coverage/journey-map.json
RUN pnpm install --prod --frozen-lockfile
# auto-eval modules import from ../src/llm — symlink src→dist so paths resolve
RUN ln -s dist services/api/src
# Create results directories for auto-eval + coverage output
RUN mkdir -p services/api/auto-eval/results services/api/coverage/results
# Build/version marker — pass at deploy time with:
#   fly deploy --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)
# Surfaced at GET /health so you can confirm the running code == the code you
# deployed. Placed at the very end so changing it never busts earlier layers.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
EXPOSE 3001
CMD ["node", "services/api/dist/server.js"]
