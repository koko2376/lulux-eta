# LULUX ETA v0.1.1 — 首个公开版本 / First public release

> **源码可用（Source-available）· Business Source License 1.1**
> 个人与组织可免费在生产环境中使用（含内部修改）；不得收费分发、再许可或作为收费托管服务提供。每个版本在 Change Date（本版本 2030-10-20）转为 Apache-2.0。详见 [LICENSE](https://github.com/koko2376/lulux-eta/blob/main/LICENSE)。

LULUX ETA 是面向外贸团队的本地优先 AI Agent 桌面工作台。客户、报价、询盘规则与 AI 对话都保存在你自己的电脑上，只有模型请求会发往你自己配置的模型服务。

## ✨ 亮点

- **外贸业务真正可用**：客户与联系人、CSV / Excel 导入去重、产品库、报价单（贸易术语 / 多币种 / PDF 导出）、报价模板、询盘判定规则、工作台统计。
- **内核管理**：一键安装 / 更新 / 卸载 Claude Code、Codex CLI、Gemini CLI、Qwen Code 等第三方命令行 Agent（由你的电脑从 npm 公共源下载，不随本软件分发）。
- **诚实的 Agent**：LULUX 自有角色由你配置的模型驱动，每条回复都标明实际运行者（模型或内核及版本）。
- **备份与恢复**：导出 JSON；导入前自动留本地快照。
- **本机锁**：可选 PIN 解锁，替代此前的演示登录页。

## 🔒 安全（0.1.x 用户请务必升级）

修复了严重问题：旧版本地 API 无鉴权且允许任意跨域，**任意网页都可能借此在你的电脑上启动进程**。现在：

- 每次启动生成随机令牌，所有 API 请求都必须携带；
- 校验 Host / Origin，移除 CORS，防 DNS Rebinding；
- 新增或修改 MCP 启动命令需原生弹窗确认；
- 设置项白名单、API 不再返回明文 API Key、产物预览禁止联网；
- Electron 升级到受支持版本。

## 🗓 即将推出

邮箱收发（IMAP / SMTP / OAuth）· 团队与权限 · 远程服务器登录（界面中显示“即将推出”，当前不可用）

## 📦 下载

| 平台 | 文件 |
| --- | --- |
| Windows 10/11 x64 | `LULUX-ETA-0.1.1-win-x64-setup.exe` |
| macOS（Apple Silicon / Intel） | `LULUX-ETA-0.1.1-mac-arm64.dmg` / `LULUX-ETA-0.1.1-mac-x64.dmg` |
| Linux x64 / arm64 | `LULUX-ETA-0.1.1-linux-x86_64.AppImage` / `LULUX-ETA-0.1.1-linux-arm64.AppImage` |
| 团队服务器（自建） | `lulux-eta-server-v0.1.1.tar.gz`：已编译服务端 + 网页界面 + 生产依赖 + Dockerfile / docker-compose / 部署配置，内附 `README-server.md`（Node.js 22.13+ 或 Docker） |
| 团队服务器 Docker 镜像 | `docker pull ghcr.io/koko2376/lulux-eta:0.1.1`（或 `:latest`，linux/amd64 + arm64） |

校验和见 `SHA256SUMS.txt`（含服务器包）。若安装包未签名，系统可能提示风险，请确认下载自本仓库 Releases。团队服务器部署见 [docs/deploy-server.md](https://github.com/koko2376/lulux-eta/blob/main/docs/deploy-server.md)。

## ⚠️ 升级说明

- 0.1.x 的本地数据目录（`~/.lulux-eta`）可继续使用；升级前建议先在「设置 → 数据与备份」导出一份备份。
- 旧版内置角色已改为 LULUX 自有名称与头像，旧会话里的角色显示会随之变化（具体映射以服务端迁移实现为准）。
- 如果你在浏览器里通过 `curl` 或脚本直接调用过本地 API，现在需要携带 token（见 `docs/API-CONTRACT.md`）。

---

## English

LULUX ETA is a local-first AI agent desktop workspace for foreign-trade teams. **Source-available under BSL 1.1**: free production use for individuals and organizations (including internal modifications); no paid distribution, sublicensing, or paid hosted services. Converts to Apache-2.0 on 2030-10-20.

**Highlights** — real customer management and CSV/Excel import, product catalogue, quotations with Incoterms / multi-currency / PDF export, quotation templates, inquiry rules, live workbench; kernel manager for third-party CLI agents (downloaded from public npm registries, not bundled); every reply shows the actual runtime; backup & restore with automatic snapshots; optional PIN lock.

**Security (please upgrade from 0.1.x)** — fixed a critical issue where any website could drive the unauthenticated local API (CORS `*`) and launch processes. The API now requires a per-launch token, validates Host/Origin, drops CORS, requires native confirmation for MCP commands, whitelists settings, never returns API keys, and isolates artifact previews. Electron upgraded.

**Coming soon** — Mailbox (IMAP/SMTP/OAuth), teams & permissions, remote server sign-in.

**Downloads** — desktop installers for Windows x64, macOS (arm64 / x64) and Linux (x86_64 / arm64 AppImage); the self-hosted team server as `lulux-eta-server-v0.1.1.tar.gz` (compiled server + web UI + production dependencies + Dockerfile / docker-compose / deploy configs, with `README-server.md`; Node.js 22.13+ or Docker) and as a container image `ghcr.io/koko2376/lulux-eta:0.1.1` (also `:latest`, linux/amd64 + arm64). Verify downloads with `SHA256SUMS.txt`. Server deployment: [docs/deploy-server.md](https://github.com/koko2376/lulux-eta/blob/main/docs/deploy-server.md).

**Trademarks** — Claude, Codex, Gemini, Qwen and other names belong to their owners. LULUX ETA is not affiliated with Anthropic, OpenAI, Google or Alibaba Cloud.

Full changelog: [CHANGELOG.md](https://github.com/koko2376/lulux-eta/blob/main/CHANGELOG.md)
