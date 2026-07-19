# waves · server image
#
# Multi-stage: the client is built with the full toolchain, then only the built assets
# and the server's runtime dependencies are carried into the final image.
#
# Note this is a glibc image, not Alpine. TensorFlow.js's WASM backend ships prebuilt
# binaries that expect glibc; on musl they fail to load at runtime, which would take out
# the mouth-opening signal and nothing else — a failure that is easy to miss until a
# recording quietly comes back without it.

# --------------------------------------------------------------------------- #
# 1. build the dashboard
# --------------------------------------------------------------------------- #
FROM oven/bun:1.3 AS client

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY client/ ./client/
# tsconfig.json references the server project too, and vite resolves the whole reference
# graph — a missing referenced tsconfig fails the build.
COPY tsconfig.json tsconfig.node.json tsconfig.server.json ./
RUN bun run build          # → /app/dist

# --------------------------------------------------------------------------- #
# 2. server dependencies only
# --------------------------------------------------------------------------- #
FROM oven/bun:1.3 AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    # 180 MB of native TFJS bindings that nothing imports: @vladmandic/human declares
    # tfjs-node as a peer, so it is installed automatically, but we deliberately run the
    # WASM backend instead (it needs no native addon). Dropping it here keeps the image
    # small and stops the runtime from ever resolving the native build by accident.
    && rm -rf node_modules/@tensorflow/tfjs-node

# --------------------------------------------------------------------------- #
# 3. runtime
# --------------------------------------------------------------------------- #
FROM oven/bun:1.3 AS runtime

WORKDIR /app
ENV NODE_ENV=production
# Recordings and the SQLite database live on a mounted volume, not in the image layer.
ENV WAVES_DATA_DIR=/data

COPY --from=deps   /app/node_modules ./node_modules
COPY --from=client /app/dist         ./dist
COPY package.json ./
COPY server/ ./server/

# The face-mesh models are vendored (≈2 MB) rather than fetched at boot: a container that
# needs a CDN to be reachable before it can process video is a container that breaks when
# the CDN is not.
# (server/models is copied as part of server/ above.)

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000
ENV PORT=8000

# The server refuses to boot in production without WAVES_INGEST_TOKEN — see server/auth.ts.
# Set it as a secret, never in this file.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e "await fetch('http://localhost:8000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "server/index.ts"]
