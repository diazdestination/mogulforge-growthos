# syntax=docker/dockerfile:1
# MogulForge — single production container.
# Builds the SPA and the API, then the API serves BOTH (SPA static + /api) on
# one origin/port. One image, one URL → trivial to host anywhere (Fly, Render,
# Railway, a VPS) with instant HTTPS.

FROM node:22-slim AS base
# Pin pnpm to the version verified locally (newer pnpm hard-errors on the
# ignored esbuild build script).
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
# --ignore-scripts: platform binaries (esbuild/rollup/tailwind-oxide/lightningcss)
# come from optional deps, not build scripts, so skipping scripts avoids the
# ERR_PNPM_IGNORED_BUILDS hard error while still producing working binaries.
RUN pnpm install --no-frozen-lockfile --ignore-scripts
# Explicit production defaults; the Vite config also has portable local
# defaults so ordinary builds no longer depend on platform-injected variables.
ENV NODE_ENV=production PORT=3001 BASE_PATH=/
RUN pnpm --filter @workspace/command-center run build
RUN pnpm --filter @workspace/api-server run build

FROM base AS runtime
ENV NODE_ENV=production STATIC_DIR=/app/public PORT=3001
# Built workspace (dist + node_modules for externalized packages: zod, @resvg, pg).
COPY --from=build /app /app
# Stage the SPA where the API serves it (STATIC_DIR).
RUN cp -r /app/artifacts/command-center/dist/public /app/public
WORKDIR /app/artifacts/api-server
EXPOSE 3001
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
