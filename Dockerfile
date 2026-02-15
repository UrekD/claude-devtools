# =============================================================================
# claude-devtools Docker image (web deployment)
#
# Multi-stage build:
#   1. Build stage: install deps + build client SPA
#   2. Runtime stage: minimal Node.js image with built artifacts
#
# Usage:
#   docker build -t claude-devtools .
#   docker run -p 3456:3456 -v ~/.claude:/home/node/.claude:ro claude-devtools
#
# Or with docker-compose:
#   docker compose up
# =============================================================================

# --- Build stage ---
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.25.0 --activate

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml* ./

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Copy source code and configs
COPY tsconfig.json vite.web.config.ts tailwind.config.js postcss.config.cjs ./
COPY src/ src/

# Build the client SPA using the web vite config
RUN npx vite build --config vite.web.config.ts

# --- Runtime stage ---
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@10.25.0 --activate

# Create non-root user's directories
RUN mkdir -p /home/node/.claude /home/node/data && chown -R node:node /home/node/.claude /home/node/data

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod

# Copy built client from builder stage
COPY --from=builder /app/dist/client ./dist/client

# Copy server source (runs via tsx at runtime)
COPY tsconfig.json ./
COPY src/main/ src/main/
COPY src/shared/ src/shared/

# Install tsx for running TypeScript directly
RUN pnpm add tsx

# Environment
ENV NODE_ENV=production
ENV PORT=3456
ENV HOST=0.0.0.0
ENV CLAUDE_ROOT=/home/node/.claude
# Writable directories for config/notifications (separate from read-only .claude mount)
ENV CONFIG_DIR=/home/node/data
ENV NOTIFICATIONS_DIR=/home/node/data

# Switch to non-root user
USER node

EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3456/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node_modules/.bin/tsx", "src/main/server.ts"]
