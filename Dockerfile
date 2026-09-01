# ==============================================================================
# Multi-stage Dockerfile for DeepSeek Harness (Custom Fork + Playwright Search)
# ==============================================================================

# ── Stage 1: Build DSH and Plugins from Source ──────────────────────────────
FROM node:24-bookworm-slim AS builder

ARG DSH_REPO=https://github.com/src-one/deepseek-harness.git
ARG DSH_BRANCH=master

ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g --no-audit --no-fund pnpm

# Build DeepSeek Harness from source
WORKDIR /dsh-src
RUN git clone --depth 1 --branch ${DSH_BRANCH} ${DSH_REPO} . \
    && pnpm install \
    && pnpm run build:official \
    && mkdir -p /dist/vendor /dist/dsh \
    && pnpm exec tsx scripts/release/pack.ts --family vendor --out /dist/vendor \
    && pnpm exec tsx scripts/release/pack.ts --family dsh --out /dist/dsh

# Build Playwright Google Web Search Plugin
WORKDIR /plugin-src
COPY plugins/dsh-web-search-playwright/ /plugin-src/
RUN pnpm install \
    && pnpm run build \
    && mkdir -p /opt/plugins/dsh-web-search-playwright \
    && cp -r /plugin-src/* /opt/plugins/dsh-web-search-playwright/ \
    && rm -rf /opt/plugins/dsh-web-search-playwright/node_modules \
    && cd /opt/plugins/dsh-web-search-playwright && pnpm install --prod

# ── Stage 2: Production Runtime ─────────────────────────────────────────────
FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="DeepSeek Harness (ZimaOS / CasaOS Compatible)" \
      org.opencontainers.image.description="DeepSeek Harness with Selectable Model Modes and Playwright Google Search" \
      org.opencontainers.image.source="https://github.com/src-one/deepseek-harness-docker" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production \
    DSH_PORT=3079 \
    PROXY_PORT=3080 \
    DSH_HOME=/root/.dsh \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Install system dependencies, development tools, and Playwright Chromium requirements
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    nano \
    jq \
    procps \
    ca-certificates \
    unzip \
    vim \
    openssh-client \
    zip \
    htop \
    tmux \
    tree \
    openssl \
    python3 \
    make \
    g++ \
    build-essential \
    bash-completion \
    fontconfig \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm and uv
RUN npm install -g --no-audit --no-fund pnpm \
    && curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# Copy built artifacts from builder stage
COPY --from=builder /dist /dist
COPY --from=builder /opt/plugins/dsh-web-search-playwright /opt/plugins/dsh-web-search-playwright

# Install DSH and vendor tarballs globally
RUN npm install -g --no-audit --no-fund /dist/vendor/*.tgz /dist/dsh/*.tgz \
    && rm -rf /dist

# Install Playwright's Chromium browser to /opt/ms-playwright
RUN pnpm --dir /opt/plugins/dsh-web-search-playwright exec playwright install chromium

# Pre-populate default web profile template with playwright plugin enabled
RUN dsh plugin --profile web add /opt/plugins/dsh-web-search-playwright \
    && mkdir -p /opt/dsh/default-profile \
    && cp -r /root/.dsh/profiles/web /opt/dsh/default-profile/

# Setup reverse proxy
COPY proxy/ /app/proxy/
RUN cd /app/proxy && npm install --omit=dev --no-audit --no-fund

# Copy helper scripts
COPY register-workspace.js /app/register-workspace.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/register-workspace.js

# Expose reverse proxy port
EXPOSE 3080

ENTRYPOINT ["/app/entrypoint.sh"]
