# syntax=docker/dockerfile:1

# The build context is the repository root, not server/, because the server resolves
# @scanner-demo/shared through the pnpm workspace - ADR-14.

# ---------------------------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------------------------
FROM node:22-slim AS build

# husky's `prepare` script runs on install and there is no git repository in a build context.
# HUSKY=0 is the documented way to skip it rather than to make it fail quietly.
ENV HUSKY=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN corepack enable

WORKDIR /app

# Manifests first, so a source change does not invalidate the dependency layer. Every workspace
# manifest is needed: pnpm refuses to install against a lockfile it cannot fully account for.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY app/package.json app/

# better-sqlite3 is pinned to 12.x on purpose: 12.x publishes a prebuilt binding for Node 22's ABI
# (node-v127-linux-x64) and 13.0.1 publishes none at all, so 13 falls back to compiling SQLite from
# source. That needs python3 and a toolchain in the image, and it puts a multi-minute g++ run with a
# real memory spike on a two-core box that has no swap and a live Postgres on it - ADR-18. If a
# later 13.x starts shipping prebuilds, this can move forward.
RUN pnpm install --frozen-lockfile --filter @scanner-demo/server...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY server server

# The shared package is built first: the server typechecks and imports it through its dist output.
RUN pnpm --filter @scanner-demo/shared build \
    && pnpm --filter @scanner-demo/server build

# A pruned tree with production dependencies only, and @scanner-demo/shared copied in as a real
# directory rather than a workspace symlink that would dangle in the runtime image.
RUN pnpm --filter @scanner-demo/server --prod --legacy deploy /out

# ---------------------------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /out ./

# Created here, owned by `node` (UID 1000), so the named volumes mounted over them inherit that
# ownership. Docker seeds an empty named volume from the image's directory, ownership included -
# get this wrong and the server cannot write to its own image store. Phase 07 mounts
# /data/images read-only into the OCR sidecar, which is why the UID is decided here and recorded
# in deploy/README.md rather than discovered later.
RUN mkdir -p /data/images /data/thumbs /data/db && chown -R node:node /data

USER node

EXPOSE 3002

# Bound to 0.0.0.0 *inside* the container. Reaching it from outside the box is prevented by the
# port publication in docker-compose.yml, which binds to 127.0.0.1 on the host - ADR-17.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/api/v1/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
