# syntax=docker/dockerfile:1
# LULUX ETA 团队服务器镜像 —— 由发布包（lulux-eta-server-<tag>.tar.gz）直接构建，不需要源码与编译。
# LULUX ETA team server image, built straight from the release bundle (no source checkout, no compile step).
#   docker build -t lulux-eta-server:local .      或 / or   docker compose up -d --build
# 与仓库根目录 Dockerfile 的运行时阶段一致 / Same runtime stage as the repository Dockerfile.
FROM node:22-bookworm-slim
# 报价单 PDF 的中文字体；不需要可用 --build-arg CJK_FONTS=0 去掉 / CJK font for quotation PDFs
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
COPY --chown=root:root node_modules /app/node_modules
COPY --chown=root:root server/package.json /app/server/package.json
COPY --chown=root:root server/dist /app/server/dist
COPY --chown=root:root server/skills /app/server/skills
COPY --chown=root:root client /app/client
COPY --chown=root:root LICENSE NOTICE /app/

USER node
VOLUME ["/data"]
EXPOSE 51789
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:51789/api/auth/mode').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
