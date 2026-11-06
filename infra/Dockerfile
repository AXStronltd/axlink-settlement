# syntax=docker/dockerfile:1
#
# AxLink Settlement — production image.
#
# Changes from the previous version:
#   - Build context is the repository root: `docker build -f infra/Dockerfile .`
#   - Runs as a non-root user. The container mounts a Fireblocks signing key;
#     running the process as root is not a defensible configuration for
#     something that can move customer funds.
#   - A real HEALTHCHECK, so an orchestrator can tell "listening" from "healthy".
#   - `npm ci --omit=dev` in the runtime stage copies the generated Prisma
#     client explicitly, because `npm ci` wipes node_modules and would
#     otherwise delete it.

# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY apps/api ./apps/api
COPY packages ./packages
COPY openapi ./openapi

RUN npx prisma generate
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

# wget is used by the healthcheck; openssl is required by the Prisma engines.
RUN apk add --no-cache wget openssl

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/openapi ./openapi
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# The generated client must be copied AFTER `npm ci`, which empties
# node_modules — copying it before means shipping an image without it.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY scripts/write-fireblocks-key.sh /app/scripts/write-fireblocks-key.sh
RUN chmod +x /app/scripts/write-fireblocks-key.sh

# apps/api/public/ is deliberately NOT copied. It holds console.html, the local
# operator console, which exists to drive stubbed payment rails. The image is
# what runs in production, and the console has no business being in it —
# SIMULATOR_ENABLED already gates the routes, but not shipping the page at all
# is the stronger guarantee.

# Fireblocks signing key is mounted at runtime, never baked into the image:
#   -v /secure/fireblocks_secret.key:/app/secrets/fireblocks_secret.key:ro
# and set FIREBLOCKS_SECRET_KEY_PATH=/app/secrets/fireblocks_secret.key
RUN mkdir -p /app/secrets && chown -R node:node /app

USER node

EXPOSE 4000

# Distinguishes a process that is listening from one that can serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:${PORT}/api/health || exit 1

# The Fireblocks signing key arrives as base64 in an env var (App Platform has
# no file mounts) and is written to disk before the process starts.
CMD ["sh", "-c", "/app/scripts/write-fireblocks-key.sh && npx prisma migrate deploy && exec node dist/apps/api/src/index.js"]
