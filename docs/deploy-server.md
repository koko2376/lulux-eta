# LULUX ETA 团队服务器部署（Docker）

团队服务器就是同一套服务端以 `LULUX_MODE=server` 运行：账号密码登录、RBAC、审计日志，桌面端用“连接团队服务器”接入（契约第 5 节）。
镜像只包含服务端与 Web 界面，不含 Electron；第三方内核与 MCP 在服务器模式下默认禁用（仅 owner 可开启，见契约 5.8）。

> 不想从源码构建？每个 Release 都附带 `lulux-eta-server-<版本>.tar.gz`（已编译服务端 + 网页界面 + 生产依赖，内附 `README-server.md`，可 `docker compose up -d` 或 `./start-server.sh` 直接运行），并发布镜像 `ghcr.io/koko2376/lulux-eta:<版本>` / `:latest`。下面的步骤以源码目录里 `docker compose up -d --build` 为例。

## 1. 准备

- 一台能运行 Docker 24+ / Docker Compose v2 的 Linux 服务器（x86-64 或 ARM64），1 vCPU / 1 GB 内存起步。
- 一个域名（例如 `lulux.example.com`）解析到服务器。**必须**经 HTTPS 反向代理对外：服务端只认 `LULUX_PUBLIC_ORIGIN` 白名单里的 Host / Origin。

```bash
git clone <仓库地址> lulux && cd lulux
cp deploy/env.example .env
# 编辑 .env：
#   LULUX_PUBLIC_ORIGIN=https://lulux.example.com   （必填，多个用逗号分隔）
#   LULUX_DOMAIN=lulux.example.com                  （使用内置 Caddy 时）
#   LULUX_MASTER_KEY=$(openssl rand -hex 32)        （可选，见第 5 节）
```

## 2. 启动

两种方式任选：

```bash
# A. 内置 Caddy（自动申请 Let's Encrypt 证书，开放 80/443）
docker compose --profile caddy up -d --build

# B. 只起服务（监听 127.0.0.1:51789），用你自己的 Nginx / Caddy 反代
docker compose up -d --build
#   Nginx 示例：deploy/nginx.conf.example（注意 proxy_buffering off，SSE 需要）
```

健康检查：容器内置 `HEALTHCHECK`（`GET /api/auth/mode`），`docker compose ps` 显示 `healthy` 即就绪。

```bash
curl -s http://127.0.0.1:51789/api/auth/mode
# {"mode":"server","setupRequired":true,"version":"…","publicOrigin":"https://lulux.example.com"}
```

## 3. 创建第一个管理员（owner）

任选其一：

```bash
# CLI（推荐）
docker compose exec lulux node dist/cli.js create-owner \
  --email admin@example.com --password '强密码' --name 'Koko' --org '某某外贸'

# 或：用首次启动日志里的一次性 setup token 在网页上初始化
docker compose logs lulux | grep 'SETUP TOKEN'
```

之后打开 `https://lulux.example.com` 登录，在“团队与权限”里邀请成员（一次性邀请码 / 链接）。忘记密码：

```bash
docker compose exec lulux node dist/cli.js reset-password --email admin@example.com --password '新密码'
```

## 4. 镜像与容器的安全设置

- 多阶段构建，运行时基于 `node:22-bookworm-slim`，以 `node`（uid 1000）非 root 运行，只读根文件系统（`read_only: true`，`/tmp` 为 tmpfs），`cap_drop: ALL`、`no-new-privileges`。
- 数据全部在卷 `lulux-data`（容器内 `/data`）。端口只绑定宿主 `127.0.0.1:51789`，对外只经反向代理。
- 报价单 PDF 的中文字体使用文泉驿微米黑（`fonts-wqy-microhei`，约 5 MB）；不需要可 `docker compose build --build-arg CJK_FONTS=0`。

## 5. 主密钥与备份

邮箱密码、API Key 等字段用主密钥加密：
- 设置了 `LULUX_MASTER_KEY`（64 位 hex）时使用它，**请把它和备份分开妥善保存**；
- 未设置时在数据卷里生成 `/data/master.key`（0600），备份数据卷时它会一起被备份。

备份 / 恢复：

```bash
docker compose stop lulux
docker run --rm -v lulux_lulux-data:/data -v "$PWD":/backup busybox tar czf /backup/lulux-data-$(date +%F).tgz -C /data .
docker compose start lulux
# 恢复：停服务 → 清空卷 → tar xzf 回 /data → 启动
```

（卷名前缀取决于 compose 项目名，`docker volume ls | grep lulux-data` 查看。）

## 6. 升级

```bash
git pull
docker compose up -d --build     # 数据库迁移在启动时自动执行
```

## 7. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LULUX_PUBLIC_ORIGIN` | —（必填） | 对外 https 地址白名单，逗号分隔 |
| `LULUX_MASTER_KEY` | 空 | 64 位 hex 主密钥；空则使用 `/data/master.key` |
| `LULUX_TRUST_PROXY` | `1` | 信任的反代层数：客户端 IP 取 `X-Forwarded-For` 里这几层代理之前的那一跳（限流与审计用；`1` = 一层反代，取最右值；不取客户端可伪造的最左值） |
| `LULUX_TRUSTED_PROXIES` | 空 | 可信反代地址（IP 或 CIDR，逗号分隔）；设置后从右往左跳过这些地址，取第一个不可信地址，优先于层数 |
| `LULUX_EMAIL_ALLOW_PRIVATE_HOSTS` | 空 | 团队服务器默认拒绝把邮箱 IMAP/SMTP 连到本机 / 内网 / 链路本地地址；确需连接内网邮件服务器时在这里列出主机名或 IP（逗号分隔） |
| `LULUX_SESSION_IDLE_HOURS` | `168` | 会话空闲过期（小时） |
| `LULUX_SESSION_MAX_DAYS` | `30` | 会话最长有效期（天） |
| `LULUX_ALLOW_DESKTOP_ORIGINS` | `1` | 允许桌面端本机界面（`http://127.0.0.1:*`）跨源访问；设 `0` 关闭 |
| `LULUX_ETA_HOME` / `LULUX_ETA_HOST` / `LULUX_ETA_PORT` | `/data` / `0.0.0.0` / `51789` | 镜像内已设置，一般不改 |
