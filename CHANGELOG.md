# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each released version carries its own BSL Change Date (see `LICENSE`).

## [Unreleased]

## [0.1.4] - 2026-11-14

WhatsApp arrives as a channel: link one personal account as a linked device, chat with customers in three panes with translation, and let LULUX draft replies that you review before sending. Plus a round of fixes across the mailbox, customers, drafts and settings, and a refreshed mailbox look. 新增 WhatsApp 渠道：以关联设备方式接入一个个人号，三栏会话、收发翻译，LULUX 起草回复、由你确认后发出；同时修复邮箱、客户、草稿与设置中的一批问题，并更新邮箱界面。

### Added

- **WhatsApp (unofficial engine, opt-in)**: link one personal WhatsApp account per server as a linked device, by QR code or phone pairing code. Before linking you must read and accept the account-ban risk (kept for 30 days); the protocol engine is not bundled and is installed at runtime (see `docs/WHATSAPP-ENGINE.md`). On a team server the first member who links owns the account; other members get `WHATSAPP_ACCOUNT_BUSY`. WhatsApp（非官方引擎，需手动启用）：每台服务以“关联设备”方式接入一个个人号，扫码或手机号配对码；关联前必须阅读并确认封号风险（保留 30 天）；协议引擎不打进安装包，运行时安装（见 `docs/WHATSAPP-ENGINE.md`）；团队服务器上由第一个关联的成员占用，其他成员收到 `WHATSAPP_ACCOUNT_BUSY`。
- **WhatsApp chats**: three panes — conversation list with search (name, number, linked company), filters (all / unread / awaiting reply / archived), tags, pin and archive; message stream with retry for failed sends and optional in-bubble translation of incoming messages; a customer profile on the right showing existing customer fields, with manual linking to a customer or creating one; personal quick replies. WhatsApp 会话：三栏布局——会话列表支持搜索（名称 / 号码 / 关联公司）、全部 / 未读 / 待回复 / 已归档筛选、标签、置顶与归档；消息区失败可重试，收到的消息可在气泡内显示译文；右侧客户档案显示已有客户字段，可手动关联或新建客户；个人快捷回复。
- **Input translation**: type in your own language in the small box, the translation fills the main message box, and what is sent is exactly the main box. The translator is a runtime-installed engine (see `docs/WHATSAPP-TRANSLATOR.md`). 输入翻译：在小框里用母语输入，译文填入主输入框，发出的就是主输入框里的内容；翻译引擎运行时安装（见 `docs/WHATSAPP-TRANSLATOR.md`）。
- **LULUX on WhatsApp**: agent tools `whatsapp_conversations`, `whatsapp_read_messages`, `whatsapp_draft_reply` (saves a draft only; it appears as a draft card with “Use and edit” / “Discard”) and `whatsapp_send_message` (requires approval every time). LULUX 接入 WhatsApp：查会话、读消息、起草回复（只存草稿，会话里显示草稿卡，可“使用并编辑”或“丢弃”）、发送消息（每次都需审批）。
- **Egress proxy for WhatsApp**: one SOCKS5 / HTTP / HTTPS proxy for the linked account, set by the linking member or an owner / admin; “Test connection” shows the egress IP. The password is encrypted and never sent back to the browser. WhatsApp 出口代理：为关联账号设置一个代理，由绑定人或老板 / 管理员设置；“测试连接”显示出口 IP；密码加密保存、不回传浏览器。
- **Customers list, high density**: 50 px rows, primary contact / local time / tags columns, optional columns that collapse on narrow windows, server-side sorting, 20 / 50 / 100 per page, and batch actions in one server transaction (select across pages, change stage, add / remove tags, assign, delete), also as agent tools. 客户列表高密度：统一 50px 行高、主联系人 / 当地时间 / 标签列、可选列且窄窗口自动收起、服务端排序、每页 20 / 50 / 100、批量操作走服务端事务（跨页全选、改阶段、加 / 去标签、分配、删除），Agent 也可批量操作。

### Changed

- **Interface**: a seventh sidebar entry, WhatsApp, with an unread badge and a connection dot; mailbox look refreshed — selected message and folder in accent colour with white text, accent unread dots, previous / next in the reading pane, folder icons; page-header buttons wrap as a group on narrow windows. 界面：侧栏新增第七个入口 WhatsApp（未读角标与连接状态点）；邮箱界面更新——选中的邮件与文件夹主题色底白字、未读点主题色、阅读区上一封 / 下一封、文件夹图标；窄窗口页头按钮整组换行。
- Interface text that refers to the built-in assistant now says “LULUX” instead of “Agent”; the Leads page button reads “Let LULUX find customers”. 指内置助手的界面文案统一为 LULUX；线索页按钮改为“让 LULUX 找客户”。
- Web search: the official Bing API has been retired, so the Bing-compatible option now requires a gateway URL. 联网搜索：Bing 官方接口已停服，Bing 兼容选项必须填写网关地址。
- Database migrations 37–40 (remote-image consent, WhatsApp conversations and messages, customer query indexes, quick replies) run automatically on start-up. 启动时自动执行数据库迁移 37–40（远程图片同意、WhatsApp 会话与消息、客户查询索引、快捷回复）。

### Fixed

- Mailbox: images not showing — inline (CID) images are resolved and validated, remote images load through the server only after you allow them for that message, and the choice is remembered; messages with an HTML body open in rich view by default; folder counts and the sidebar badge refresh right after a re-review. 邮箱：图片不显示——内联图解析与校验、远程图片按封同意后经服务端代理加载并记住选择；有 HTML 正文默认图文视图；复核后文件夹计数与侧栏角标立即刷新。
- The built-in browser is released as soon as a run ends instead of staying occupied for 90 seconds. 运行结束立即释放内置浏览器，不再占用 90 秒。
- Message-box drafts are saved to disk (including the last keystrokes before closing the window) and kept per server and account; recent customers and read state are no longer shared between accounts. 输入框草稿落盘（含关窗前最后几个字），并按服务器与账号隔离；最近客户与已读状态不再跨账号串用。
- Backup import lists applied and skipped settings, including unknown keys and invalid values; table names are localized and only non-zero tables are shown. 备份导入列出已应用 / 已跳过的设置（含未知键与非法值），表名本地化、只列非零表。
- CLI kernel time-outs (idle and total run time) can be set in Settings. 命令行内核的无输出超时与单次运行时长可在设置中调整。
- @mentions use the same word boundaries in the client and on the server. @ 提及在客户端与服务端按同一边界识别。
- Outreach sequences: saving a single setting no longer resets the others to their defaults. 开发信序列：只改一项设置不再把其他设置写回默认值。
- Customer search kept stale results after a contact moved to another customer. 联系人换到其他客户后，客户搜索结果不再残留旧关联。
- Creating a customer prefilled from another page no longer tries to update a non-existent record. 从其他页面预填新建客户时，不再误走“更新客户”。
- Server error messages all have English translations. 服务端错误信息全部补齐英文。

## [0.1.2] - 2026-10-25

From chat assistant to a foreign-trade agent that finds buyers, prices, follows up and prepares shipping documents. Every new capability is an agent tool too (built-in kernel, LULUX MCP for CLI kernels, and workflow agent nodes). 从对话助手升级为能找客户、算报价、跟进、出单证的外贸 Agent；每项新能力都是 Agent 工具（内置内核、命令行内核经 LULUX MCP、工作流 Agent 节点均可调用）。

### Added

- **Browser use**: the agent can drive the built-in browser (open, snapshot, click, type, select, scroll, back, screenshot). A status bar shows each step with Take over / Resume / Stop; password fields are refused; submit / pay / delete-type clicks always ask, even in Full access; denied domains and a step limit in Settings → Chat & tools. Desktop only. Agent 操作内置浏览器：状态条逐步显示，可接管 / 继续 / 停止；密码框拒绝；提交、付款、删除类点击始终审批；可设禁止域名与步数上限（仅桌面端）。
- **Computer use (experimental, off by default)**: screenshot + mouse / keyboard on the desktop, per-chat opt-in, every action approved unless allowed for the task, an emergency-stop shortcut, and an automatic pause when you move the mouse. 操作电脑（实验性，默认关闭）：按会话开启、逐步审批、急停快捷键、用户动鼠标自动暂停。
- **Group chats, one-sentence setup**: the same kernel can join a group several times (e.g. LULUX as merchandiser, LULUX #2 as translator), each member with its own title badge, duties and model. `create_group` / `update_group` / `post_to_group` / `delete_group` tools, also over MCP and as a workflow “group discussion” node. 群聊：同一内核可多次进群，各自有群头衔、职责与模型；一句话建群 / 改群 / 发群消息，工作流可用“群聊讨论”节点。
- **Prospecting**: a Leads page (Customers → Leads) with evidence labels (“customs evidence” vs “website only”), scores, CSV / Excel import and convert-to-customer with de-duplication. Built-in sources: UK HMRC importer records by HS code, UN Comtrade market size and growth, and website background checks via search; optional paid keys can be added. 开发客户：线索页（有海关证据 / 仅官网发现标签、评分、表格导入、转客户查重）；内置英国 HMRC 进口商、联合国 Comtrade 市场数据、官网背调。
- **Sanctions screening**: OFAC (SDN + alternate names), EU and UN consolidated lists, fuzzy matching, updated daily by default (Settings). Used when saving leads, enrolling sequences and scoring inquiries. 制裁名单筛查：OFAC / 欧盟 / 联合国，模糊匹配，默认每天自动更新。
- **Quotation engine**: cost → EXW / FOB / CFR / CIF / DDP with export rebate, freight-table lookup (CSV / XLSX import), automatic container choice, live FX (ECB) with manual rate locks, margin / markup / target-price modes; “Price from cost” dialog in the quotation editor and `quote_calculate` / `quote_generate_pi` tools. Costs, margins and FX rates never appear on the PI. 报价引擎：成本到各贸易术语价、退税、运价表、自动选柜、实时汇率与锁汇；PI 上绝不出现成本、毛利与汇率。
- **Inquiry scoring**: every inquiry gets an A–D grade with reasons (company domain, specifics, signature, phishing / payment-fraud / sanctions risk), the questions to ask back, and a one-click first-reply draft. Sort the mailbox by score. 询盘打分：A–D 等级与理由、风险提示、追问清单、一键起草首回。
- **Outreach sequences**: multi-step cold-email sequences sent in the recipient's local working hours, template variables, drafts for review by default (auto-send is opt-in and never available to the agent), daily caps, automatic stop on reply / unsubscribe / bounce, and a suppression list. 开发信序列：按对方当地工作时间排期、默认生成草稿待确认、回信 / 退订 / 退信自动停发。
- **Shipping documents**: commercial invoice, packing list and certificate-of-origin drafts (PDF) from an order, with a live missing-field check and HS code suggestions. 出货单证：从订单生成 CI / PL / CO 草稿，实时缺项检查与 HS 编码建议。

### Changed

- **New interface**: one rounded sidebar with six entries (LULUX, Workbench, Customers, Mailbox, Workflows, Skills) and settings at the bottom; conversations grouped by day; a welcome screen before sign-in; a two-row message box (input on top; “+”, permissions, model and send below; attachments moved into “+”); permission levels colour-coded (Read only green, Ask blue, Full access red); a spectrum reasoning-effort slider; streaming “Generating” shimmer; softer tool cards. Old routes redirect. 全新界面：单侧栏 6 个入口、会话按日分组、开屏欢迎页、两行输入框、权限三色、光谱思考强度滑条、更圆润的工具卡片；旧路由自动跳转。
- Quotation → order now writes the destination port for CIF / CFR / DDP-type terms (origin port for FOB / EXW / FCA / FAS). 报价转订单：CIF / CFR / DDP 类写入目的港。
- Times given to the model by tools are local time with offset. 工具给模型的时间统一为本机时区带偏移。
- Lulu, the LULUX mascot, sits on the message box: follows the cursor while you type, paces while the agent thinks, cheers when a reply is done (Settings → Appearance; still under “Reduce motion”). 吉祥物露露站在输入框上（外观设置可关；减少动态效果时不走动）。
- Several instances of the same kernel now get different avatars, in group chats and in the chat list. 同一内核的多个实例头像各不相同。
- Read only chats no longer offer web fetch, web search or the browser. 仅可查看档不再提供网页抓取、联网搜索与浏览器。
- Workflows and schedules no longer run skill scripts automatically. 工作流与定时任务不再自动运行技能脚本。
- Desktop: the default local port is now 31789; on Linux, closing the window quits instead of hiding to the tray by default; updates are fetched over HTTPS only; “Remember this computer” renews itself while in use. 桌面端：默认本地端口改为 31789；Linux 默认关窗即退出；更新源仅 HTTPS；“记住本机”使用中自动续期。

### Fixed

- Chat titles no longer include quoted `<context>` blocks. 会话标题不再带入引用块。
- Pop-up menus are positioned correctly when the interface zoom is not 100 %. 界面缩放不是 100% 时弹出菜单位置正确。
- A pre-release audit fixed 70 issues across the desktop app, client, server core, agent runtime and trade modules, including: “Remember this computer” failing when the OS keychain is unavailable; unattended workflow nodes writing beyond their permission; CLI kernel processes outliving timeouts; MCP approvals left pending after a run ended; empty replies; @mentions matching inside words; a slow migration on large group chats; tables overflowing at 1024 px; workflow toolbar buttons cut off in narrow windows. 发版前深度审计修复 70 处问题（桌面端、客户端、服务端核心、Agent 运行时、外贸业务），包括记住本机在系统钥匙串不可用时失效、无人值守节点越权写入、命令行内核超时后进程残留、运行结束后审批悬挂、空回复、@ 误匹配、大群聊迁移过慢、1024 宽表格溢出、窄窗口工作流工具栏被截断等。

### Known limitations

- Browser use and computer use run on the desktop app only; on a team server these tools are hidden. Browser screenshots are saved to the chat workspace and are not yet sent to the model as images. 浏览器 / 电脑操作仅桌面端；团队服务器上不提供。浏览器截图暂不作为图片发给模型。

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

[0.1.4]: https://github.com/koko2376/lulux-eta/releases/tag/v0.1.4
[0.1.2]: https://github.com/koko2376/lulux-eta/releases/tag/v0.1.2
[0.1.1]: https://github.com/koko2376/lulux-eta/releases/tag/v0.1.1
