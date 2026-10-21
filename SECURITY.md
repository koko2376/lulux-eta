# Security Policy / 安全策略

[中文](#中文) · [English](#english)

## 中文

### 支持的版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| 0.2.x（最新） | ✅ |
| 0.1.x 及更早 | ❌ 存在已知严重漏洞（本地 API 无鉴权），请立即升级 |

在 1.0 之前，只有最新的次版本会收到安全修复。

### 私密报告漏洞

**请不要在公开 Issue、Discussion 或 PR 里披露漏洞细节。**

1. 首选：在本仓库 GitHub 页面 **Security → Report a vulnerability**（GitHub 私密漏洞报告）提交。
2. 备用：发邮件至 **`kokozenshii0308@gmail.com`**，标题以 `[LULUX ETA SECURITY]` 开头。

请尽量提供：受影响版本与平台（Windows / macOS / Linux，桌面端或浏览器开发态）、复现步骤或 PoC、影响评估，以及你希望在致谢中使用的署名。

我们的处理承诺（个人维护项目，尽力而为）：

| 阶段 | 目标时间 |
| --- | --- |
| 确认收到 | 3 个工作日内 |
| 初步评估与严重度定级 | 10 个工作日内 |
| 修复发布 | 严重 / 高危 30 天内，其余随下一个版本 |
| 公开披露 | 修复发布后，与报告者协商时间（默认 90 天上限） |

我们不提供漏洞赏金，但会在 Release notes 和 Security Advisory 中致谢（除非你希望匿名）。

### 安全模型简述

LULUX ETA 是**本地优先**的桌面应用：Electron 主进程在本机随机端口拉起一个 Koa 服务，界面通过 HTTP / SSE 访问它。

- **只监听回环地址**：服务默认绑定 `127.0.0.1`。不要把它绑定到 `0.0.0.0` 或通过反向代理暴露到局域网 / 公网；当前版本没有多用户账户隔离。
- **每次启动随机令牌**：主进程每次启动生成 32 字节随机 token，经环境变量传给服务、经 preload 暴露给界面。所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`，否则 401。
- **Host / Origin 校验（防 DNS Rebinding 与跨站请求）**：`Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`；若带 `Origin`，必须是服务自身 origin（开发态额外允许 Vite 开发服务器），否则 403。不返回任何 CORS 头，请求体只接受 `application/json`。
- **浏览器开发态**：未收到 token 时服务自行生成并写入 `<dataDir>/api-token`（权限 0600），由 Vite 开发代理注入请求头。
- **MCP 命令需人工确认**：新增或修改 MCP Server 的启动命令时，桌面端由主进程弹出原生确认框显示完整命令；开发态默认拒绝。
- **工具审批**：Agent 调用工具默认需要在对话里逐次允许；外部内容（网页、文件、模型输出）一律视为不可信。
- **产物预览隔离**：模型生成的 HTML / SVG 在 sandbox iframe 中预览，不能访问本地 API。
- **本机锁（可选）**：可设置 4–12 位 PIN（scrypt 哈希存储）。它防止旁人随手打开界面，**不是**数据加密。
- **密钥存储**：API Key 存在本机数据目录（`~/.lulux-eta` 或 `LULUX_ETA_HOME`），API 只返回掩码预览、不返回明文。请保护好数据目录与备份文件。
- **第三方内核**：Claude Code 等内核由你的电脑从 npm 公共源下载并以你的用户权限运行；它们的行为与安全性由各自厂商负责。

架构与部署模式（本机模式、服务器模式）见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

### 范围

范围内：本仓库代码、官方 Release 安装包。
范围外：第三方内核与模型服务本身的漏洞（请报告给对应厂商）、需要攻击者已在本机拥有用户权限的攻击、社会工程、拒绝服务压力测试。

---

## English

### Supported versions

| Version | Security fixes |
| --- | --- |
| 0.2.x (latest) | ✅ |
| 0.1.x and earlier | ❌ Known critical issue (unauthenticated local API). Upgrade now. |

Before 1.0, only the latest minor release receives security fixes.

### Reporting a vulnerability privately

**Do not disclose vulnerability details in public issues, discussions, or pull requests.**

1. Preferred: use **Security → Report a vulnerability** on this repository (GitHub private vulnerability reporting).
2. Fallback: email **`kokozenshii0308@gmail.com`** with a subject starting with `[LULUX ETA SECURITY]`.

Please include the affected version and platform, reproduction steps or a PoC, your impact assessment, and how you would like to be credited.

Targets (best effort, single-maintainer project): acknowledgement within 3 business days; triage within 10 business days; fix within 30 days for critical/high severity; coordinated disclosure after the fix (90 days maximum by default). There is no bug bounty; reporters are credited in release notes and advisories unless they prefer to stay anonymous.

### Security model (summary)

LULUX ETA is a local-first desktop app. The Electron main process starts a Koa server on a random loopback port, and the UI talks to it over HTTP/SSE.

- **Loopback only.** The server binds to `127.0.0.1` by default. Do not expose it on `0.0.0.0` or behind a reverse proxy; there is no multi-user isolation yet.
- **Per-launch random token.** Every `/api/*` request requires `Authorization: Bearer <token>` (32 random bytes generated per launch), otherwise 401.
- **Host/Origin checks** against DNS rebinding and cross-site requests; no CORS headers; JSON-only request bodies.
- **Browser dev mode** stores a generated token in `<dataDir>/api-token` (mode 0600) and the Vite dev proxy injects it.
- **MCP launch commands** require a native confirmation dialog in the desktop app and are refused by default in dev mode.
- **Tool approval** is on by default; external content is treated as untrusted.
- **Artifact previews** run in a sandboxed iframe that cannot reach the local API.
- **Optional local lock** (4–12 digit PIN, scrypt-hashed) deters casual access; it is not encryption.
- **API keys** are stored in the local data directory and are never returned in plaintext by the API. Protect your data directory and backups.
- **Third-party kernels** (Claude Code, etc.) are downloaded from public npm registries by your machine and run with your user privileges; their vendors are responsible for them.

### Scope

In scope: code in this repository and official release installers. Out of scope: vulnerabilities in third-party kernels or model services (report to their vendors), attacks requiring existing local user access, social engineering, and volumetric DoS.
