# LULUX ETA 团队服务器 @TAG@ / Team server @TAG@

本包是 LULUX ETA 团队服务器（`LULUX_MODE=server`）的完整运行包：已编译的服务端、网页界面、生产依赖（`node_modules`）和部署配置，无需源码、无需编译。完整部署说明见仓库 `docs/deploy-server.md`。

This bundle is the complete LULUX ETA team server (`LULUX_MODE=server`): compiled server, web UI, production `node_modules` and deployment configs. No source checkout or build step needed. Full guide: `docs/deploy-server.md` in the repository.

## 要求 / Requirements

- Docker 24+ 与 Docker Compose v2；**或** Node.js **22.13+**（Node 22 LTS）。
  Docker 24+ with Compose v2, **or** Node.js **22.13+** (Node 22 LTS).
- 一个域名，经 **HTTPS 反向代理**对外（内置 Caddy，或 `deploy/nginx.conf.example`）。服务端只接受 `LULUX_PUBLIC_ORIGIN` 白名单里的 Host / Origin。
  A domain behind an **HTTPS reverse proxy** (bundled Caddy, or `deploy/nginx.conf.example`). The server only accepts Host/Origin values listed in `LULUX_PUBLIC_ORIGIN`.

## 环境变量 / Environment variables

| 变量 / Variable | 默认 / Default | 说明 / Meaning |
| --- | --- | --- |
| `LULUX_PUBLIC_ORIGIN` | —（必填 / required） | 对外 https 地址，逗号分隔 / public https origin(s), comma-separated |
| `LULUX_MASTER_KEY` | 空 / empty | 64 位 hex 主密钥（`openssl rand -hex 32`）；空则在数据目录生成 `master.key`，务必随备份保存 / 64-hex master key; if empty, `master.key` is generated in the data dir — back it up |
| `LULUX_TRUST_PROXY` | `1` | 信任反代的 `X-Forwarded-For` / trust the proxy's `X-Forwarded-For` |
| `LULUX_SESSION_IDLE_HOURS` | `168` | 会话空闲过期（小时）/ session idle timeout (hours) |
| `LULUX_SESSION_MAX_DAYS` | `30` | 会话最长有效期（天）/ max session lifetime (days) |
| `LULUX_ALLOW_DESKTOP_ORIGINS` | `1` | 允许桌面端本机界面访问；`0` 关闭 / allow the desktop app's local UI; `0` disables |
| `LULUX_DOMAIN` | — | 仅 `--profile caddy` 时需要 / only for `--profile caddy` |
| `LULUX_ETA_HOME` | `/data`（Docker）· `./data`（start-server.sh） | 数据目录 / data directory |
| `LULUX_ETA_HOST` / `LULUX_ETA_PORT` | `0.0.0.0`（Docker）· `127.0.0.1`（start-server.sh）/ `51789` | 监听地址与端口 / listen address and port |
| `LULUX_ETA_CLIENT_DIST` | `/app/client` · `./client` | 网页界面目录 / web UI directory |
| `LULUX_IMAGE` | `@IMAGE@` | docker-compose 使用的镜像 / image used by docker-compose |

镜像与 `start-server.sh` 已固定 `LULUX_MODE=server`、`NODE_ENV=production`。
The image and `start-server.sh` already set `LULUX_MODE=server` and `NODE_ENV=production`.

## 方式 A：Docker Compose / Option A: Docker Compose

```bash
tar xzf lulux-eta-server-@TAG@.tar.gz && cd lulux-eta-server-@TAG@
cp deploy/env.example .env        # 填写 / set LULUX_PUBLIC_ORIGIN（以及 LULUX_DOMAIN、LULUX_MASTER_KEY）

docker compose pull               # 拉取预构建镜像 / pull the prebuilt image: @IMAGE@
docker compose up -d              # 只起服务，监听 127.0.0.1:51789，用你自己的反代 / server only, behind your own proxy
# 或 / or: docker compose --profile caddy up -d   # 同时起内置 Caddy（自动 HTTPS，开放 80/443）

# 无法访问 ghcr.io 时，用本包自带的 Dockerfile 本地构建 / can't reach ghcr.io? build from this bundle:
# docker compose up -d --build
```

健康检查 / Health check:

```bash
curl -s http://127.0.0.1:51789/api/auth/mode
# {"mode":"server","setupRequired":true,...}
```

创建第一个管理员 / Create the first owner:

```bash
docker compose exec lulux node dist/cli.js create-owner \
  --email admin@example.com --password 'strong-password' --name 'Admin' --org 'My Company'
# 或用启动日志里的一次性 setup token 在网页上初始化 / or use the one-time setup token from the logs:
docker compose logs lulux | grep 'SETUP TOKEN'
```

## 方式 B：直接用 Node.js / Option B: plain Node.js

```bash
tar xzf lulux-eta-server-@TAG@.tar.gz && cd lulux-eta-server-@TAG@
LULUX_PUBLIC_ORIGIN=https://lulux.example.com ./start-server.sh
# 数据默认在 ./data，监听 127.0.0.1:51789；用 Nginx/Caddy 反代并配置 HTTPS（见 deploy/）
# Data goes to ./data, listening on 127.0.0.1:51789; put Nginx/Caddy with HTTPS in front (see deploy/).

# 创建管理员 / create the owner (same data dir as the running server):
cd server && LULUX_MODE=server LULUX_ETA_HOME=../data LULUX_PUBLIC_ORIGIN=https://lulux.example.com \
  node dist/cli.js create-owner --email admin@example.com --password 'strong-password' --name 'Admin' --org 'My Company'
```

等价的手动启动 / Equivalent manual start:

```bash
cd server
NODE_ENV=production LULUX_MODE=server LULUX_ETA_HOME=/var/lib/lulux LULUX_ETA_HOST=127.0.0.1 LULUX_ETA_PORT=51789 \
LULUX_ETA_CLIENT_DIST="$(cd ../client && pwd)" LULUX_TRUST_PROXY=1 LULUX_PUBLIC_ORIGIN=https://lulux.example.com \
node dist/index.js
```

建议用 systemd 等守护进程管理，并以非 root 用户运行。
Run it under systemd (or similar) as a non-root user.

## 升级与备份 / Upgrade & backup

- 升级：停服务 → 解压新版本 → 用同一个数据目录 / 数据卷启动；数据库迁移在启动时自动执行。
  Upgrade: stop → unpack the new version → start with the same data dir / volume; migrations run on start.
- 备份整个数据目录（含 `master.key`，除非你设置了 `LULUX_MASTER_KEY`）。
  Back up the whole data directory (including `master.key` unless you set `LULUX_MASTER_KEY`).

## 许可证 / License

Business Source License 1.1，见 `LICENSE`、`NOTICE`、`THIRD_PARTY_LICENSES.md`。
Business Source License 1.1 — see `LICENSE`, `NOTICE`, `THIRD_PARTY_LICENSES.md`.
