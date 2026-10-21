# syntax=docker/dockerfile:1
# LULUX ETA 团队服务器镜像（LULUX_MODE=server）。多阶段构建，运行时非 root。
# 构建：docker build -t lulux-eta-server .
# 部署说明见 docs/deploy-server.md

# ── 1. 构建：安装全部依赖，编译 server 与 client ─────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/desktop/package.json packages/desktop/
# --ignore-scripts：不下载 Electron 二进制（镜像里用不到）
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY packages/server packages/server
COPY packages/client packages/client
RUN npm run build -w @lulux/server && npm run build -w @lulux/client

# ── 2. 生产依赖：只装 server 的运行时依赖 ───────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/desktop/package.json packages/desktop/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @lulux/server

# ── 3. 运行时 ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# 报价单 PDF 的中文字体（文泉驿微米黑，GPLv3 + 字体例外，约 5 MB）；不需要中文 PDF 可用 --build-arg CJK_FONTS=0 去掉
ARG CJK_FONTS=1
# hadolint ignore=DL3008
RUN if [ "$CJK_FONTS" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends fonts-wqy-microhei && rm -rf /var/lib/apt/lists/*; \
    fi \
 && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    LULUX_MODE=server \
    LULUX_ETA_HOME=/data \
    LULUX_ETA_HOST=0.0.0.0 \
    LULUX_ETA_PORT=51789 \
    LULUX_ETA_CLIENT_DIST=/app/client \
    LULUX_TRUST_PROXY=1 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app/server
COPY --from=deps --chown=root:root /src/node_modules /app/node_modules
COPY --from=build --chown=root:root /src/packages/server/package.json /app/server/package.json
COPY --from=build --chown=root:root /src/packages/server/dist /app/server/dist
COPY --from=build --chown=root:root /src/packages/client/dist /app/client
# 内置 skill（只读；启动时同步到 /data/skills，见 services/skills/paths.ts）
COPY --chown=root:root packages/server/skills /app/server/skills
COPY --chown=root:root LICENSE NOTICE /app/

USER node
VOLUME ["/data"]
EXPOSE 51789
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:51789/api/auth/mode').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
