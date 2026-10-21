# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each released version carries its own BSL Change Date (see `LICENSE`).

## [0.1.1] - 2026-10-21

First public, source-available release. 首个公开（源码可用）版本。

### Added

- **Built-in LULUX kernel** with streaming chat, reasoning display, tool calling, image input, regenerate / edit-and-resend, Markdown export and usage tracking.
- **Kernel manager**: install / update / uninstall third-party CLI agents (Claude Code, Codex CLI, Gemini CLI, Qwen Code, Grok, Hermes, Pi) into `<dataDir>/kernels/`; scoped mode routes them through your own providers via the local gateway. Kernels are downloaded by your machine from public npm registries and are not bundled.
- **Group chats** with a supervisor agent; on a team server, human colleagues can join the same group.
- **Server-side runs**: closing the window, reloading or switching sessions no longer stops an agent; reopening reattaches and replays progress. Only Stop cancels a run.
- **Permission levels** per chat — Read only / Ask for approval / Full access — applied to the built-in kernel and every CLI kernel; team admins can cap levels per role or member.
- **Model picker** next to the message box: per-chat model and reasoning effort.
- **Long-term memory** per account (Profile + Notes), saved by the agent on "remember …", strictly private; in group chats with other people it is used only if you turn on “Use my memory in group chats” (off by default).
- **Skills**: built-in skills, skill install / create, sandboxed skill scripts, and agent self-configuration of skills and MCP servers.
- **Workflows and schedules**: multi-agent DAG canvas, run history, cron-style scheduled prompts.
- **CRM**: customers, contacts, stages, tags, activity timeline, CSV/Excel import with de-duplication, tasks and reminders, deals and weighted pipeline, quotation → order → shipment → payment, receivables.
- **Products and quotations**: catalogue, Incoterms, multi-currency, templates, printable HTML / PDF and PI export; inquiry rules with a rule tester.
- **Mailbox**: IMAP sync, SMTP send, app-password presets and Gmail / Outlook OAuth, mail linked to customers, agent-written drafts (sending always requires a click).
- **Team server mode**: accounts, roles, per-account isolation, invitations, remote sign-in from the desktop app.
- **Backups**: JSON export / import, automatic database snapshots with rotation and verified restore; structured logs with request ids.
- **Desktop**: native title bar per platform, built-in browser, auto-update, bundled npm so no local Node.js is needed.
- **Sign-in & local account**: the desktop app always starts on the sign-in page; first launch creates a local account and shows a one-time **recovery code**. **Forgot password** resets with the recovery code, or with a `RESET-LOCAL-PASSWORD` file in the data directory. 首次启动登录 / 创建本机账户 / 恢复码；忘记密码（恢复码或重置文件）。
- **Agent page**: denser layout and a collapsible conversation list (Ctrl/⌘+B). The Agent entry is now called **LULUX** and sits first in the navigation; the app still opens on the Workbench. Agent 页更紧凑、会话栏可收起；导航新增“LULUX”。
- **Reasoning effort per model** (Settings → Models & keys), with automatic fallback when a model doesn't support the chosen level. 每个模型可设思考强度，不支持时自动降级。
- **Composer “+”**: attach a customer, quote, email, deal or order as one-shot context for the next message, or pin it to the session. 输入框“+”一次性带入客户 / 报价 / 邮件 / 商机 / 订单，或固定绑定到会话。
- **Command palette** (Ctrl/⌘+K) and keyboard shortcuts (press `?`). 快捷键与命令面板。
- **Composite group avatars** for group chats. 群聊组合头像。
- **CRM**: customer delete protection (refused while quotes, deals, orders or payments are attached), soft delete with a 30-day **Recycle bin**, duplicate-customer warnings, and a **Product library**. 客户删除保护、回收站（30 天）、客户查重、产品库。
- **Team**: fine-grained per-account permissions; member offboarding hands over emails, workflows and schedules and can force a password change; per-member usage and chat rate limits; admin mailbox access setting (off by default, audited). 细粒度账户权限、成员离职交接与强制改密、按成员用量与限流、管理员邮箱访问开关（默认关闭，留审计）。
- **Desktop**: tray icon and start at login; diagnostics export; the local server restarts automatically if it stops; configurable update feed; version compatibility notice when client and server don't match. 托盘与开机自启动、诊断导出、本地服务自动重启、可配置更新源、版本兼容提示。
- **Backups**: choose the backup folder, download and delete snapshots. 备份目录可选、可下载 / 删除。
- English error messages when the UI language is English. 英文界面下错误信息为英文。
- **Sign-in page language picker** (globe, top-right, clear of the Windows window buttons); same setting as Settings → Appearance. 登录页右上角语言选择。
- **Permission picker** next to the message box is a compact round icon button (Read only / Ask for approval / Full access on click, current level on hover); Full access is shown in blue. 权限选择器改为圆形图标按钮，“完全权限”显示为蓝色。

### Fixed

- Desktop: “Remember this computer” now survives a restart: the session is kept by the main process (encrypted with the OS keychain via safeStorage) and the app reuses the last local port; an expired session prefills the username. 桌面版“记住这台机器”重启后仍然有效。
- Windows: header buttons on the Agent page are clickable again (no longer inside the title-bar drag region), and the header leaves room for the window controls. Windows 标题栏：Agent 页页头按钮可点击，并为窗口按钮留出空间。

### Security

- Local API requires a per-launch random Bearer token; `Host` / `Origin` validation; no CORS; JSON-only request bodies.
- MCP launch commands require native confirmation; settings API accepts whitelisted keys only; API keys are never returned in plaintext.
- Artifact previews run in a sandboxed iframe without network access.
- Memory: memory tools are not offered in Read only chats, workflows, schedules or group chats with other people; hidden Unicode characters are stripped and text NFKC-normalized before credential / prompt-injection checks, and stored entries are re-cleaned before reaching the prompt; automatic extraction skips group chats with other people, schedule / workflow sessions and CLI kernels signed in with your own account.

### License

- Official MariaDB Business Source License 1.1 text. Production use is free for individuals and organizations (including internal modification); paid distribution, sublicensing and paid hosted services are excluded. Change Date 2030-10-20, Change License Apache-2.0.

[0.1.1]: https://github.com/koko2376/lulux-eta/releases/tag/v0.1.1
