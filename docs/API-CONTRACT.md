# LULUX ETA API 契约（重构期，2026-10-20）

LULUX ETA 本地 / 服务器 HTTP API、SSE 事件与 Agent 工具的接口说明。服务端（packages/server、packages/desktop）与客户端（packages/client）以本文件为准；接口变更请同步更新本文件文末的“变更记录”。

## 1. 鉴权与传输

- 所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`，否则 401。
- Host 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403。
- 若带 `Origin`，必须等于服务自身 origin（`http://127.0.0.1:<port>` / `http://localhost:<port>`）或开发态 Vite origin（`http://localhost:5173`、`http://127.0.0.1:5173`，仅当 `NODE_ENV!=='production'`），否则 403。
- 无 CORS 头（删除 `cors()`）。请求体只接受 `application/json`（其余 415）。
- token 来源：
  - 桌面端：主进程每次启动 `crypto.randomBytes(32).toString('hex')`，经环境变量 `LULUX_API_TOKEN` 传给服务子进程；preload 暴露 `window.luluxAgent.apiToken: string`。
  - 浏览器开发态：服务端若未收到 `LULUX_API_TOKEN`，自行生成并写入 `<dataDir>/api-token`（权限 0600）；`packages/client/vite.config.ts` 的 dev proxy 读取该文件，给代理请求注入 Authorization 头。客户端在没有 `window.luluxAgent` 时不加头（交给代理）。
- 静态资源（`/`、`/assets/*`、`/agents/*.png` 等非 `/api` 路径）不需要 token。`GET /api/health` 也需要 token（只返回 `{ok:true}`）。
- 错误格式统一：`{ "error": { "code": "STRING_CODE", "message": "中文可读信息" } }`，HTTP 状态码语义正确。

## 2. 已有接口（保持路径；返回中绝不返回明文 apiKey，改为 `hasApiKey: boolean` + `apiKeyPreview: "sk-…abcd"`）

agents / chat / chat/tool-decision / data/* / mcp/servers* / proxy/test / webhook/test / providers* / sessions* / settings。

- `PATCH /api/settings`：只接受白名单键，未知键 400。白名单与类型由服务端 `settings-service.ts` 定义并通过 `GET /api/settings/schema` 返回 `{ key, type, default, enum? }[]`。
- `POST /api/mcp/servers`、`PATCH`（改 command/args/env 时）：桌面端由主进程弹出原生确认框（显示完整命令），用户拒绝则 403 `MCP_COMMAND_REJECTED`。浏览器开发态无主进程时：仅当设置 `allowMcpWithoutNativeConfirm=true`（默认 false）才允许，否则 403。

## 3. 新接口

### 内核 Kernels
- `GET /api/kernels` → `Kernel[]`
  `Kernel = { id, name, vendor, npmPackage, description, sizeHint, installed: boolean, version: string|null, latestVersion: string|null, status: 'idle'|'installing'|'uninstalling'|'error', progress: number|null /*0-100*/, error: string|null, requiresLogin: boolean, loginHint: string }`
  内置条目 `id='builtin'`（LULUX 自带，直接走 Provider）始终 installed。
- `POST /api/kernels/:id/install`、`POST /api/kernels/:id/update`、`POST /api/kernels/:id/uninstall` → 202 `Kernel`（异步，客户端每秒轮询 GET 直到 status=idle/error）
- `GET /api/kernels/:id/log` → `{ lines: string[] }`（最近 500 行）
- 安装源：`https://registry.npmmirror.com`，装到 `<dataDir>/kernels/<id>/`（`npm install --prefix ... --registry ...` 或直接拉 tarball），不污染全局。

### Agents（替换现有静态人设）
- `GET /api/agents` → `Agent[]`
  `Agent = { id, name, description, avatar, accent, kind: 'persona'|'kernel', kernelId: string|null, available: boolean, unavailableReason: string|null }`
  - persona 类：LULUX 自有角色（不得使用第三方产品名），由当前 Provider 模型驱动。
  - kernel 类：对应已安装的第三方内核（名称如 “Claude Code”），`available=false` 时 `unavailableReason='未安装'|'需要登录'` 等；选中不可用的 kernel agent 发消息返回 409 `KERNEL_UNAVAILABLE`。
- chat 流事件中，每条 assistant 消息带 `runtime: { kind: 'provider', providerName, model } | { kind: 'kernel', kernelId, version }`，客户端在消息头显示实际运行者。

### 客户 Customers
- `GET /api/customers?query=&stage=&tag=&page=&pageSize=` → `{ items: Customer[], total }`
- `POST /api/customers`、`GET/PATCH/DELETE /api/customers/:id`
  `Customer = { id, company, country, website, stage: 'lead'|'contacted'|'quoted'|'negotiating'|'won'|'lost', tags: string[], source, notes, contacts: Contact[], createdAt, updatedAt }`
  `Contact = { id, name, title, email, phone, whatsapp, isPrimary }`
- `POST /api/customers/import` body `{ rows: Record<string,string>[], mapping: Record<field, column>, dedupeBy: 'email'|'company'|'website', onDuplicate: 'skip'|'merge' }` → `{ created, merged, skipped, errors: {row, message}[] }`（CSV/XLSX 在客户端解析成 rows）
- `GET /api/customers/:id/activities` → `Activity[]`；`POST` 同路径新增 `{ type: 'note'|'email'|'call'|'quote', content }`

### 产品与报价 Products / Quotes
- `GET/POST /api/products`、`PATCH/DELETE /api/products/:id`：`{ id, sku, name, spec, unit, price, currency, moq, hsCode }`
- `GET/POST /api/quotes`、`GET/PATCH/DELETE /api/quotes/:id`：`Quote = { id, number, customerId, currency, incoterm: 'EXW'|'FOB'|'CFR'|'CIF'|'DDP'|..., port, validUntil, paymentTerms, leadTime, items: {productId|null, name, spec, qty, unit, unitPrice}[], notes, status: 'draft'|'sent'|'accepted'|'rejected', subtotal, createdAt, updatedAt }`
- `GET /api/quotes/:id/html` → 可打印 HTML（客户端用 iframe + window.print / Electron printToPDF 导出 PDF）

### 询盘判定规则 / 报价模板
- `GET/POST /api/inquiry-rules`、`PATCH/DELETE /api/inquiry-rules/:id`：`{ id, name, enabled, conditions: {field:'subject'|'body'|'from'|'domain', op:'contains'|'not_contains'|'regex', value}[], action: 'inquiry'|'spam'|'review', priority }`
- `POST /api/inquiry-rules/test` body `{ subject, body, from }` → `{ verdict, matchedRuleId|null }`
- `GET/POST /api/quote-templates`、`PATCH/DELETE /api/quote-templates/:id`：`{ id, name, isDefault, company: {name,address,phone,email,logoDataUrl}, defaultIncoterm, defaultCurrency, defaultPaymentTerms, footer }`

### 工作台
- `GET /api/workbench/summary` → `{ customers: {total, byStage}, quotes: {total, draft, sent, accepted, amountByCurrency}, recentActivities: Activity[], recentSessions: SessionSummary[] }`

### 数据与备份
- 已有 `GET /api/data/export`（JSON）；新增 `POST /api/data/import` body 同导出格式 → `{ imported: Record<table, number> }`（导入前自动在 `<dataDir>/backups/` 留快照）

### 本机锁（替换假登录）
- `GET /api/lock` → `{ enabled: boolean }`；`POST /api/lock/setup {pin}`（4–12 位，scrypt 存哈希）；`POST /api/lock/verify {pin}` → `{ ok }`；`POST /api/lock/disable {pin}`
- 默认不启用：未启用时客户端直接进主界面，无登录页。

### ~~暂不实现~~（已取消，见第 4、5 节）
邮箱收发、团队与权限、远程服务器登录均已改为正式实现，客户端**不再显示“即将推出”**。

## 4. 邮箱

目标：真实可收发（IMAP 同步 + SMTP 发送 + Gmail/Microsoft OAuth2）。依赖：`imapflow`（MIT）、`nodemailer`（MIT-0）、`mailparser`（MIT）、`pdfkit`（MIT）。所有接口都要求第 1 / 5 节的鉴权；以下实体在 server 模式下都按第 5.6 节做行级可见性过滤，desktop 模式下 `ownerId='local'`。

### 4.1 服务商预设
- `GET /api/email/presets` → `EmailPreset[]`
  ```ts
  EmailPreset = {
    id: 'gmail'|'outlook'|'office365'|'qq'|'exmail-qq'|'163'|'126'|'aliyun-qiye'|'zoho'|'custom',
    name: string,                       // 'Gmail'、'QQ 邮箱'、'腾讯企业邮'…
    imap: { host, port, secure: boolean },   // secure=true 表示隐式 TLS（993）；false 表示 STARTTLS
    smtp: { host, port, secure: boolean },   // 465 → secure=true；587 → false（STARTTLS）
    authTypes: ('password'|'oauth2')[],      // gmail/outlook/office365 含 'oauth2'
    oauthProvider: 'google'|'microsoft'|null,
    authHint: string,                   // 中文：如“需在 QQ 邮箱设置里开启 IMAP/SMTP 并生成授权码，密码栏填授权码”
    helpUrl: string|null,
    appendToSent: boolean,              // 发送后是否需要 IMAP APPEND 到“已发送”（Gmail/Outlook 服务端自动保存，为 false）
    domains: string[]                   // 用于按邮箱后缀自动推荐预设，如 ['qq.com','foxmail.com']
  }
  ```
  预设值：Gmail `imap.gmail.com:993 / smtp.gmail.com:465`；Outlook.com `outlook.office365.com:993 / smtp-mail.outlook.com:587`；Office365 `outlook.office365.com:993 / smtp.office365.com:587`；QQ `imap.qq.com:993 / smtp.qq.com:465`；腾讯企业邮 `imap.exmail.qq.com:993 / smtp.exmail.qq.com:465`；163 `imap.163.com:993 / smtp.163.com:465`；126 `imap.126.com:993 / smtp.126.com:465`；阿里企业邮 `imap.qiye.aliyun.com:993 / smtp.qiye.aliyun.com:465`；Zoho `imap.zoho.com:993 / smtp.zoho.com:465`（国区账号可改 `.com.cn`）。

### 4.2 邮箱账户
```ts
EmailAccount = {
  id: string, name: string, email: string, displayName: string,
  presetId: string|null,
  authType: 'password'|'oauth2',
  oauthProvider: 'google'|'microsoft'|null,
  imap: { host, port, secure, username },
  smtp: { host, port, secure, username },
  hasSecret: boolean,              // 存有密码/授权码或 OAuth refresh token
  secretError: string|null,        // 主密钥变化无法解密时的中文提示
  syncEnabled: boolean,            // 后台定时同步
  syncDays: number,                // 首次同步只拉最近 N 天（1–365，默认取设置 emailSyncDays）
  appendToSent: boolean,
  signature: string,               // 纯文本签名，生成草稿时追加
  folders: { inbox: string, sent: string|null },   // 实际 IMAP 路径，sent 自动按 \Sent 特殊用途识别
  status: {
    state: 'idle'|'syncing'|'error'|'needs_reauth',
    lastSyncAt: number|null, lastError: string|null, lastErrorCode: string|null,
    idle: boolean                  // 当前是否保持 IMAP IDLE 连接
  },
  ownerId: string, ownerName: string, visibility: 'private'|'team'|'org', teamId: string|null,
  createdAt: number, updatedAt: number
}
```
- `GET /api/email/accounts` → `EmailAccount[]`
- `POST /api/email/accounts` → 201 `EmailAccount`
  body：`{ email, name?, displayName?, presetId?, imap:{host,port,secure,username?}, smtp:{host,port,secure,username?}, password, syncEnabled?, syncDays?, appendToSent?, signature?, visibility?, teamId?, verify?: boolean /*默认 true：保存前测试 IMAP+SMTP 登录*/ }`
  `username` 缺省为 `email`。`password` 为密码 / 授权码 / 应用专用密码，AES-256-GCM 加密存储，**任何接口都不返回**。只用于 `authType='password'`；OAuth 账户只能通过 4.3 创建。
- `PATCH /api/email/accounts/:id` → `EmailAccount`（同上字段均可选；`password:''` 或缺省表示保持原值；改主机/端口/用户名/密码时若 `verify!==false` 会重新测试）
- `DELETE /api/email/accounts/:id` → 204（同时删除本地已同步邮件、草稿与附件缓存；不影响邮件服务器上的数据）
- `POST /api/email/accounts/test` body 同 POST（未保存的配置）→ 200 `EmailTestResult`
- `POST /api/email/accounts/:id/test` → 200 `EmailTestResult`
  `EmailTestResult = { ok: boolean, imap: { ok, code?: string, error?: string, folders?: {inbox, sent} }, smtp: { ok, code?: string, error?: string } }`（测试失败也是 200，看 `ok`）
- `POST /api/email/accounts/:id/sync` body `{ wait?: boolean, full?: boolean }`
  - `wait` 缺省 false → 202 `{ accepted: true }`，进度看 4.8 事件或轮询账户 `status`；
  - `wait=true` → 200 `SyncResult`；`full=true` 忽略游标，按 `syncDays` 重新扫描（已存在的邮件按 UID 去重，不会重复）。
  - 同一账户已在同步中 → `wait=false` 时 202 `{accepted:false}`；`wait=true` 时等待那次结束并返回其结果。
  `SyncResult = { accountId, folders: { path, role:'inbox'|'sent', fetched, highestUid, uidValidity }[], newMessages, verdicts: { inquiry, spam, review }, linkedToCustomers, durationMs }`

**同步规则（服务端行为，客户端无需实现）**：每账户只同步 INBOX 与“已发送”；增量按 `UIDVALIDITY + 最大 UID`（服务器支持 CONDSTORE 时同时记录 `HIGHESTMODSEQ`，用于同步已读/星标变化）；`UIDVALIDITY` 变化时清游标重扫 `syncDays`。首次只拉 `SINCE now-syncDays`。正文（text + html，单封上限 2 MB，超出截断并标记）与附件元数据入库；附件内容按需下载（4.5）。后台定时同步间隔取设置 `emailSyncIntervalMinutes`（0 = 关闭），`emailUseIdle='1'` 时对 INBOX 保持 IDLE，有新邮件立即增量同步。

### 4.3 OAuth2（Gmail / Microsoft，XOAUTH2）
开源项目**不内置任何 Client ID / Secret**，由用户在设置里填写自己申请的（申请步骤见 4.10）。
- `GET /api/email/oauth/config` → `OAuthConfig`
  `OAuthConfig = { google: { clientId: string, hasClientSecret: boolean }, microsoft: { clientId: string, tenant: string /*默认 'common'*/, hasClientSecret: boolean }, redirectUris: { google: string, microsoft: string } }`
  `redirectUris` 是**需要在服务商控制台登记的回调地址**（desktop：`http://127.0.0.1:<port>/oauth/callback`（Google）与 `http://localhost/oauth/callback`（Microsoft 本机回环忽略端口）；server：`<LULUX_PUBLIC_ORIGIN>/oauth/callback`）。
- `PUT /api/email/oauth/config` body `{ google?: { clientId?, clientSecret? }, microsoft?: { clientId?, tenant?, clientSecret? } }` → `OAuthConfig`（server 模式仅 admin/owner；`clientSecret:''` 表示清除，缺省表示保持；Secret 加密存储，不回传）
- `POST /api/email/oauth/start` body `{ provider: 'google'|'microsoft', accountId?: string /*重新授权已有账户*/, loginHint?: string, visibility?, teamId? }` → 200 `{ state: string, authUrl: string, redirectUri: string, expiresAt: number }`
  - 服务端生成 PKCE（S256）`code_verifier` 与随机 `state`，10 分钟有效，只存内存。
  - 客户端打开 `authUrl`：桌面端用 `window.luluxAgent.browser.openExternal(authUrl)`（系统浏览器），浏览器态用 `window.open`。
  - 用户授权后浏览器跳到 `GET /oauth/callback?code&state`（**非 /api 路径、不需要 token**，`state` 即凭证），服务端换 token、读取邮箱地址（Google userinfo / Microsoft Graph `/me`）、新建或更新账户，页面显示“授权完成，可以关闭此页面”。
  - 未配置 Client ID → 400 `OAUTH_NOT_CONFIGURED`。
- `GET /api/email/oauth/status/:state` → `{ status: 'pending'|'done'|'error', accountId: string|null, error: string|null }`（客户端每 1–2 秒轮询，`done` 后刷新账户列表；state 过期 → 404 `OAUTH_STATE_EXPIRED`）
- scope：Google `https://mail.google.com/ openid email profile`；Microsoft `offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send openid email profile`（读取邮箱地址用 id_token 的 `email`/`preferred_username`）。
- access token 过期前 2 分钟自动用 refresh token 刷新；刷新失败（被撤销、Client 变更）→ 账户 `status.state='needs_reauth'`，客户端提示“重新授权”并调 `oauth/start` 带 `accountId`。

### 4.4 邮件
```ts
EmailAddress = { name: string, address: string }
EmailAttachment = { id, filename, contentType, size, contentId: string|null, inline: boolean, downloaded: boolean }
EmailMessageSummary = {
  id, accountId, folder: 'inbox'|'sent',
  uid: number|null,                    // 本地已发送但尚未同步回来的为 null
  messageId: string, threadKey: string, // threadKey：按 References/In-Reply-To 归并的会话键
  from: EmailAddress, to: EmailAddress[], cc: EmailAddress[],
  subject, date: number /*ms*/, snippet: string /*前 200 字纯文本*/,
  seen: boolean, flagged: boolean, hasAttachments: boolean,
  verdict: 'inquiry'|'spam'|'review'|null,      // null = 不判定（已发送邮件）
  verdictSource: 'rule'|'model'|'manual'|null,
  verdictReason: string,                        // 规则名 / 模型给的理由 / '人工标记'
  matchedRuleId: string|null,
  customerId: string|null, customerName: string|null,
  createdAt: number
}
EmailMessage = EmailMessageSummary & {
  replyTo: EmailAddress[], inReplyTo: string|null, references: string[],
  text: string, hasHtml: boolean, truncated: boolean,
  attachments: EmailAttachment[]
}
```
- `GET /api/email/messages?accountId=&folder=inbox|sent|all&verdict=inquiry|spam|review|none&customerId=&threadKey=&query=&unread=1&page=1&pageSize=50` → `{ items: EmailMessageSummary[], total }`（按 `date` 倒序；`pageSize` ≤ 200；`query` 匹配主题/发件人/正文）
- `GET /api/email/messages/:id` → `EmailMessage`
- `GET /api/email/messages/:id/html` → `text/html`，服务端已移除脚本、事件属性、`<iframe>/<object>/<form>`、`javascript:` 链接，`cid:` 内联图替换为 data URL，**外部图片不加载**；响应头 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:`。客户端 fetch 文本后放进 `<iframe sandbox srcdoc>`（与报价 HTML 同法）。无 html 时 404 `NO_HTML`。
- `PATCH /api/email/messages/:id` body `{ seen?, flagged?, verdict?: 'inquiry'|'spam'|'review', customerId?: string|null }` → `EmailMessage`
  `seen/flagged` 同步写回 IMAP（失败不报错，下次同步再试）；`verdict` 写为 `verdictSource='manual'`；`customerId` 手动关联/取消关联。
- `POST /api/email/messages/:id/classify` body `{ useModel?: boolean }` → `EmailMessage`（重新跑规则；`useModel=true` 时对 `review` 用当前默认 Provider 二次判定。模型不可用时 400 `NO_PROVIDER` / 409 `API_KEY_UNAVAILABLE` / 502 `UPSTREAM_*`）
- `POST /api/email/messages/:id/create-customer` body `{ company?, country?, website?, stage?, tags? }` → 201 `{ customer: Customer, message: EmailMessage }`
  缺省时：公司名取发件人域名主体（免费邮箱如 gmail.com 则取发件人显示名），website 取 `https://<domain>`（免费邮箱为空），联系人 = 发件人。同时把同一发件人的其他邮件关联到该客户，并记 Activity（`type='email'`，内容含主题）。已关联 → 409 `ALREADY_LINKED`。
- `POST /api/email/messages/:id/link` body `{ customerId }` → `EmailMessage`（同 PATCH customerId，并记 Activity）

**询盘判定（服务端行为）**：新收邮件逐封按第 3 节询盘规则判定（`from` = 发件人地址，`domain` = 其域名）。设置 `emailModelClassify='1'` 时，`review` 的邮件再交当前默认 Provider 判定，模型返回 `{verdict, reason}`；失败保持 `review`，`verdictReason` 记录原因。已发送邮件不判定。
**自动关联客户**：设置 `emailAutoLinkCustomers='1'`（默认）时，按联系人邮箱精确匹配，其次按网站/邮箱域名匹配（免费邮箱域名不参与域名匹配）；收件箱看发件人，已发送看第一个收件人。只关联当前用户可见的客户。

### 4.5 附件
- `GET /api/email/attachments/:id` → 二进制，`Content-Disposition: attachment; filename*=UTF-8''…`，`Content-Type` 为原类型（`text/html`、`image/svg+xml` 等可执行类型一律改为 `application/octet-stream`），`X-Content-Type-Options: nosniff`。首次访问时从 IMAP 下载并缓存到 `<dataDir>/attachments/<accountId>/<attachmentId>`。需要 token：客户端 fetch → Blob → `URL.createObjectURL` 下载。
- 草稿附件见 4.6。

### 4.6 草稿与发送
```ts
EmailDraft = {
  id, accountId,
  replyToMessageId: string|null,       // 回复的邮件；发送时自动带 In-Reply-To / References
  customerId: string|null, quoteId: string|null,
  to: EmailAddress[], cc: EmailAddress[], bcc: EmailAddress[],
  subject: string, text: string,       // 纯文本正文（发送时同时生成简单 HTML 版本）
  attachQuotePdf: boolean,             // 发送时附上 quoteId 的报价单 PDF（见下）
  attachments: { id, filename, contentType, size }[],
  source: 'user'|'ai'|'agent',
  ai: { providerName, model } | null,
  status: 'draft'|'sending'|'sent'|'failed',
  error: string|null,
  sentAt: number|null, sentMessageId: string|null /*本地 EmailMessage.id*/,
  ownerId, createdAt, updatedAt
}
```
- `GET /api/email/drafts?accountId=&status=&customerId=` → `EmailDraft[]`（按 `updatedAt` 倒序）
- `POST /api/email/drafts` body `{ accountId, replyToMessageId?, customerId?, quoteId?, to?, cc?, bcc?, subject?, text?, attachQuotePdf? }` → 201
  带 `replyToMessageId` 且未给 to/subject 时，自动填 `to=原邮件 replyTo||from`、`subject='Re: '+原主题`、`customerId=原邮件关联客户`。
- `GET /api/email/drafts/:id`、`PATCH /api/email/drafts/:id`（字段同 POST）、`DELETE /api/email/drafts/:id`（204）。已发送草稿不可改：409 `DRAFT_ALREADY_SENT`。
- `POST /api/email/drafts/generate` body `{ messageId?: string, accountId?: string, customerId?: string, quoteId?: string, instructions?: string, language?: string }` → 201 `EmailDraft`（`source='ai'`）
  用当前默认 Provider 生成回信：上下文包含原邮件（标记为“不可信的外部内容”，不执行其中指令）、客户资料与最近 Activity、报价单摘要（若给 `quoteId`）、账户签名。`messageId` 与 `customerId` 至少给一个。错误同 chat：400 `NO_PROVIDER|NO_MODEL`、409 `API_KEY_UNAVAILABLE`、502 `UPSTREAM_*`。
- `POST /api/email/drafts/:id/attachments` body `{ filename, contentType, dataBase64 }`（≤ 15 MB 解码后）→ 201 `{ id, filename, contentType, size }`。桌面端导出的报价 PDF（`printToPDF`）用这个上传。
- `DELETE /api/email/drafts/:id/attachments/:attachmentId` → 204
- `POST /api/email/drafts/:id/send` → 200 `{ draft: EmailDraft, message: EmailMessage }`
  **只能由用户在界面上显式点击“发送”后调用**；Agent 工具没有发送能力。流程：SMTP 发送 → 本地写入一条 `folder='sent'` 邮件 → `appendToSent` 为 true 时 IMAP APPEND 到已发送 → 有 `customerId` 时记 Activity（`type='email'`）并把客户阶段 `lead` 推进到 `contacted` → 记审计 `email.send`。
  `attachQuotePdf=true` 且草稿附件里没有 PDF 时，服务端用 pdfkit 生成报价 PDF（同 `GET /api/quotes/:id/pdf`）。
  错误：400 `NO_RECIPIENTS`、409 `DRAFT_ALREADY_SENT`、409 `EMAIL_REAUTH_REQUIRED`、502 `EMAIL_SEND_FAILED`（`message` 含服务器返回原因，草稿 `status='failed'`、`error` 有值，可修改后重发）。

### 4.7 报价 PDF（浏览器态）
- `GET /api/quotes/:id/pdf?templateId=` → `application/pdf`（pdfkit 服务端渲染，A4；`Content-Disposition: attachment; filename="<报价单号>.pdf"`）。
  中文字体：自动查找系统 CJK 字体（Windows 微软雅黑/宋体、macOS PingFang/华文黑体、Linux Noto Sans CJK / 文泉驿），也可用环境变量 `LULUX_PDF_FONT=<ttf/otf/ttc 路径>` 指定；都没有时用内置 Helvetica，非拉丁字符显示为 `?`，响应头 `X-Lulux-Pdf-Font: fallback`。
  桌面端推荐仍用 `GET /api/quotes/:id/html` + `printToPDF`（排版与预览一致），再走 4.6 附件上传。

### 4.8 实时事件（邮箱 + 团队共用）
- `GET /api/events` → `text/event-stream`。浏览器 `EventSource` 不能带 Authorization 头，客户端请用 `fetch` 读流（与 `/api/chat` 相同方式）。每 25 秒一个 `ping`。只推送当前用户可见的数据。
  | event | data |
  | --- | --- |
  | `ping` | `{ at }` |
  | `email.account` | `{ account: EmailAccount }`（状态变化：开始/结束同步、出错、需要重新授权） |
  | `email.sync` | `{ accountId, result: SyncResult }`（一次同步结束） |
  | `email.new` | `{ accountId, messageIds: string[], inquiry: number }`（有新邮件；`inquiry` 为其中询盘数） |
  | `email.draft` | `{ draft: EmailDraft }`（草稿新建/发送结果变化，含 Agent 创建的草稿） |
  | `session.revoked` | `{}`（server 模式：当前会话被登出/重置密码/成员被停用，客户端回登录页） |

### 4.9 Agent 内置业务工具
对话中 persona Agent 自动获得以下内置工具（非 MCP，名称固定、不与 MCP 工具冲突；MCP 工具在模型侧名称形如 `mcp__…`）。设置 `builtinTools='0'` 可整体关闭。
| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `search_customers` | read | `{ query?, stage?, limit? }` → 客户列表摘要 |
| `get_customer` | read | `{ customerId }` → 客户详情 + 最近 10 条 Activity + 报价摘要 |
| `create_customer` | write | `{ company, country?, website?, stage?, tags?, notes?, contact?: {name,email,phone,title} }` |
| `create_quote_draft` | write | `{ customerId, currency?, incoterm?, port?, items: {productId?, name, spec?, qty, unit?, unitPrice}[], notes? }` → `status='draft'` 的报价 |
| `search_emails` | read | `{ query?, customerId?, verdict?, folder?, limit? }` → 邮件摘要 |
| `create_email_draft` | write | `{ accountId?, replyToMessageId?, customerId?, quoteId?, to?, subject, text, attachQuotePdf? }` → 草稿（`source='agent'`，**不会发送**，回复里提示用户到邮箱页确认发送） |
- read 工具直接执行；write 工具按会话权限级别（6.11）：`ask` 时发 `tool_request` 等用户 `POST /api/chat/tool-decision`，`full` 时直接执行，`read` 时不提供。server 模式下工具以当前登录用户的身份与权限执行（viewer 的 write 工具返回“无权限”结果）。
- SSE `tool_request` / `tool_result` 及消息 `toolTrace[]` 新增字段：`builtin: boolean`、`risk: 'read'|'write'`；内置工具的 `server` 固定为 `'LULUX'`。read 工具的 `tool_request.auto` 恒为 true。

### 4.10 新增设置项（`GET /api/settings/schema` 同步返回）
`emailSyncDays`(integer 1–365，默认 `30`)、`emailSyncIntervalMinutes`(integer 0–1440，默认 `5`，0 关闭后台同步)、`emailUseIdle`(boolean，默认 `'0'`)、`emailModelClassify`(boolean，默认 `'0'`)、`emailAutoLinkCustomers`(boolean，默认 `'1'`)、`builtinTools`(boolean，默认 `'1'`)。

**如何申请 OAuth Client ID**（客户端可在设置页显示此说明，详见 `docs/email-oauth.md`）：
- Google：Google Cloud Console → 新建项目 → 启用 Gmail API → “OAuth 同意屏幕”（外部，测试用户里加入自己的 Gmail）→ “凭据 → 创建 OAuth 客户端 ID → 应用类型：桌面应用”，把 Client ID 与 Client Secret（桌面应用的 Secret 不保密，但 Google 换 token 时要求提供）填入设置。server 模式选“Web 应用”，授权重定向 URI 填 `redirectUris.google`。
- Microsoft：Azure 门户 → Microsoft Entra ID → 应用注册 → 新注册（受支持账户类型选“任何组织目录中的帐户和个人 Microsoft 帐户”）→ 身份验证 → 添加平台“移动和桌面应用程序”，重定向 URI 填 `http://localhost`（server 模式添加“Web”平台填 `redirectUris.microsoft` 并创建 Client Secret）→ API 权限添加 Office 365 Exchange Online 的 `IMAP.AccessAsUser.All`、`SMTP.Send` 与 Microsoft Graph 的 `offline_access`、`openid`、`email`、`profile` → 复制“应用程序(客户端) ID”。企业租户可把 tenant 设为租户 ID。

### 4.11 错误码
| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `EMAIL_CONFIG_INVALID` | 主机/端口/地址格式不对 |
| 400 | `EMAIL_AUTH_FAILED` | 登录失败（密码/授权码错误、未开启 IMAP/SMTP）；`message` 附服务商提示 |
| 502 | `EMAIL_CONNECT_FAILED` | 连不上服务器（DNS、端口、TLS、超时 20 秒） |
| 409 | `EMAIL_REAUTH_REQUIRED` | OAuth 刷新失败，需要重新授权 |
| 409 | `EMAIL_SECRET_UNAVAILABLE` | 主密钥变化导致密码无法解密，请重新填写 |
| 409 | `EMAIL_ACCOUNT_EXISTS` | 同一用户下邮箱地址已存在 |
| 502 | `EMAIL_SYNC_FAILED` | 同步失败（`wait=true` 时） |
| 502 | `EMAIL_SEND_FAILED` | SMTP 拒绝 |
| 400 | `NO_RECIPIENTS` | 草稿没有收件人 |
| 409 | `DRAFT_ALREADY_SENT` | 草稿已发送 |
| 413 | `ATTACHMENT_TOO_LARGE` | 草稿附件超过 15 MB |
| 404 | `NO_HTML` | 邮件没有 HTML 正文 |
| 409 | `ALREADY_LINKED` | 邮件已关联客户 |
| 400 | `OAUTH_NOT_CONFIGURED` | 未填 Client ID |
| 404 | `OAUTH_STATE_EXPIRED` | 授权会话不存在或超过 10 分钟 |
| 502 | `OAUTH_EXCHANGE_FAILED` | 换取 token 失败 |

## 5. 团队与服务器模式

### 5.1 两种运行模式
同一套 server，环境变量 `LULUX_MODE` 选择：
| | `desktop`（默认，现状） | `server`（团队服务器） |
| --- | --- | --- |
| 鉴权 | 每次启动随机 API token（第 1 节） | 账号密码登录，会话 token |
| Host/Origin | 第 1 节（仅 127.0.0.1/localhost） | 见 5.2 |
| 用户 | 固定本机用户 `id='local'`、角色 owner | users + RBAC |
| 内核 / MCP | 可用 | **默认禁用**，仅 owner 可开启（5.8） |
| 本机锁 PIN | 可用 | 不可用（`GET /api/lock` 恒 `{enabled:false}`，其余 404 `NOT_AVAILABLE_IN_MODE`） |
| 监听 | 127.0.0.1 | `LULUX_ETA_HOST`（Docker 内 `0.0.0.0`），必须部署在 TLS 反向代理之后 |

- `GET /api/auth/mode` → `{ mode: 'desktop'|'server', setupRequired: boolean, version: string, publicOrigin: string|null }` —— **两种模式都不需要 token**（客户端启动时先调它决定是否显示登录页）。`setupRequired` 只在 server 模式且还没有任何用户时为 true。
- `GET /api/auth/me` → `Me`（desktop 模式返回本机用户，客户端可统一处理）
  ```ts
  Me = { mode, user: User, org: Org, teams: Team[], permissions: Permission[], session: { expiresAt: number } | null }
  User = { id, email, name, role: 'owner'|'admin'|'member'|'viewer', disabled: boolean, createdAt, lastLoginAt: number|null }
  Org = { id, name, createdAt }
  Team = { id, name, memberIds: string[], createdAt }
  Permission = 'data:read'|'data:write'|'data:export'|'data:import'|'catalog:write'|'settings:write'|'providers:write'|'members:manage'|'audit:read'|'email:send'|'security:manage'
  ```
  desktop 模式：`user={id:'local',email:'',name:'本机用户',role:'owner',…}`，`org={id:'local',name:'本机'}`，`session=null`，`permissions` 为全部。

### 5.2 server 模式传输安全
- 必填 `LULUX_PUBLIC_ORIGIN`（逗号分隔白名单，如 `https://lulux.example.com`），缺失则拒绝启动。
- **Host** 必须等于白名单里某个 origin 的 host（含端口），或 `127.0.0.1:<port>` / `localhost:<port>`（容器内健康检查）；否则 403 `HOST_NOT_ALLOWED`。
- **Origin**（若带）必须在白名单内，或为桌面端本机界面 origin `http://127.0.0.1:<任意端口>` / `http://localhost:<任意端口>`（`LULUX_ALLOW_DESKTOP_ORIGINS=0` 可关闭）；否则 403 `ORIGIN_NOT_ALLOWED`。
- **CORS**：只对上述允许的 Origin 精确回显 `Access-Control-Allow-Origin`（附 `Vary: Origin`），`Allow-Headers: Authorization, Content-Type`，`Allow-Methods: GET, POST, PUT, PATCH, DELETE`，**不发** `Allow-Credentials`；`OPTIONS` 预检返回 204。（用于“桌面端连接团队服务器”：桌面界面仍由本机加载，直连团队服务器 API。）
- **CSRF**：只认 `Authorization: Bearer <session token>`，**不使用 cookie**。
- 反向代理：`LULUX_TRUST_PROXY=1` 时信任 `X-Forwarded-For` 取客户端 IP（用于限流与审计）；不设则用 socket 地址。
- 静态资源、`/oauth/callback` 与 `/api/auth/mode|setup|login|invites/*` 之外的 `/api/*` 都需要会话 token。

### 5.3 初始化 owner
两种方式任选：
1. **CLI**：`node packages/server/dist/cli.js create-owner --email a@b.com --password '…' --name 'Koko' --org '某某外贸'`（Docker：`docker compose exec lulux node dist/cli.js create-owner …`）。已有用户时报错退出。
2. **一次性 setup token**：server 模式首次启动且无用户时，生成随机 setup token 打印在日志里（`[lulux-eta] SETUP TOKEN: …`，同时写入 `<dataDir>/setup-token`，0600），owner 创建后立即作废。
- `POST /api/auth/setup` body `{ setupToken, email, password, name, orgName }` → 201 `LoginResult`；已初始化 409 `SETUP_ALREADY_DONE`；token 错误 403 `SETUP_TOKEN_INVALID`（计入限流）。
- `LoginResult = { token: string, expiresAt: number, user: User, org: Org }`

### 5.4 会话
- `POST /api/auth/login` body `{ email, password }` → 200 `LoginResult`
  错误：401 `INVALID_CREDENTIALS`（不区分邮箱不存在/密码错）、403 `USER_DISABLED`、409 `SETUP_REQUIRED`、429 `LOGIN_RATE_LIMITED`（同一 IP 15 分钟内失败 10 次，或同一邮箱 15 分钟内失败 5 次；响应头 `Retry-After` 秒）。
- 会话 token：`lxs_` + 64 位 hex（32 字节随机），库里只存 SHA-256。闲置过期 `LULUX_SESSION_IDLE_HOURS`（默认 168 = 7 天），绝对过期 `LULUX_SESSION_MAX_DAYS`（默认 30）。每次请求自动续期闲置期限（每分钟最多写一次库）。过期 → 401 `SESSION_EXPIRED`；无效 → 401 `UNAUTHORIZED`。
- `POST /api/auth/refresh` → `{ expiresAt }`（显式续期；token 不变）
- `POST /api/auth/logout` → 204（作废当前会话）
- `POST /api/auth/password` body `{ currentPassword, newPassword }` → 204；当前密码错 403 `PASSWORD_INCORRECT`；作废该用户的**其他**会话。
- 密码规则：8–128 字符，不能与邮箱相同，否则 400 `WEAK_PASSWORD`。存储：scrypt（N=16384, r=8, p=1, 64 字节，16 字节盐）。
- 客户端存 token：浏览器 `localStorage`（键 `lulux.session`）；桌面端交给主进程（5.10），不要放 cookie。

### 5.5 角色与权限矩阵
权限分两类：**组织级**权限只跟随角色；**业务操作**权限有角色默认值，server 模式下 owner/admin 可以按账号单独授予（grant）或收回（deny）。权限定义见 `packages/server/src/security/access.ts`（`ROLE_PERMISSIONS`、`PERMISSION_GROUPS`）。

| 权限 | owner | admin | member | viewer | 可按账号覆盖 |
| --- | --- | --- | --- | --- | --- |
| 读业务数据 `data:read`（按 5.6 可见性） | 全部 | 全部 | 自己的 + 共享的 | 自己的 + 共享的 | ✗ |
| 写客户/商机/报价/订单/任务/会话/邮箱账户/草稿 `data:write` | 全部 | 全部 | 仅自己的（共享客户可加 Activity、建报价、建草稿） | ✗ | ✓ |
| 删除客户 `customer:delete` | ✓ | ✓ | ✓（仅自己的） | ✗ | ✓ |
| 删除商机 `deal:delete` | ✓ | ✓ | ✓（仅自己的） | ✗ | ✓ |
| 删除报价单 `quote:delete` | ✓ | ✓ | ✓（仅自己的） | ✗ | ✓ |
| 删除订单或收款记录 `order:delete` | ✓ | ✓ | ✓（仅自己的） | ✗ | ✓ |
| 删除任务 `task:delete` | ✓ | ✓ | ✓（仅自己的） | ✗ | ✓ |
| 导入客户 `customer:import`（`POST /api/customers/import`） | ✓ | ✓ | ✓ | ✗ | ✓ |
| 导出 `data:export`（客户 CSV、`GET /api/data/export`、备份） | ✓ | ✓ | ✗（可按账号授予） | ✗ | ✓ |
| 发送邮件 `email:send` | ✓ | ✓ | ✓（只能用自己可见的账户） | ✗ | ✓ |
| 工作流与定时任务 `workflow:manage`（新建 / 修改 / 删除 / 导入 / 复制） | ✓ | ✓ | ✓ | ✗ | ✓ |
| 产品库 `catalog:write` | ✓ | ✓ | ✓ | ✗ | ✗ |
| 询盘规则、报价模板、组织设置 `settings:write` | ✓ | ✓ | ✗ | ✗ | ✗ |
| Provider / 模型密钥 `providers:write` | ✓ | ✓ | ✗（可使用） | ✗ | ✗ |
| 整库导入 / 恢复 `data:import` | ✓ | ✓ | ✗ | ✗ | ✗ |
| 成员、邀请、团队 `members:manage` | ✓ | ✓（不能动 owner、不能授予 owner） | ✗ | ✗ | ✗ |
| 审计日志 `audit:read` | ✓ | ✓ | ✗ | ✗ | ✗ |
| 内核 / MCP 开关 `security:manage` | ✓ | ✗ | ✗ | ✗ | ✗ |

- 删除类操作同时需要 `data:write` 与对应的 `*:delete`；界面接口、内置 Agent 工具（`delete_customer` 等）、LULUX MCP、工作流 / 定时任务节点走同一套服务层检查。
- 按账号覆盖（server 模式，`members:manage`）：`PUT /api/team/members/:id/permissions` body `{ overrides: { [permission]: 'grant' | 'deny' | null } }` → `User`（`null` 删除该项；也可在 `PATCH /api/team/members/:id` 里传 `permissionOverrides` 全量替换）。只接受上表“可按账号覆盖”为 ✓ 的权限；owner 恒为全部权限。写审计 `member.permissions`，立即生效、无需重新登录。`GET /api/team/permission-catalog` → `{ groups, roleDefaults, labels }` 供权限编辑器使用；`GET /api/auth/me` 的 `permissions` 返回生效权限（角色默认值 ± 覆盖项）。
- 删除客户：联系人、跟进记录、任务随客户删除，关联邮件保留但取消关联；客户名下有订单 / 收款 / 报价 / 商机时 → 409 `CUSTOMER_HAS_RECORDS`（`message` 列出各类数量，例如“该客户名下有 2 个订单、1 条收款、3 个报价，不能删除。请先转移或处理这些记录。”）。

无权限 → 403 `FORBIDDEN`（`message` 写明缺少的权限）。

### 5.6 行级可见性
- 客户、报价、会话、邮箱账户（及其邮件、草稿）带 `org_id`、`owner_id`，客户 / 邮箱账户 / 会话另带 `visibility: 'private'|'team'|'org'` 与 `teamId`。
- member / viewer 可见：`ownerId = 自己` 或 `visibility='org'` 或（`visibility='team'` 且 `teamId` ∈ 自己所在团队）。admin / owner 可见全部。不可见的行一律按 **404 `NOT_FOUND`** 处理（不泄露存在性）。
- 报价随客户：能看到客户就能看到它的报价。邮件、草稿随邮箱账户。Activity 随客户。
- 会话列表 `GET /api/sessions` 只返回自己的会话和自己所在的群（见 5.6a）。~~admin/owner 可加 `?scope=all`~~：**已废弃**，参数被忽略，admin/owner 也只看到自己的。
- 产品、询盘规则、报价模板、Provider、设置是组织级，组织内所有人可读。
- 新建时默认 `visibility='private'`、`ownerId=当前用户`、`teamId=当前用户第一个团队或 null`；body 可传 `visibility`、`teamId`（必须是自己所在团队，admin 可任选）。
- 以下实体在**两种模式下**都新增字段：`Customer`、`Quote`、`Session`、`EmailAccount` 增加 `ownerId: string, ownerName: string`；`Customer`、`Session`、`EmailAccount` 增加 `visibility`、`teamId`；`Activity` 增加 `actorId: string|null, actorName: string|null`。desktop 模式下 `ownerId='local'`、`ownerName='本机用户'`、`visibility='private'`。
- 客户负责人：
  - `POST /api/customers/:id/assign` body `{ ownerId, visibility?, teamId? }` → `Customer`（admin/owner 任意；member 只能把**自己的**客户转给别人）；同一事务内连带转移该客户的报价、商机、订单（收款挂在订单下，随订单走）和未完成任务（`status = open`）；已完成 / 已取消的任务保留原负责人作为历史记录，新负责人通过客户仍可见。记审计 `customer.transfer`（`summary` 与 `meta` 含各类转移数量）与 Activity。
  - `POST /api/customers/transfer` body `{ fromUserId, toUserId }` → `{ moved: number }`（admin/owner；离职交接）。除客户外，同一事务内转移：被转客户名下的报价、商机、订单、未完成任务，以及原负责人在本组织名下的其它报价、商机、订单、未完成任务（含不关联客户的任务）。审计 `customer.transfer` 含各类数量。
  - `GET /api/customers?ownerId=&visibility=` 新增筛选。

### 5.6a 仅本人：会话、工作流、定时任务（迁移 19，取代 5.6 中关于这三类的共享规则）
- **会话、工作流、定时任务只属于负责人本人**：只有 `ownerId = 自己` 的行可见、可改、可运行；**admin / owner 也看不到别人的**（不再有“admin 看全部”）。其他人一律 404 `NOT_FOUND`。
- 唯一例外：**多人群聊**里被邀请的真人成员能看到并参与该群（6.10）。
- 不再支持共享：`POST/PATCH /api/sessions`、`/api/workflows`、`/api/schedules` 的 `visibility` 只接受 `'private'`，`teamId` 只接受 `null`；传 `team`/`org` 或团队 id → 400 `VALIDATION_ERROR`。返回结构里仍有 `visibility`（恒为 `'private'`）、`teamId`（恒为 `null`），客户端不要再展示共享选项。
- 迁移 19 把旧库中这三张表的 `visibility` 一律改为 `private`。
- 客户、报价、邮箱账户等业务对象仍按 5.6（team / org 共享、admin 全览）不变。
- `/api/events` 中与会话相关的事件（`session.title`、`session.message`、`session.updated`、`session.removed`）只推给会话负责人 + 群里的真人成员，admin 也不例外；工作流 / 定时任务事件只推给负责人。

### 5.7 组织、成员、团队、邀请（`/api/team/*`，仅 server 模式，desktop 模式 404 `NOT_AVAILABLE_IN_MODE`）
- `GET /api/team/org` → `Org`；`PATCH /api/team/org` `{ name }` → `Org`（admin+）
- `GET /api/team/members` → `User[]`（所有成员可读，用于选择负责人）
- `PATCH /api/team/members/:id` body `{ role?, disabled?, name? }` → `User`（`members:manage`）。admin 不能修改 owner、不能授予 owner；不能停用/降级最后一个 owner（409 `LAST_OWNER`）；不能改自己的角色（409 `CANNOT_MODIFY_SELF`）。停用即作废其全部会话。
- `POST /api/team/members/:id/reset-password` body `{ newPassword }` → 204（`members:manage`；作废其全部会话；admin 不能重置 owner → 403 `CANNOT_MODIFY_OWNER`）
- `DELETE /api/team/members/:id` → 204：停用并作废会话（数据保留，用 `/api/customers/transfer` 交接）。
- 转让所有权：`POST /api/team/transfer-ownership` body `{ userId }` → `{ from: User, to: User }`（仅 owner；对方变 owner，自己变 admin）
- 团队：`GET /api/team/teams` → `Team[]`；`POST /api/team/teams` `{ name, memberIds? }` → 201；`PATCH /api/team/teams/:id` `{ name?, memberIds? }`；`DELETE /api/team/teams/:id` → 204（该团队共享的数据 `visibility` 降为 `private`）。写操作需 `members:manage`。
- 邀请：
  ```ts
  Invite = { id, role: 'admin'|'member'|'viewer', email: string|null, teamId: string|null, maxUses: number, uses: number, expiresAt: number, createdBy: string, createdAt: number, revoked: boolean }
  ```
  - `GET /api/team/invites` → `Invite[]`；`POST /api/team/invites` body `{ role, email?, teamId?, expiresInHours? /*1–720，默认 72*/, maxUses? /*1–100，默认 1*/ }` → 201 `{ invite: Invite, code: string, url: string }` —— `code`（`lxi_` + 32 hex）**只在创建时返回一次**，库里存哈希；`url = <publicOrigin>/#/join?code=<code>`。admin 不能邀请 owner。
  - `DELETE /api/team/invites/:id` → 204（撤销）
  - 公开接口（不需要 token）：`GET /api/auth/invites/:code` → `{ orgName, role, email: string|null, expiresAt }`；`POST /api/auth/invites/accept` body `{ code, email, password, name }` → 201 `LoginResult`。邀请指定了 email 时必须一致（400 `INVITE_EMAIL_MISMATCH`）。错误：404 `INVITE_INVALID`、410 `INVITE_EXPIRED`（过期/用完/撤销）、409 `EMAIL_TAKEN`。计入登录限流。

### 5.8 内核与 MCP（server 模式）
- 默认禁用：`POST /api/kernels/:id/install|update|uninstall`、`POST/PATCH /api/mcp/servers*`、`POST /api/mcp/servers/:id/refresh` → 403 `FEATURE_DISABLED`；kernel Agent `available=false`、`unavailableReason='服务器已禁用内核'`；对话中不加载 MCP 工具。
- `GET /api/team/security` → `{ allowKernels: boolean, allowMcp: boolean, warning: string }`（所有人可读）
- `PATCH /api/team/security` body `{ allowKernels?, allowMcp?, confirm: 'I_UNDERSTAND' }` → 同上（仅 owner；开启任一项必须带 `confirm`，否则 400 `CONFIRM_REQUIRED`）。`warning` 为醒目中文警告：“开启后，内核 / MCP 会以服务进程身份在服务器上执行命令，任何能对话的成员都可能借此读取服务器文件与密钥。仅在可信团队、隔离容器中开启。” 客户端开启前必须二次确认并展示该文字。开启后 MCP 增改仍仅 owner 可操作（server 模式没有原生确认框，以 owner 的显式操作代替）。记审计 `security.update`。

### 5.9 审计日志
```ts
AuditEntry = { id, at: number, userId: string|null, userName: string, action: string, entityType: string|null, entityId: string|null, summary: string, ip: string, meta: Record<string, unknown> }
```
- `GET /api/audit?userId=&action=&entityType=&entityId=&from=&to=&page=1&pageSize=50` → `{ items: AuditEntry[], total }`（`audit:read`；desktop 模式也可用，作为本地操作日志；`action` 支持前缀匹配，如 `customer.`）
- 记录的 action：`auth.login`、`auth.login_failed`、`auth.logout`、`auth.setup`、`auth.password_change`、`auth.password_reset`、`member.update`、`member.disable`、`invite.create`、`invite.revoke`、`invite.accept`、`team.create|update|delete`、`org.update`、`ownership.transfer`、`security.update`、`customer.create|update|delete|transfer|import`、`quote.create|update|delete`、`email_account.create|update|delete`、`email.send`、`data.export`、`data.import`、`provider.create|update|delete`、`settings.update`、`mcp.create|update|delete`、`kernel.install|update|uninstall`。不记录密码、token、邮件正文。

### 5.10 桌面端“连接团队服务器”（preload 契约）
`window.luluxAgent` 新增 `api` 对象（原有 `apiToken` 保留：本地模式为本次启动 token，远程模式为空串）：
```ts
window.luluxAgent.api = {
  mode: 'local' | 'remote',          // 本次窗口加载时的模式（切换会重新加载窗口）
  baseUrl: string,                   // 本地模式 ''（同源相对路径）；远程模式如 'https://lulux.example.com'（无尾斜杠）
  getSession(): Promise<{ mode: 'local'|'remote', baseUrl: string, token: string | null, user: User | null }>,
       // 本地模式 token = apiToken；远程模式为主进程保存的会话 token（safeStorage 加密落盘），未登录为 null
  setSession(session: { token: string, user: User } | null): Promise<void>,
       // 远程模式登录/接受邀请成功后调用以持久化；登出或收到 401/session.revoked 时传 null
  getConnection(): Promise<{ mode: 'local'|'remote', serverUrl: string | null, recentServers: string[] }>,
  connectRemote(serverUrl: string): Promise<{ ok: true, info: { mode, setupRequired, version } } | { ok: false, error: string }>,
       // 主进程先请求 <serverUrl>/api/auth/mode 校验（必须 https，或 http://localhost / 127.0.0.1 用于测试），
       // 成功后保存并重新加载窗口进入远程模式（需要重新登录，除非该服务器有已保存会话）
  useLocal(): Promise<void>          // 切回本地模式并重新加载窗口（远程会话保留，下次切回免登录）
}
```
- 客户端请求：`fetch(baseUrl + '/api/…', { headers: { Authorization: 'Bearer ' + token } })`。远程模式下 401 → 调 `setSession(null)` 并显示登录页。
- 远程模式主窗口 CSP 的 `connect-src` 为 `'self' <serverOrigin>`；其余同第 3 节变更记录里的 CSP。窗口导航仍只允许本地界面，指向服务器的网页链接（如邀请链接）交给系统浏览器。
- 浏览器（非桌面）直接访问团队服务器时，界面由服务器同源托管，`baseUrl=''`，token 存 `localStorage`。
- 加入团队页面路由：`/#/join?code=…`（客户端实现：先 `GET /api/auth/invites/:code` 展示组织与角色，再 `POST /api/auth/invites/accept`）。

### 5.11 部署
`Dockerfile`（多阶段、非 root）、`docker-compose.yml`（数据卷 `/data`）、`docs/deploy-server.md`（Caddy / Nginx TLS 反代示例）。环境变量：`LULUX_MODE=server`、`LULUX_PUBLIC_ORIGIN`、`LULUX_ETA_HOME=/data`、`LULUX_ETA_HOST=0.0.0.0`、`LULUX_ETA_PORT=51789`、`LULUX_TRUST_PROXY=1`、`LULUX_MASTER_KEY`（可选，64 hex；不设则在数据卷生成 `master.key`）、`LULUX_SESSION_IDLE_HOURS`、`LULUX_SESSION_MAX_DAYS`。

### 5.12 错误码
| HTTP | code | 场景 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | 缺少或无效 token |
| 401 | `SESSION_EXPIRED` | 会话过期 |
| 401 | `INVALID_CREDENTIALS` | 邮箱或密码错误 |
| 403 | `USER_DISABLED` | 账号已停用 |
| 403 | `FORBIDDEN` | 角色无权限 |
| 403 | `FEATURE_DISABLED` | server 模式下内核/MCP 未开启 |
| 403 | `SETUP_TOKEN_INVALID` | setup token 错误 |
| 403 | `PASSWORD_INCORRECT` | 改密时当前密码错误 |
| 403 | `CANNOT_MODIFY_OWNER` | admin 试图修改/重置 owner 或授予 owner |
| 404 | `NOT_AVAILABLE_IN_MODE` | 接口不属于当前模式 |
| 404 | `INVITE_INVALID` | 邀请码不存在 |
| 410 | `INVITE_EXPIRED` | 邀请过期 / 已用完 / 已撤销 |
| 400 | `INVITE_EMAIL_MISMATCH` | 邮箱与邀请不符 |
| 400 | `WEAK_PASSWORD` | 密码不符合规则 |
| 400 | `CONFIRM_REQUIRED` | 开启内核/MCP 未带确认 |
| 409 | `SETUP_REQUIRED` | 尚未初始化 owner |
| 409 | `SETUP_ALREADY_DONE` | 已初始化 |
| 409 | `EMAIL_TAKEN` | 邮箱已被注册 |
| 409 | `LAST_OWNER` | 不能移除最后一个 owner |
| 409 | `CANNOT_MODIFY_SELF` | 不能修改自己的角色/停用自己 |
| 409 | `CUSTOMER_HAS_RECORDS` | 客户名下有订单 / 收款 / 报价 / 商机，不能删除（5.5） |
| 403 | `NOT_GROUP_OWNER` | 只有群主能做：解散群聊、设置 / 取消 / 移出群管理员（6.10.3） |
| 400 | `OWNER_CANNOT_LEAVE` | 群主不能退出或被移出群聊（可以解散） |
| 403 | `NOT_YOUR_MESSAGE` | 多人群聊里编辑重发 / 重新生成别人的消息 |
| 409 | `OTHERS_REPLIED` | 多人群聊里该消息之后已有同事发言，不能编辑重发 / 重新生成 |
| 400 | `SERVER_MODE_ONLY` | desktop 模式不能邀请同事进群 |
| 400 | `USER_NOT_FOUND` | 邀请的账号不在本组织或已停用 |
| 400 | `GROUP_FULL` | 群里真人超过 20 位（含群主） |
| 429 | `LOGIN_RATE_LIMITED` | 登录/setup/邀请尝试过多（带 `Retry-After`） |

## 6. 内置内核（`builtin`，persona Agent 的 agent 循环）

审计与差距清单见 `docs/BUILTIN-KERNEL.md`。本节只写接口与事件。persona Agent（远航/拾序/洞见/织数/执笔）由当前 Provider 驱动；以下能力对 kernel 类 Agent（第三方 CLI）不适用，除非特别说明。

### 6.1 新增设置项（`GET /api/settings/schema` 同步返回）
| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kernelTools` | boolean | `'1'` | 通用内置工具（6.5）开关。`builtinTools='0'` 是**全部**内置工具的总开关（含业务工具，兼容 4.9） |
| `agent.maxTurns` | integer 0–500 | `'90'` | 内置内核一次回复最多几轮工具调用（对齐 Hermes `agent.max_turns`，0 = 不限制）；到上限后再发一轮不带工具（`tool_choice=none`）的请求让模型总结进度 |
| `agent.budgetPressure` | boolean | `'1'` | 用到 70% / 90% 时在当轮最后一条工具结果后附 `[BUDGET: 63/90. 27 iterations left. Start consolidating.]` / `[BUDGET WARNING: 81/90. Only 9 left. Respond NOW.]` |
| `maxToolRounds` | integer 1–50 | `'8'` | **已弃用**，服务端不再读取（由 `agent.maxTurns` 取代），仅为兼容旧客户端保留 |
| `parallelToolCalls` | boolean | `'1'` | 同一轮里的 read 类工具并发执行（write/MCP 工具始终按顺序逐个审批执行） |
| `llmMaxRetries` | integer 0–8 | `'3'` | 429/5xx/529/网络错误/首包超时的最多重试次数（指数退避 1s·2^n，≤30s，加抖动；遵守 `Retry-After` ≤60s） |
| `llmTimeoutSeconds` | integer 10–600 | `'120'` | 首包超时与流式空闲超时 |
| `maxContinuations` | integer 0–5 | `'2'` | 回复被长度截断或中途断流时自动续写的次数 |
| `contextCompaction` | boolean | `'1'` | 超出模型窗口时用模型把较早消息压缩为摘要；关闭时直接省略较早消息 |
| `reasoningEffort` | enum `off|low|medium|high` | `'off'` | Anthropic 扩展思考预算（2k/8k/24k token）/ OpenAI o 系列与 gpt-5 的 `reasoning_effort`；DeepSeek/Qwen 推理模型不受此影响，始终下发推理内容 |
| `autoTitle` | boolean | `'1'` | 首轮回复后后台生成会话标题 |
| `timezone` | string（IANA） | `''` | 系统提示里的日期与 `get_time` 默认时区，空 = 服务器时区；非法时区 400 `INVALID_SETTING` |
| `modelCapabilities` | string（JSON） | `''` | 能力覆盖：`{"模型名或*通配": {contextWindow?, maxOutput?, tools?, vision?, reasoning?: 'none'|'deepseek'|'qwen'|'openai'|'anthropic', streamUsage?, temperature?}}`；结构不对 400 |
| `modelPricing` | string（JSON） | `''` | 单价（每百万 token）：`{"模型名" 或 "Provider名/模型名"（可 * 通配）: {input, output, cacheRead?, cacheWrite?, currency: 'USD'|'CNY'|…}}`；不内置价格，未配置时费用为 null |

### 6.2 对话接口
- `POST /api/chat` body 新增可选字段：
  - `targetAgentIds?: string[]`：群聊指定本轮发言者（按数组顺序）。
  - `context?: { customerId?: string|null, quoteId?: string|null }`：把会话绑定到当前客户/报价（持久化，见 6.4）。客户/报价对当前用户不可见 → 404 `NOT_FOUND`（JSON，不打开 SSE）。
  - `attachments?: { path: string, name?: string }[]`：图片输入（见 6.2.1）。带附件时 `content` 可以为空（纯图片消息）；不带附件时 `content` 仍不能为空（400 `VALIDATION_ERROR`）。
- **发言顺序**（群聊）：`targetAgentIds` > 用户消息里的 `@名字` / `@agentId`（按出现顺序；代码块内不算）> 全体成员按顺序。某 Agent 的回复里 `@` 了本轮还没发言的成员时，该成员接着发言；每轮最多 成员数+2 次发言。
- `POST /api/chat/stop` body `{ sessionId }` → `{ stopped: boolean }`（没有进行中的对话为 false）。立即中止：上游请求、内核子进程、MCP/网页工具等待、审批等待。SSE 流随后发 `done`（`aborted:true`，有内容时）与 `stopped` 后结束。与 `POST /api/sessions/:id/cancel`（6.9）等价。**断开 fetch 不再中止对话**（运行由服务端持有，见 6.9）。**同一会话同时只有一个运行**：已有运行时再发 `/api/chat`、`/regenerate`、`/edit` → 409 `RUN_ACTIVE`（JSON，不打开 SSE，不写入新用户消息）。
- `POST /api/chat/regenerate` body `{ sessionId, messageId?, targetAgentIds? }` → SSE（同 `/api/chat`）。`messageId` 可为助手消息（重答它之前最近的用户消息）或用户消息；缺省 = 最后一条用户消息。该用户消息**之后**的消息全部删除后重新回答。错误（JSON）：404 `MESSAGE_NOT_FOUND`、400 `NOTHING_TO_REGENERATE`。
- `POST /api/chat/edit` body `{ sessionId, messageId, content, targetAgentIds?, attachments? }` → SSE。`attachments` 省略 = 沿用原消息的附件，`[]` = 去掉附件；文字与附件都为空时 400 `VALIDATION_ERROR`。把该用户消息**及之后**全部删除（分支截断，不保留旧分支），以新内容作为新的用户消息重跑。错误：404 `MESSAGE_NOT_FOUND`、400 `NOT_USER_MESSAGE`。被删消息相关的上下文摘要随之作废；已产生的 usage 记录保留（钱已花掉）。
#### 6.2.1 图片输入（`attachments`，迁移 15 `messages.attachments`）
- 流程：客户端先把图片上传到会话工作区（`POST /api/chat/sessions/:id/files`，客户端约定放 `uploads/`），再在 `/api/chat` 或 `/api/chat/edit` 里以相对路径引用。
- 校验（失败时在打开 SSE 之前 JSON 返回 400 `INVALID_ATTACHMENT`，数量超限为 400 `VALIDATION_ERROR`）：每条消息 ≤ 8 张；按文件头魔数识别 png / jpeg / webp / gif（扩展名不算数）；单张 ≤ 10 MB；路径必须在该会话工作区内且文件存在。
- 存储：`Message.attachments: MessageAttachment[]`（没有为 `[]`），`MessageAttachment = { kind: 'image', path /* 会话工作区相对路径 */, name, mime, size, width: number|null, height: number|null }`。库里只存引用；base64 只在请求上游时临时内联，从不落库。下载/缩略图用 `GET /api/chat/sessions/:id/files?path=`（带 token fetch → Blob）。
- 内置内核：OpenAI 兼容 → 文本 + `image_url`（data URL）内容块；Anthropic → base64 图片块放在文字之前（单张 > 5 MB 改为文字说明）。上下文只保留最近 3 条带图用户消息的图片、单次请求最多 16 张（新图优先）；超出预算时先省略较早消息的图片（`compaction` `kind:'images'`），再做文字摘要。被省略的图片在正文后注明，文件路径仍在。
- 模型没有 `vision` 能力（`modelCapabilities` 覆盖或按模型名默认）时不发图片内容块，消息正文里的工作区路径 / 页面 URL / 选择器作为文字兜底，并对每个内置内核成员在其 `agent` 事件之后发 `vision` 事件。
- 视觉降级：上游以 400 明确拒绝图片时，本进程记住该模型 `vision=false`，去掉图片重发，并发 `downgrade`（`what:'vision'`）。
- CLI 内核：提示词里给图片绝对路径；Codex 另加原生 `--image`，Claude Code 加 `--add-dir`，Gemini CLI / Qwen Code 加 `--include-directories`（允许读取图片所在目录）；不发 `vision` 事件。scoped 网关转发 Anthropic / Chat / Responses / Gemini 请求里的内联图片，目标模型不支持看图时去掉。
- `POST /api/chat/tool-decision` body 新增 `remember?: 'session'`：批准并在本会话内对同名工具不再询问（服务进程内记忆，重启失效）。只能审批自己可写会话里的请求（否则 403）。
- `GET /api/chat/pending?sessionId=` → `{ running: boolean, requests: PendingToolRequest[], allowedTools: string[] }`，断线重连/切回会话时用来恢复审批卡片与“停止”按钮状态。
  `PendingToolRequest = { requestId, sessionId, agentId, name, server, arguments, risk: 'read'|'write', builtin, toolKey, createdAt, expiresAt }`（审批默认 30 分钟超时按拒绝，`LULUX_APPROVAL_TIMEOUT_MS` 可调；客户端断开不算拒绝，见 6.9）。

### 6.3 SSE 事件（`/api/chat`、`/regenerate`、`/edit` 共用）
原有事件不变（`start`、`agent`、`delta`、`tool_request`、`tool_result`、`done`、`error`），新增字段与事件：
| event | data | 说明 |
| --- | --- | --- |
| `start` | 新增 `mode: 'send'|'regenerate'|'edit'`、`speakers: string[]`（本轮初始发言顺序）、`speakMode: 'targeted'|'mentioned'|'all'`、`capabilities: ModelCapabilities|null`；`tools[]` 新增 `risk`；模型不支持工具时 `tools=[]` | |
| `agent` | `total` 为当前已知发言数（被 @ 追加时会变大） | |
| `reasoning` | `{ agentId, text }` | 推理/思考增量（DeepSeek/Qwen `reasoning_content`、OpenAI 兼容 `reasoning`、正文开头的 `<think>`、Anthropic thinking）。可能出现在 `delta` 之前或工具轮次之间 |
| `retry` | `{ agentId, attempt, maxRetries, delayMs, code, status: number|null, message }` | 正在退避重试（`code` 同 6.7）；`code='EMPTY_REPLY'` 表示空回复重试 |
| `downgrade` | `{ agentId, what: 'tools'|'stream_usage'|'vision', model, message }` | Provider 明确不支持某参数，已自动去掉重发（本进程内记住该模型）；`vision` = 上游拒绝图片，已去掉图片重发（见 6.2.1） |
| `vision` | `{ agentId, supported: false, model, images }` | 本轮模型不支持看图：最新用户消息的 `images` 张图片只以文件路径文字送达。在该内置内核成员的 `agent` 事件之后发送（客户端收到 `agent` 会清掉运行提示） |
| `continuation` | `{ agentId, reason: 'length'|'interrupted'|'reasoning_only', attempt }` | 自动续写，后续 `delta` 直接拼接在已有文本后 |
| `tool_request` / `tool_result` | 新增 `toolCallId` | 同一轮多个 read 工具会并发，`tool_result` 顺序可能与 `tool_request` 不同，请按 `requestId` 对应 |
| `tool_limit` | `{ agentId, reason: 'max_turns' \| 'loop_guard', used, maxTurns, maxToolRounds, tool?, repeats? }` | 达到工具轮数上限（`max_turns`），或同一工具相同参数连续 3 次被拦截（`loop_guard`）；接下来是不带工具的收尾回答（`maxToolRounds` 与 `maxTurns` 同值，兼容旧客户端） |
| `budget` | `{ agentId, level: 'caution' \| 'warning', used, maxTurns }` | 已向模型注入预算提醒（70% / 90%） |
| `artifact` | `{ agentId, artifact: { id, title, language, filename, path, size } }` | `create_artifact` 生成产物；同时会有一段 `delta` 把产物以 ```` ```language ```` 代码块追加进正文，现有产物面板按代码块提取即可显示；`path` 为工作区相对路径 |
| `compaction` | `{ agentId, kind: 'summary', ok, summarizedMessages, tokensBefore, tokensAfter, budget }` 或 `{ agentId, kind: 'tool_results', shrunk }` 或 `{ agentId, kind: 'images', droppedImages }` | 上下文已压缩（`ok=false` 表示摘要失败、较早消息被直接省略；`images` = 先省略了较早消息里的 `droppedImages` 张图片） |
| `done` | `{ message, aborted?: true }` | 用户停止时也会对已生成部分发 `done`（`aborted:true`，`message.finishReason='aborted'`） |
| `error` | 新增 `retryable: boolean`、`status: number|null`、`partialMessageId: string|null` | 出错前已生成的内容会落库（`finishReason='error'`），id 在 `partialMessageId` |
| `stopped` | `{ sessionId, reason: 'user' }` | 用户调用了 `/api/chat/stop` 或 `/api/sessions/:id/cancel`；流随即结束 |
| `replayed` | `{ lastSeq }` | 只出现在 `GET /api/sessions/:id/stream`：缓存事件回放完毕，之后是实时事件（不带 `id:`，不占 seq） |

每个运行事件带 SSE `id: <seq>` 行（从 1 递增，一个运行内连续）；断线后用 `?after=<seq>` 或 `Last-Event-ID` 续接（6.9）。流里可能出现 `: ping` 注释行心跳（每 15 秒），按 SSE 规范忽略即可。

`/api/events` 新增：`session.title` `{ sessionId, title }`（自动标题生成完成；只推给能看到该会话的用户）；`session.run` `{ sessionId, running, runId, status, lastSeq }`（会话运行开始 / 结束，见 6.9；只推给会话负责人 + 群聊真人成员）。

### 6.4 消息、会话上下文、导出
- `Message` 新增：`reasoning: string`（无则 `''`）、`usage: MessageUsage | null`、`finishReason: 'stop'|'length'|'tool_limit'|'aborted'|'error'|'interrupted'|'streaming'|null`（用户消息与旧消息为 null；`length` 表示续写次数用完仍被截断；`streaming` = 运行中逐步落库的草稿，`interrupted` = 服务关闭 / 崩溃时被中断，见 6.9）。
  `MessageUsage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, estimated: boolean, calls: number, cost: number|null, currency: string|null }`——本条回复所有上游调用（工具轮次、续写）的合计；`inputTokens` 含缓存命中部分；`estimated=true` 表示至少一次调用上游没返回 usage、按字符估算；多币种或有未定价调用时 `cost=null`。kernel Agent 的消息 `usage=null`。
- `GET /api/chat/sessions/:id/context` → `{ customerId: string|null, quoteId: string|null }`；`PUT` 同路径 body 同结构（传 null 解绑）→ 同结构。绑定后每轮系统提示注入：客户资料、联系人、最近 5 条跟进、报价摘要；报价的条款与明细（只给报价时自动带上其客户）。
- `GET /api/chat/sessions/:id/export?format=markdown&reasoning=1&tools=1&usage=1` → `text/markdown`（`Content-Disposition: attachment; filename*=UTF-8''<标题>.md`）。客户端 fetch → Blob 下载。
- `GET /api/chat/sessions/:id/messages/:messageId/markdown` → 该消息正文（`text/markdown`，即“复制为 Markdown”）；`?full=1` 附带工具调用、推理与 usage。普通“复制”直接用 `message.content` 即可。

### 6.5 内置工具（统一注册表）
业务工具（4.9）与通用工具在同一注册表 `services/tools/registry.ts`，统一走 4.9 的审批规则（read 直接执行；write 按会话权限级别 6.11：`ask` 需确认、`full` 直接执行、`read` 不提供；MCP 工具一律按 write 处理），`server` 字段均为 `'LULUX'`、`builtin=true`。
| 工具 | 风险 | 参数 → 结果 |
| --- | --- | --- |
| `fetch_url` | read | `{ url, maxChars? (1000–100000，默认 20000) }` → 标题 + 纯文本（链接保留为 `[文字](地址)`）。只 http/https；拒绝 localhost/内网/链路本地/云元数据地址（含 DNS 解析结果与每一跳重定向，最多 5 跳）；走设置里的代理；20 秒、2 MB 上限；非文本类型不读取 |
| `web_search` | read | `{ query, count? (1–10) }` → `{ results: {title,url,snippet}[] }`。**仅在配置了搜索服务时出现**（6.6） |
| `workspace_list` | read | `{ path?='.', recursive? }` → `{ entries: {path,type,size,modifiedAt}[], truncated }` |
| `workspace_read` | read | `{ path, offset?, limit? }` → `{ path, size, binary, content, truncated }`（≤1 MB） |
| `workspace_write` | write | `{ path, content, append? }` → `{ path, bytes, created }`（单文件 ≤2 MB，每会话 ≤50 MB） |
| `create_artifact` | read | `{ title, language: html|svg|markdown|json|csv|text|javascript|typescript|python|css|sql|yaml|xml|shell, content }` → 写入 `artifacts/<标题>.<扩展名>` 并发 `artifact` 事件 |
| `get_time` | read | `{ timezone? }` → 当前时间；`{ time: 'YYYY-MM-DD HH:mm'|'HH:mm', from?, to?: string[] }` → 换算 |
| `calculator` | read | `{ expression }` → `{ result }`（自写解析器，无 eval） |
- 工作区沙箱：`<dataDir>/workspace/<sessionId>/`，只接受相对路径；绝对路径、盘符、`..`、NUL、指向沙箱外的符号链接一律拒绝（以工具失败结果返回给模型）。
- `GET /api/chat/tools` → `{ tools: { name, description, risk, group: 'business'|'core', inputSchema }[] }`（当前实际可用的内置工具）。

#### 6.5.1 按需工具集（设置 `toolLoading`，默认 `auto`）
- `auto`：每次上游请求只带**常驻核心工具**（`tool_search`、`search_customers`、`get_customer`、`get_time`、`calculator`、`skill_view`）+ **本轮用户消息意图命中的工具集** + **本会话历史里用过的工具**；其余工具由元工具 `tool_search` 动态加载，下一次上游请求即带上。`all`：旧行为，每次带全部工具。
- 工具集 id：`crm`（建/改客户、跟进、负责人）、`quotes`（报价与 PI）、`email`（搜/读邮件、草稿、从邮件建客户）、`tasks`、`deals`（商机与漏斗）、`orders`（订单、出运、收款、逾期应收）、`web`（fetch_url / web_search）、`files`（工作区、产物、run_skill_script）、`skills`、`mcp`（MCP 配置工具）、`mcp:<服务器名>`（外部 MCP 服务器的工具；用户消息提到服务器名或工具名时自动加载）。命中预加载技能时同时加载 `files`。
- `tool_search`（read，`group='core'`，不出现在 `GET /api/chat/tools`）：`{ toolsets?: string[], query?: string }` → `{ loaded: {name, description}[], newlyLoaded, unknownToolsets?, hint }`。
- 只影响**发送给模型的工具定义**：模型调用任何已注册且对当前用户可用的工具都照常执行，RBAC / 审批 / 审计不变。SSE `start.tools` 仍列出全部可用工具（含 `tool_search`）。
- 实测（45 个内置工具，未配置搜索 / MCP）：全部 24,270 B（估算约 6.9k token）；闲聊 3,674 B（−84.9%）；命中一个业务意图 6.4–7.2 KB（−70% ~ −74%）。`test/toolsets.test.ts` 断言 ≥ 60%。
- **同轮读写顺序**：同一轮里只要有 write 工具（或 MCP 工具），整轮按模型给出的顺序串行执行；全是 read 时才并发（`parallelToolCalls`）。“改了再查”不再读到旧数据。

### 6.6 联网搜索配置
- `GET /api/chat/search-config` → `{ provider: 'none'|'tavily'|'brave'|'searxng'|'bing', endpoint, maxResults, hasApiKey, apiKeyPreview, apiKeyError, enabled, providers: { id, name, needsKey, needsEndpoint, defaultEndpoint }[] }`
- `PUT /api/chat/search-config` body `{ provider, endpoint?, apiKey?, maxResults? (1–10) }` → 同上（需要 `settings:write`）。`apiKey` 缺省保持、`''` 清除；加密存储，不回传明文。SearXNG 必须填 `endpoint`（自建实例根地址，需开启 JSON 输出）；Bing 为兼容端点（微软官方 Bing Search API 已于 2025-08 停止服务，可填兼容的代理/网关地址）。

### 6.7 用量与能力查询
- `GET /api/usage?from=&to=&sessionId=&providerId=&model=&agentId=&purpose=&groupBy=day|model|provider|session|agent|purpose&tzOffsetMinutes=&scope=all`
  → `{ totals: UsageTotals, groups: (UsageTotals & { key, label })[] }`
  `UsageTotals = { calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, estimatedCalls, cost: Record<currency, number>, unpricedCalls }`。`from/to` 为毫秒时间戳；`groupBy=day` 按 `tzOffsetMinutes`（客户端传 `-new Date().getTimezoneOffset()`）切日；`purpose`：`chat|continuation|compaction|title|completion`（`completion` = 邮件 AI 草稿/判定等一次性调用）。默认只统计自己的；admin/owner 加 `scope=all` 看全组织。
- `GET /api/usage/records?…同上筛选…&page=1&pageSize=50` → `{ items: UsageRecord[], total }`，`UsageRecord = { id, sessionId, messageId, agentId, providerId, providerName, model, purpose, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, estimated, cost, currency, ownerId, createdAt }`（费用按记录时的单价固化）。
- `GET /api/chat/capabilities?providerId=|model=` → `{ model, capabilities: ModelCapabilities, price: ModelPrice|null }`
  `ModelCapabilities = { contextWindow, maxOutput, tools, vision, reasoning: 'none'|'deepseek'|'qwen'|'openai'|'anthropic', streamUsage, temperature }`。

错误码（SSE `error.code`；`completeText` 类 JSON 接口仍为 502 `UPSTREAM_*`）：`UPSTREAM_RATE_LIMITED`（429）、`UPSTREAM_OVERLOADED`（503/529）、`UPSTREAM_ERROR`（5xx/其他）、`UPSTREAM_UNREACHABLE`（网络）、`UPSTREAM_TIMEOUT`、`UPSTREAM_AUTH`（401/403，Key 错误）、`UPSTREAM_BAD_REQUEST`、`UPSTREAM_NOT_FOUND`（模型名错误等）、`CONTEXT_TOO_LONG`、`EMPTY_REPLY`。

### 6.8 客户端需要配合（`packages/client`，服务端已就绪）
1. **推理折叠块**：处理 `reasoning` 事件，流式显示在回复上方的可折叠区（默认折叠，流式中显示“思考中…”）；历史消息用 `message.reasoning`。
2. **usage 显示**：消息尾部小字 `输入 x（缓存 y）/ 输出 z · 约 ¥0.0027`（`estimated` 时加“估”）；设置页加“用量”页（`/api/usage` 按天/模型分组 + 明细表），以及 `modelPricing` 单价编辑（JSON 或表格）。
3. **停止按钮**：生成中把发送按钮换成“停止”→ `POST /api/sessions/:id/cancel`（旧：`/api/chat/stop`）；收到 `done.aborted` 显示“已停止”标记；打开运行中的会话时接上 `GET /api/sessions/:id/stream`（6.9），旧服务端没有 `session.running` 时退回 `GET /api/chat/pending` 轮询。
4. **重新生成**：最后一条助手消息（或任一助手消息）上的“重新生成”→ `/api/chat/regenerate`，先在本地删掉该用户消息之后的消息再渲染新流。
5. **编辑重发**：用户消息上的“编辑”→ 输入框编辑 → `/api/chat/edit`；提示“之后的消息将被删除”。
6. **@agent**：群聊输入框输入 `@` 弹出成员列表，插入 `@名字`；也可在发送时传 `targetAgentIds`。`start.speakers` 可用于预先显示“将由谁回答”。
7. **复制 / 导出**：消息“复制”用 `message.content`（或 `…/markdown`）；会话菜单“导出 Markdown”→ `/export`。
8. **其他事件**：`retry` 显示“正在重试（第 n 次，x 秒后）”；`continuation` 可不显示或小字“自动续写”；`tool_limit` 小字提示；`compaction` 小字“较早的对话已压缩”；`artifact` 可直接打开产物面板定位到新产物；`/api/events` 的 `session.title` 更新侧栏标题。
9. **审批卡片**：增加“本会话始终允许”（`remember:'session'`）；同一轮可能同时出现多个只读工具卡片（自动执行）。
10. **设置页**：6.1 的新设置项；“联网搜索”配置（6.6）；会话头部可显示/切换“当前客户/报价”（6.4 `context`）。

### 6.9 服务端持有的会话运行（关窗 / 刷新不停止）
一次对话（单聊；群聊含主管规划 → 成员 → 汇总）由服务端的运行管理器（`services/chat/run-registry.ts`）持有，与发起它的 HTTP 响应无关。云端（server）模式与本机（desktop）模式行为相同。
- **生命周期**：`/api/chat`、`/regenerate`、`/edit` 校验通过后创建运行（`runId = run_…`），发起请求的 SSE 只是第一个订阅者。客户端断开、刷新、关窗、切会话都**不会**中止运行。只有以下情况会中止：显式取消（`POST /api/sessions/:id/cancel` 或 `/api/chat/stop`）、删除会话（删除前先停止，最多等 3 秒）、服务关闭。定时任务 / 工作流节点的运行也登记在这里（同样占用会话，同样可接上 / 取消）。
- **一次一个**：同一会话已有运行时再发起 → 409 `RUN_ACTIVE`。
- **事件缓存**：运行期间的全部 SSE 事件按 `seq` 缓存在内存（每个运行最多 50,000 个，超出丢弃最早的）；运行结束后缓存再保留 2 分钟供尾部续接。
- **逐步落库**：每位发言者第一段输出到达时插入一条助手草稿消息（`finishReason='streaming'`），之后约每 800 ms 更新正文 / 推理 / 工具轮次；结束时原地改成最终状态（消息 id 不变，`done.message.id` 即草稿 id）。草稿不进模型上下文。中止时没有任何内容的草稿会删除。
- **服务关闭**：SIGINT / SIGTERM / 桌面端关闭 stdin 时先中止全部运行（最多等 2 秒），已输出部分按 `finishReason='interrupted'` 落库，运行状态为 `interrupted`。进程被强杀时，下次启动把残留的 `streaming` 草稿改为 `interrupted`。
- **权限**：所有接口按会话可见性校验（看不到的会话 404；server 模式下可见 = 会话负责人 + 群聊真人成员，见 6.10）；取消 / 审批需要会话可写（能看不能改，如团队 viewer → 403 `FORBIDDEN`）。
- **无人接上时的审批**：运行中的工具审批等待最长 30 分钟（`LULUX_APPROVAL_TIMEOUT_MS`，默认 1,800,000）；期间没有客户端接上也不会自动拒绝。客户端重新接上（`/stream?after=0` 回放 `tool_request`，或 `GET /api/chat/pending`）后审批卡片照常显示、可以批准 / 拒绝。超时仍无人决定才按拒绝处理。

接口：
| 接口 | 说明 |
| --- | --- |
| `GET /api/sessions` / `GET /api/sessions/:id` | 每个 `Session` 新增 `running: boolean`、`activeRunId: string \| null`；`GET /api/sessions/:id` 另返回 `run: SessionRun \| null`（进行中或 2 分钟内刚结束的运行） |
| `GET /api/sessions/:id/stream?after=<seq>` | SSE：先回放 `seq > after` 的缓存事件（`after` 缺省 0；也接受 `Last-Event-ID` 头），回放完发 `replayed`，再推实时事件，运行结束时关闭。没有运行（也没有刚结束的）时返回空流立即关闭 |
| `POST /api/sessions/:id/cancel` | 取消进行中的运行 → `{ stopped: boolean, runId: string \| null }`；流随后发 `done`（`aborted:true`）与 `stopped` |
| `GET /api/sessions/:id/run` | `{ running, activeRunId, run: SessionRun \| null }` |
| `GET /api/chat/runs` | 当前用户可见的进行中运行 `{ runs: SessionRun[] }`（桌面端关窗前确认用） |
| `GET /api/chat/runs/count` | 进行中运行的数量 `{ count }`（桌面主进程关窗前确认用；desktop 模式有本机账户时也不需要本机会话，仍需 API token） |

`SessionRun = { id, sessionId, status: 'running'|'completed'|'cancelled'|'failed'|'interrupted', source: 'chat'|'internal', startedAt, endedAt: number|null, lastSeq }`。

客户端（`packages/client`，已实现）：打开 `running:true` 的会话时接上 `/stream?after=0` 实时渲染（草稿消息由回放重建，不重复显示）；本窗口持有的流意外断开而服务端仍在运行时，从最后的 `seq` 续接（最多 5 次）；`/api/events` 的 `session.run` 更新侧栏“运行中”标记，正在看的会话开始运行时自动接上；停止按钮调 `/cancel`；发送遇到 409 `RUN_ACTIVE` 时把内容退回输入框并接上进行中的运行。

桌面端（本机模式）：本地服务是 Electron 的子进程。Windows / Linux 上关窗即退出应用，还有运行时先弹确认（“继续运行 / 仍然关闭”）；仍然关闭则按“服务关闭”处理（已输出部分标记 interrupted）。macOS 关窗不退出应用，运行继续，重新打开窗口即可看到进度。连接云端 LULUX 时关窗不影响服务器上的运行。

### 6.10 多人群聊（团队服务器模式，迁移 19 `session_participants`）
群聊（`kind:'group'`）除了 Agent 成员，还可以邀请同组织的**真人同事**一起聊。单聊（`kind:'single'`）只有本人。desktop 模式没有同事，不能邀请（400 `SERVER_MODE_ONLY`）。

#### 6.10.1 数据结构
```ts
ParticipantRole = 'owner' | 'admin' | 'member'   // owner = 群主（创建者，即 Session.ownerId）；admin = 群管理员；member = 普通成员
SessionParticipant = { userId: string, name: string, role: ParticipantRole, joinedAt: number }
Session += {
  participants: SessionParticipant[],   // 群聊的真人成员，群主排第一；单聊为 []。多于一人即“多人群聊”
  myRole: ParticipantRole,              // 当前请求者在本会话里的角色（列表 / 详情按请求者计算）
}
Message += {
  senderUserId: string | null,          // 用户消息由谁发出（账号 id）；助手 / 系统消息为 null。迁移 19 把旧用户消息回填为会话负责人
  senderName: string | null,            // 用户消息发言人的显示名；desktop 本机用户或查不到时为 null
}
```
- 客户端：`senderUserId === 自己` 的用户消息靠右，其他同事的靠左并显示 `senderName`；Agent 回复照旧。
- 多人群聊里，交给模型的历史用户消息带 `【发言人】` 前缀，Agent 能分清谁说的；单人会话不加。导出 Markdown / 单条消息 Markdown 的发言人用 `senderName`（缺省“用户”）。

#### 6.10.2 接口
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sessions/colleagues` | → `{ users: { id, name, email }[] }`：可邀请进群的同事（同组织、未停用、不含自己）；desktop 模式为 `[]` |
| POST | `/api/sessions` | 新增可选 `userIds: string[]`（≤20）：建群时一起邀请的同事；只能和 `kind:'group'` 一起用，单聊带同事 → 400 `SESSION_KIND` |
| GET | `/api/sessions/:id/participants` | → `{ participants: SessionParticipant[] }`（成员可读） |
| POST | `/api/sessions/:id/participants` | body `{ userIds: string[] /*1–20*/, role?: 'admin'|'member' }` → 201 `{ added: string[], session: Session }`；群主或群管理员；`role:'admin'` 仅群主。已在群里的忽略 |
| PATCH | `/api/sessions/:id/participants/:userId` | body `{ role: 'admin'|'member' }` → `{ session }`；仅群主 |
| DELETE | `/api/sessions/:id/participants/:userId` | → 204。移出成员（群主 / 群管理员；群管理员不能移出其他管理员）；`:userId` 为自己或 `me` = **退出群聊**；群主不能退出 / 被移出 |
| GET | `/api/sessions/:id/events` | 会话实时事件（SSE），见 6.10.4 |

#### 6.10.3 权限
| 操作 | 群主 | 群管理员 | 成员 |
| --- | --- | --- | --- |
| 看消息、发消息、停止、审批、上传（需 `data:write`） | ✓ | ✓ | ✓ |
| 改标题 / 群名 / Agent 成员 / 主管（`PATCH /api/sessions/:id`） | ✓ | ✓ | ✗ 403 `FORBIDDEN` |
| 邀请 / 移出普通成员 | ✓ | ✓ | ✗ 403 `FORBIDDEN` |
| 设置 / 取消群管理员、移出群管理员 | ✓ | ✗ 403 `NOT_GROUP_OWNER` | ✗ |
| 删除会话（解散群聊，`DELETE /api/sessions/:id`） | ✓ | ✗ 403 `NOT_GROUP_OWNER` | ✗ 403 `NOT_GROUP_OWNER` |
| 退出群聊 | ✗ 400 `OWNER_CANNOT_LEAVE` | ✓ | ✓ |
- 编辑重发 / 重新生成（`/api/chat/edit`、`/api/chat/regenerate`）在多人群聊里只能针对**自己发的**用户消息（否则 403 `NOT_YOUR_MESSAGE`）；该消息之后已有别的同事发言时不允许（会截掉他们的消息）→ 409 `OTHERS_REPLIED`。单人会话不受影响。
- 邀请对象必须是本组织未停用的账号（400 `USER_NOT_FOUND`）；一个群最多 20 位真人（含群主，400 `GROUP_FULL`）。
- 不是成员的人访问会话一律 404 `NOT_FOUND`（包括 admin / owner）。

#### 6.10.4 实时事件
- `GET /api/sessions/:id/events` → `text/event-stream`（用 `fetch` 读流，同 4.8）。只推**已落库**的事件，不转发流式 token：发起人自己的流照旧走 `POST /api/chat`，其他成员收到落库的消息与运行状态 `run`，需要实时输出时用 `GET /api/sessions/:id/stream`（6.9）接上运行流。运行中的草稿消息（`finishReason:'streaming'`）**不**推 `message`；草稿定稿（`streaming` → 最终状态）时以同一消息 id 推一次 `message`，客户端按 id upsert。
  | event | data |
  | --- | --- |
  | `ready` | `{ sessionId, at, running, activeRunId }`（订阅成功，附当前运行状态） |
  | `ping` | `{ at }`（每 25 秒） |
  | `message` | `{ sessionId, message: Message }`（任一成员的用户消息或 Agent 回复落库 / 定稿，含后台运行写入的消息） |
  | `run` | `{ sessionId, running, runId, status, lastSeq }`（运行开始 / 结束，任一成员发起；与 `/api/events` 的 `session.run` 同一载荷） |
  | `session` | `{ sessionId, session: Session }`（群设置或成员变化后的最新会话） |
  | `removed` | `{ sessionId }`（自己被移出 / 退出 / 群被解散，随后服务端断开） |
  | `session.revoked` | `{}`（登出 / 被停用，随后断开） |
- `/api/events`（4.8）新增，均只推给会话负责人 + 真人成员：
  | event | data |
  | --- | --- |
  | `session.message` | `{ sessionId, messageId, role, senderUserId, preview, createdAt }`（仅多人群聊；侧栏刷新 / 未读） |
  | `session.updated` | `{ sessionId }`（群设置或成员变化；被邀请的人借此看到新群） |
  | `session.removed` | `{ sessionId }`（被移出或群被解散；侧栏去掉该会话） |
  | `session.run` | `{ sessionId, running, runId, status, lastSeq }`（6.9；同样只推给会话负责人 + 真人成员） |
- **运行与群成员**（6.9 × 6.10）：群里的真人成员（群主 / 管理员 / 成员）都能接上运行流（`/stream`）、查看运行（`/run`、`/api/chat/runs`）、在 `data:write` 下取消运行与审批工具；团队 viewer 能看能接上，取消 → 403 `FORBIDDEN`；非成员一律 404。

### 6.11 会话权限级别（迁移 20 `sessions.permission_level`）
每个会话一个权限级别，作用于会话里的全部 Agent（群聊里所有成员；内置内核与全部 CLI 内核）：

| 级别 | 中文 / English | 内置内核与 LULUX 工具 | CLI 内核自带工具 |
| --- | --- | --- | --- |
| `read` | 仅可查看 / Read only | write 工具（业务写、工作区写、MCP 工具、skill 脚本、自配置）**不提供给模型**（记忆工具 `memory_*` 也不例外：`read` 下同样不提供，6.12；用户经设置页 / REST 管理自己的记忆不受级别影响）；万一被调用直接拒绝（结果文本说明“仅可查看”），从不弹审批 | 只读参数（见下表） |
| `ask` | 需审批 / Ask for approval | write 工具先发 `tool_request`（`auto=false`）等 `POST /api/chat/tool-decision`；“本会话始终允许”照常（MCP 增删改不可记忆） | Claude Code 经 LULUX 审批卡片；其他 CLI 无法在后台交互审批 → 自带工具退回只读（选择器给提示），LULUX MCP 写工具仍弹卡片 |
| `full` | 完全权限 / Full access | 直接执行，不再询问；**例外**：组织级配置变更 `mcp_add` / `mcp_update` / `mcp_remove`（`ToolSpec.orgLevel=true`：改动全组织共享的 MCP 配置并在主机上启动命令）仍逐次确认（命令型仍走原生确认）。其余 `approval='always'` 工具（`run_skill_script`、`skill_install`、`skill_create`、`skill_update`）在 `full` 下直接执行 | 写 / 执行参数，工作目录为会话工作区 `<dataDir>/workspace/<sessionId>/` |

- **会话字段**：`Session.permissionLevel: 'read'|'ask'|'full'|null`；`null` = 跟随全局默认（改默认会影响所有未单独设置的会话）。`POST /api/sessions` 可带 `permissionLevel`；`PATCH /api/sessions/:id { permissionLevel }`（群主 / 群管理员；`null` 恢复跟随默认；非法值 400；工作流隐藏会话 409）。级别在每次工具调用时重新读取，运行中切换对之后的调用生效；工具列表按发言开始时的级别。
- **全局默认**：设置 `defaultPermissionLevel`（read|ask|full，默认 ask），取代旧设置 `toolApproval`。旧键保留并双向同步：`PATCH { toolApproval:'auto' }` ⇒ `defaultPermissionLevel='full'`，`'ask'` ⇒ `'ask'`；`PATCH { defaultPermissionLevel }` ⇒ `toolApproval = full ? 'auto' : 'ask'`。迁移 20 把旧库的 `toolApproval` 换算成 `defaultPermissionLevel`（ask→ask，auto→full；已有新键不覆盖）。
- **SSE**：`start` 事件新增 `permissionLevel`（本次运行生效的级别，已按上限截断）；`start.tools` 在 `read` 下只含 read 工具（及记忆工具，6.12）。
- **`GET /api/permissions`** → `{ levels:['read','ask','full'], defaultLevel, cap, capsEnabled, kernels: { [kernelId]: { ask: 'card'|'readonly' } } }`。`cap` 是当前用户的上限（desktop 恒为 `full`）；`kernels[id].ask='card'` 表示“需审批”下该 CLI 的自带工具经 LULUX 审批卡片（目前只有 scoped 模式且注入了 LULUX MCP 的 Claude Code），`readonly` 表示退回只读。
- **团队上限（server 模式）**：`GET /api/team/permission-caps`、`PATCH /api/team/permission-caps`（`members:manage`；desktop 404 `NOT_AVAILABLE_IN_MODE`）。结构 `{ roles: { owner:'full', admin, member, viewer }, members: { [userId]: level } }`；默认 admin/member `full`、viewer `read`；owner 恒为 `full`（`roles.owner` 不可改，400）。`PATCH { roles?: { admin?, member?, viewer? }, members?: { [userId]: level|null } }`（`null` 删除成员覆盖），写审计 `permission.caps`。生效级别 = min(会话级别或默认, 当前用户上限, 会话负责人上限)：已存的高级别在运行时被截断；`POST/PATCH /api/sessions` 请求超过上限的级别 → 403 `PERMISSION_LEVEL_EXCEEDED`（不做部分修改）。选择器把超出的级别置灰。
- **工作流 / 定时任务**：节点 `allowWrite` 语义不变（非交互审批由它自动答复），但不能超过运行者（负责人）的上限：上限 `read` 时 `allowWrite=true` 也按 false 处理。节点隐藏会话的级别：允许写 → `ask`（CLI 自带工具仍只读；LULUX 工具与 Claude Code 权限请求由 allowWrite 自动批准），否则 `read`。定时对话沿用会话级别。
- **LULUX MCP 桥（CLI 内核，§10）**：`tools/list` 在 `read` 下只列 read 工具（记忆工具也不列，6.12），`tools/call` 写工具直接返回“仅可查看”错误（不发 `tool_request`）；`ask` 弹卡片；`full` 直接执行。Claude Code 在 `ask` 下额外看到 `approval_prompt` 工具（由 `--permission-prompt-tool mcp__lulux__approval_prompt` 调用，输入 `{tool_name, input, tool_use_id?}`）：发 `tool_request`（`name`=Claude 工具名如 `Bash`，`server`='Claude Code'，`via='permission_prompt'`，`toolKey='claude-code:<tool>'`，可“本会话始终允许”），批准返回文本 `{"behavior":"allow","updatedInput":…}`，拒绝 / 超时 / 停止返回 `{"behavior":"deny","message":…}`；轨迹记一条该工具。
- **CLI 参数映射**（2026-10-21 按已安装 CLI 的 `--help` 核实：claude 2.1.306、codex 0.163.0、gemini 0.65.0、qwen 0.25.3、grok 1.0.x、pi 1.3.x；hermes 按上游 `hermes_cli/_parser.py` 与 `toolsets.py`）：

  | 内核 | read | ask | full |
  | --- | --- | --- | --- |
  | Claude Code | `--permission-mode dontAsk --tools Read,Grep,Glob` | `--permission-mode default --permission-prompt-tool mcp__lulux__approval_prompt`（无 LULUX MCP 时退回 read） | `--permission-mode bypassPermissions --allow-dangerously-skip-permissions` |
  | Codex | `exec --sandbox read-only` | 退回 read | `exec --sandbox workspace-write`（exec 审批策略 never） |
  | Gemini CLI | `--approval-mode plan` | 退回 read | `--approval-mode yolo` |
  | Qwen Code | `--approval-mode plan` | 退回 read | `--approval-mode yolo` |
  | Grok | `--tools read_file,list_dir,grep --always-approve`，`GROK_WRITE_FILE=0` | 退回 read | 去掉 `--tools`（默认工具集）+ `--always-approve`，`GROK_WRITE_FILE=1` |
  | Hermes | `--toolsets skills[,lulux]` | 退回 read（oneshot 自动批准，无交互审批） | `--toolsets skills,file,terminal[,lulux] --yolo` |
  | Pi | `--tools read,grep,find,ls[,mcp__lulux__*]` | 退回 read（Pi 没有审批机制） | `--tools read,bash,edit,write,grep,find,ls[,mcp__lulux__*]` |

  scoped 与 global 两种模式都套用；`read` 的工作目录仍是 `<kernels>/<id>/workspace`，`ask`（实际生效时）与 `full` 为会话工作区。

### 6.12 长期记忆（每个账号的用户画像与记忆，迁移 21）
LULUX 为**每个账号**保存一份长期记忆，跨会话生效（设计参考 Hermes Agent 的 `MEMORY.md` / `USER.md` + 字符预算 + 冻结快照，代码为 LULUX 独立实现）。

#### 6.12.1 数据结构
```ts
MemorySection = 'profile' | 'notes'          // profile = 用户画像（用户是谁、公司、主营产品、目标市场、风格偏好）；notes = 记忆（其他长期事实与约定）
MemorySource  = 'user' | 'agent' | 'auto' | 'import'   // 设置页手动 / Agent 用工具写入 / 自动提取 / 数据导入
MemoryEntry = { id, section: MemorySection, content: string, source: MemorySource, sourceSessionId: string | null, createdAt, updatedAt }
MemoryState = {
  enabled: boolean, autoExtract: boolean,    // 账号自己的开关（默认都开），不是组织级 settings
  groupMemory: boolean,                      // 群聊中使用我的记忆（默认关，迁移 23 memory_prefs.group_memory）
  entryMax: 500,                             // 单条上限（字符）
  profile: { entries: MemoryEntry[], used: number, limit: 2000 },
  notes:   { entries: MemoryEntry[], used: number, limit: 4000 },   // used = 该分区条目正文字符数合计
}
```
- **隔离**：只按当前账号（server 模式 = 登录用户；本机模式 = `local`）读写，没有按别人 id 访问的入口；admin / owner 也读不到别人的记忆，用别人的条目 id 改 / 删一律 404。
- **写入检查**（所有入口：接口、Agent 工具、自动提取、导入）：删掉隐藏字符（全部 `\p{Cf}`、Unicode Tag U+E0000–E007F、变体选择符、U+180E）、合并空白；检查时先 NFKC 并统一各种连字符，隐藏字符分别按“换成空格”和“直接删掉”两种形态各查一遍，原文也查；存量条目进快照前再清洗一次，清洗后不合格的不进快照（不删除）；拒绝疑似凭据（API Key / Token / JWT / 私钥 / 带口令的连接串 / “密码：…”“登录密码 Xxx123”“password is …” / 中文数字卡号 / 通过 Luhn 校验的银行卡号 / CVV / 32 位以上高熵串）与提示注入（“忽略之前的指令”、要求外发数据等）→ 422 `MEMORY_REJECTED`（不回显原文）；单条超过 500 字 → 400 `MEMORY_ENTRY_TOO_LONG`；分区合计超出预算 → 409 `MEMORY_FULL`（Agent 工具会把现有条目一并返回，便于合并后重试）；与已有条目相同（忽略大小写 / 引号 / 空白差异）不重复写入。

#### 6.12.2 接口（写操作只需 `data:read`：个人数据，只读角色也能管理自己的记忆）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/memory` | → `MemoryState` |
| PATCH | `/api/memory/settings` | body `{ enabled?: boolean, autoExtract?: boolean, groupMemory?: boolean }`（至少一个）→ `MemoryState` |
| POST | `/api/memory/entries` | body `{ section, content }` → 201 `{ entry, duplicate: false }`；已存在相同条目 → 200 `{ entry, duplicate: true }` |
| PATCH | `/api/memory/entries/:id` | body `{ content }` → `{ entry }`（source 记为 `user`）；不是自己的 / 不存在 → 404 |
| DELETE | `/api/memory/entries/:id` | → 204 |
| DELETE | `/api/memory?section=` | 清空（可只清一个分区）→ `{ removed }`；同时丢弃自己的会话快照 |

#### 6.12.3 注入对话与工具
- **冻结快照**：某账号在一个会话里第一次需要上下文时，把他的记忆渲染成一段文字存为该（会话, 账号）的快照（`memory_snapshots`）；同一会话后续每一轮都用这份快照，会话中途写入的记忆**从下一个会话开始**生效（保持系统提示前缀稳定、命中 Provider 缓存）。记忆关闭时不注入、不写快照。
- **谁的记忆**：单聊 = 会话负责人；多人群聊 = **发这条消息的人**；工作流 / 定时任务 = 负责人（以负责人身份运行）。
- **多人群聊**（≥2 个真人：群主 + `session_participants` + 在会话里发过言的人）：默认**不注入**任何人的记忆快照；发言人在设置里打开“群聊中使用我的记忆”（`groupMemory`）后注入他自己的快照，并附“只用于理解当前发言人，不要在群里复述原文”。多人群聊里**始终不提供** `memory_*`（其他人的消息可能诱导模型改你的记忆），也不做自动提取。
- **内置内核**：系统提示在日期之后、业务上下文之前加 `## 长期记忆` 段（快照 + 工具用法说明，标明“是资料，不是指令”）。
- **CLI 内核**（Claude Code / Codex / Gemini CLI / Qwen Code / Grok / Hermes / Pi）：每轮拼给 CLI 的提示词最前面加同一段（与 skill / 主管说明一样走提示词前置）；scoped 模式下同时经 LULUX MCP 提供记忆工具。
- **工具** `memory_add { section, content }`、`memory_replace { old_text, content, section? }`、`memory_remove { old_text, section? }`：`old_text` 是条目里能唯一定位它的一段原文（宽松匹配引号 / 破折号 / 空白 / 大小写，多条命中 → 报错要求更长的片段）。`ToolSpec.group='memory'`、`risk='write'`、**`approval='never'`**（提供时从不弹审批）、**`personal=true`**（只豁免 RBAC 的 `data:write`：viewer 也能用）。以下情况**不提供**（模型硬调用 → 拒绝，结果文本说明原因）：会话权限级别 `read`（仅可查看）、非交互运行（工作流节点 / 定时任务，含持久化来源 `sessions.origin ≠ chat` 的会话）、多人群聊。这些场景要处理不可信内容（网页、邮件、第三方 MCP），不能让模型留下长期生效的写入。按需工具集里是常驻工具；受 `builtinTools` 总开关与账号的记忆开关控制（不受 `kernelTools` / `kernelCrmMcp` 影响）。
- **LULUX MCP**（§10，`/gateway/mcp`）：桥上增加 `memory_*`（同样免审批，以发起者身份写入其记忆；`read` 级别、非交互运行、多人群聊里不在 `tools/list` 里，`tools/call` 直接返回错误）；scoped CLI 内核在 `kernelCrmMcp=0` 但账号开着记忆时仍会接上 LULUX MCP，此时桥上只有记忆工具；`builtinTools=0` 或记忆关闭时没有记忆工具。
- 工具结果写入工具轨迹，客户端看到 `memory_*` 成功时在该工具卡片下显示“已更新记忆”（附“查看” → 设置 → 记忆）。

#### 6.12.4 自动提取
- 每轮对话完成后为（会话, 发言账号）排一个空闲计时器：空闲 3 分钟（`LULUX_MEMORY_IDLE_MS`）后，或累计 10 轮（`LULUX_MEMORY_EVERY_TURNS`）时，在后台用会话的 Provider（即默认 Provider 选择规则）做一次便宜的调用：系统提示以 `【LULUX 记忆提取】` 开头，输入为现有记忆 + 该账号自上次提取以来的消息（该账号的发言与助手回复），要求输出 `{"operations":[{action:'add'|'replace'|'remove', section?, content?, old_text?}]}`（最多 6 条）。每条提议都走 6.12.1 的检查，不合格的丢弃；`remove` 提议的 `old_text` 必须与某条现有条目整条一致且本身通过检查（转写是不可信输入）；source 记为 `auto`。usage 记为 `purpose:'memory'`。
- 不提取：账号关闭记忆或自动提取、没有 Provider、工作流节点的隐藏会话、定时任务新建的会话（持久化 `sessions.origin='schedule'|'workflow'`，迁移 23；运行中的非交互标记也算）、定时任务追加到已有会话时这次运行产生的消息（运行结束后把提取进度推进到最新）、多人群聊、会话成员里有 global CLI 内核（用户自己的 CLI 登录，不把对话发给组织默认 Provider）。有改动时 `/api/events` 推 `memory.updated { source:'auto', sessionId, applied }`（只推给本人）。
- `tools/dev/mock-openai.js`：系统提示含 `【LULUX 记忆提取】` 的请求只消费标了 `memory: true` 的编排步骤，否则固定回 `{"operations":[]}` 且不记录（避免后台提取抢走其他用例的编排响应）。

#### 6.12.5 导出 / 导入 / 备份
- `GET /api/data/export` 增加 `memory: { prefs, entries }`（只含自己的）；`POST /api/data/import` 接受同结构，导入到导入者自己的账号（去重、逐条检查与预算，超出的跳过），`imported.memory` 为新增条数。整库备份 / 恢复（§10.5）包含全部账号的记忆表。
### 6.13 会话模型与推理强度（迁移 22 `sessions.model` / `sessions.reasoning_effort`）
输入框右侧的模型选择器（胶囊“模型名 强度 ⌄”，弹层：“更快 ↔ 更聪明”五档滑块 + “模型”二级菜单）。按会话保存；`null` = 默认。

- **会话字段**：`Session.model: string|null`（Provider 的模型名，或 global CLI 内核的模型名）、`Session.reasoningEffort: 'off'|'low'|'medium'|'high'|'xhigh'|null`（界面：关闭 / 低 / 中 / 高 / 极高）。`POST /api/sessions` 可带 `providerId`、`model`、`reasoningEffort`（先校验，失败 400 不建会话）；`PATCH /api/sessions/:id { providerId?, model?, reasoningEffort? }`（群主 / 群管理员；`null` 恢复默认；未知模型 400 `UNKNOWN_MODEL`，未知 Provider 400 `UNKNOWN_PROVIDER`，非法档位 400；工作流隐藏会话 409）。单聊换内核（`agentIds` 主成员变化）时 `model` / `reasoningEffort` 清空。
- **按哪个内核列模型**：群聊 → `builtin`（只作用于 LULUX 内置成员；群里的 CLI 内核用各自默认，选择器给提示）；单聊 → 它的内核。
- **`GET /api/models?kernel=builtin|<kernelId>[&providerId=]`** → `{ kernel, kernelName, mode: 'builtin'|'scoped'|'global', groups: [{ id, label, options: [{ providerId, model, label, efforts: EffortLevel[] }] }], default: { providerId, model:null, label, efforts }, defaultEffort, effort: boolean }`；未知内核 404。工作流节点的模型下拉也用它（`kernel=builtin`）。
  - `builtin` / `scoped`：每个 Provider 一组（Provider 配了 `models` 列表就全列，否则只列默认模型）；`default` 是会话 / 默认 Provider 的默认模型；`defaultEffort` = 全局设置 `reasoningEffort`（`builtin`）或 `null`（`scoped`）。
  - `global`：一组，CLI 已知模型（下表）；“默认”= 不传参数，CLI 自己决定；`effort=false` 时不显示滑块。
- **档位支持（`efforts`）与生效值**：生效档 = 会话设置 → 默认档，再按模型收紧到不超过它的最高可用档。
  - 内置内核：OpenAI 系推理模型（o 系列 / gpt-5 / gpt-6+）→ `reasoning_effort`（`xhigh` 只给 gpt-5.2+ / gpt-6+）；Anthropic 扩展思考模型 → `thinking.budget_tokens`（低 2048 / 中 8192 / 高 24576 / 极高 32000，极高只给单次输出上限 ≥ 64K 的模型）；其他模型只有 `off`。全局设置 `reasoningEffort` 新增 `xhigh`。
  - scoped CLI 内核：网关一次性令牌带上会话档位，转发时对 OpenAI 系推理模型补 `reasoning_effort`（跨协议适配与 Chat Completions 透传；CLI 自己带了就不改）；Anthropic 思考块带签名、跨协议回传不了，所以不开（只有 `off`）。会话没设置时不改 CLI 的请求。
  - global CLI 内核（2026-10-21 按官方文档核实）：

  | 内核 | 模型参数 | 已知模型 | 推理强度参数 |
  | --- | --- | --- | --- |
  | Claude Code | `--model <m>` | sonnet / opus / haiku / fable / opusplan / sonnet[1m] / opus[1m] | `--effort low\|medium\|high\|xhigh`（不能关思考：无 `off`） |
  | Codex | `exec -m <m>`（插在 `exec` 之后） | gpt-6.1-sol / gpt-6-astra / gpt-6-sol / gpt-6-luna | `-c model_reasoning_effort="low\|medium\|high\|xhigh"`（无 `off`） |
  | Gemini CLI | `-m <m>` | gemini-3-pro-preview / gemini-3-flash-preview / gemini-2.5-pro / gemini-2.5-flash | 无（隐藏滑块） |
  | Qwen Code | `-m <m>` | qwen3-coder-plus / qwen3-coder-flash | 无 |
  | Grok | `-m <m>` | grok-build-0.1 / grok-4.7 / grok-4.6 | 无 |
  | Pi | `--model <m>` | sonnet / opus / haiku（模糊匹配） | `--thinking off\|low\|medium\|high\|xhigh` |
  | Hermes | — | 只有“默认”（`hermes model` 决定） | 无 |

  模型名只接受 `[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]*`（不以 `-` 开头），作为独立 argv 元素传入。
- **运行时**：`runtime.model`（内置内核 / scoped 内核）是叠加会话模型后的实际模型。

## 7. 内核网关（scoped 模式）

> 编号说明：第 6 节留给内置内核（docs/BUILTIN-KERNEL.md），本节为第 7 节。

目标：用户只要在“模型与密钥”里配置了 Provider，Claude Code / Codex / Gemini CLI / Qwen Code 就能直接用，不需要各自登录。做法：CLI 进程调用 LULUX 服务内的本机模型网关，网关把请求转给用户在 LULUX 里选的 Provider/模型。

### 7.1 两种内核模式
| | `scoped`（默认） | `global` |
| --- | --- | --- |
| 模型 | 会话的 Provider（会话指定 → `defaultProviderId` → 第一个）及其默认模型，经本机网关 | CLI 自己的配置 |
| 登录 | 不需要 | 需要 CLI 自己登录（旧行为） |
| 配置目录 | 隔离：`<dataDir>/kernels/<id>/home/<sessionId>`（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` / `QWEN_HOME`） | 用户自己的 `~/.claude`、`~/.codex` 等 |
| 环境变量 | 剥掉继承的 `ANTHROPIC_* CLAUDE_* OPENAI_* CODEX_* GEMINI_* GOOGLE_* QWEN_* DASHSCOPE_* AZURE_OPENAI* OPENROUTER_* VERTEX* LULUX_*`，只注入网关地址与一次性令牌；`NO_PROXY` 追加 `127.0.0.1,localhost,::1` | 继承用户环境（剔除 `LULUX_*`） |
| 可用性 | 已安装 + LULUX 有可用 Provider（有模型、Key 可解密） | 已安装 + 检测到登录凭据 |

- 切换：设置白名单新增 4 个键（`GET /api/settings/schema` 同步返回），`type:'enum'`，`enum:['scoped','global']`，默认 `'scoped'`：
  `kernelModeClaudeCode`、`kernelModeCodex`、`kernelModeGeminiCli`、`kernelModeQwenCode`。用 `PATCH /api/settings` 修改。
- `Kernel` 新增字段：`mode: 'scoped'|'global'|null`（builtin 为 null）、`modeSettingKey: string|null`（切换用的设置键，builtin 为 null）、`scopedProvider: { id, name, model } | null`（scoped 下默认会用的 Provider；global 或未配置时 null）。`requiresLogin` 改为 `mode==='global'`。
- kernel `Agent.unavailableReason`：`'未安装'`；scoped 下没有可用 Provider → `'请先在模型与密钥中配置模型'`；global 下检测不到凭据 → `'需要登录'`；server 模式未开启 → `'服务器已禁用内核'`。会话自己指定了可用 Provider 时，即使默认 Provider 不可用也允许发消息。
- `MessageRuntime` kernel 分支新增可选字段（旧消息没有）：`mode`、`providerName`、`model`（global 为 null）、`label`（界面直接显示的一行，如 `"Claude Code 2.1.304 · 经由 DeepSeek/deepseek-chat"`；global 为 `"Claude Code 2.1.304"`）。SSE `start.members[].runtime`、`agent.runtime`、`done.message.runtime` 同。会话里有 scoped 内核时 `start.provider` 不再为 null。
- 错误：scoped 下内核失败统一为 `KERNEL_FAILED`，`message` 带网关记录的上游原因（如 `Claude Code（经由 LULUX 模型）运行失败：网关上游错误：上游 Provider「X」调用失败：…`），**不会**出现 `KERNEL_LOGIN_REQUIRED`。发消息前：scoped 内核会话没有可用 Provider 时返回 400 `NO_PROVIDER|NO_MODEL` 或 409 `API_KEY_UNAVAILABLE|KERNEL_UNAVAILABLE`（同 persona）。

### 7.2 网关接口（`/gateway/*`，只给本机 CLI 用，客户端不要调用）
| 协议 | 路径 | 说明 |
| --- | --- | --- |
| Anthropic Messages | `POST /gateway/anthropic/v1/messages` | 流式 SSE 与非流式；`system`（字符串/块）、`tool_use`/`tool_result`；`thinking`、图片、服务端工具降级（忽略或文本占位）。上游是 Anthropic 协议时**直接透传**（只替换 `model` 与 `x-api-key`，转发 `anthropic-version`/`anthropic-beta`） |
| | `POST /gateway/anthropic/v1/messages/count_tokens` | 本地估算 `{input_tokens}` |
| | `GET /gateway/anthropic/v1/models` | 别名列表 |
| OpenAI Responses | `POST /gateway/openai/v1/responses` | SSE：`response.created / in_progress / output_item.added / content_part.added / output_text.delta / output_text.done / content_part.done / output_item.done / function_call_arguments.delta / function_call_arguments.done / response.completed`（含 usage），失败 `response.failed`；`function_call`/`function_call_output` 往返；`custom` 工具（如 apply_patch）按 `{input}` 映射回 `custom_tool_call` |
| OpenAI Chat | `POST /gateway/openai/v1/chat/completions` | 上游 OpenAI 兼容时透传（替换 `model` 与 Bearer Key；上游漏发 `finish_reason`/`[DONE]` 时补上）；上游 Anthropic 时转换 |
| | `GET /gateway/openai/v1/models` | 原名 + 别名 |
| Gemini | `POST /gateway/gemini/:version/models/<model>:generateContent`、`:streamGenerateContent?alt=sse`、`:countTokens`；`GET /gateway/gemini/:version/models` | Gemini CLI 设置 `GOOGLE_GEMINI_BASE_URL` 后走这里；`functionCall` 无 id 时按名字与 `functionResponse` 配对 |

- 跨协议转换复用 `services/llm` 的 Provider 适配器（OpenAI 兼容 / Anthropic），token 用量为估算值。
- **路由**：Provider 由令牌绑定（请求体不能换 Provider）；请求的模型名若是该 Provider 的某个模型（原名或别名）就用它，否则用会话模型。
- **模型别名**：Claude Code 只认 `claude` 开头的模型 id，网关统一暴露 `claude-lulux-<provider 名 slug>-<model slug>`（小写，非 `[a-z0-9.]` 变 `-`）。Claude Code 的 `ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL / ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL / CLAUDE_CODE_SUBAGENT_MODEL` 全部设为该别名。
- **鉴权**（不走主 API 的 Bearer token）：
  1. Host 必须是 `127.0.0.1:<port>` / `localhost:<port>`（server 模式也不接受公开域名），连接必须来自回环地址；
  2. 带 `Origin` 或 `Sec-Fetch-Site`（浏览器）→ 403；带 `X-Forwarded-For`/`Forwarded`（经反向代理）→ 403；
  3. 必须带本次内核运行签发的一次性令牌：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 或 `?key=`。令牌 `lulux-gw-` + 32 字节随机 hex，服务端只存 SHA-256，进程结束即吊销（兜底 6 小时过期）。无/错/已吊销 → 401（各协议自己的错误格式）。
  4. 真实 Provider Key 只在网关转发时从库里解密使用，**绝不**写入 CLI 配置、命令行参数或磁盘。
- 上游 401/403 对 CLI 报 400（避免 CLI 误以为自己掉登录并提示 /login），5xx/连不上报 502。

### 7.3 各 CLI 的 scoped 启动方式（已在 Claude Code 2.1.304、Codex 0.163.0、Gemini CLI 0.64.0、Qwen Code 0.25.3 实测）
- **Claude Code**：`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/gateway/anthropic`、`ANTHROPIC_AUTH_TOKEN=<令牌>`、上述模型别名、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`DISABLE_TELEMETRY/ERROR_REPORTING/AUTOUPDATER=1`、`CLAUDE_CODE_MAX_RETRIES=2`，参数追加 `--model <别名>`。
- **Codex**：`CODEX_HOME`、`LULUX_GATEWAY_KEY=<令牌>`；`codex exec -c model_provider="lulux" -c model_providers.lulux.name="LULUX" -c model_providers.lulux.base_url="http://127.0.0.1:<port>/gateway/openai/v1" -c model_providers.lulux.wire_api="responses" -c model_providers.lulux.env_key="LULUX_GATEWAY_KEY" -c model_providers.lulux.request_max_retries=1 -c model_providers.lulux.stream_max_retries=1 -c model="<模型>" …`。
- **Gemini CLI**：支持自定义 base URL（`GOOGLE_GEMINI_BASE_URL`，由 `@google/genai` 的 httpOptions.baseUrl 使用）。`GEMINI_CLI_HOME=<home>`、`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<port>/gateway/gemini`、`GEMINI_API_KEY=<令牌>`（作为 `x-goog-api-key` 发给网关），隔离目录 `.gemini/settings.json` 写入 `security.auth.selectedType='gemini-api-key'`（0.64 的 `gateway` 认证类型在 headless 校验里会报 “Invalid auth method selected.”）、关闭统计与自动更新。模型名沿用 CLI 默认（如 `gemini-2.5-pro`），网关按令牌路由到会话模型。
- **Qwen Code**：`QWEN_HOME=<home>`、`OPENAI_BASE_URL=http://127.0.0.1:<port>/gateway/openai/v1`、`OPENAI_API_KEY=<令牌>`、`OPENAI_MODEL=<模型>`，参数追加 `--auth-type openai --model <模型>`；`settings.json` 写入 `security.auth.selectedType='openai'`。
- 内核安装：npm 12 默认阻止依赖的安装脚本，Claude Code 依赖 postinstall 放置原生二进制。服务端安装前在 `<dataDir>/kernels/<id>/package.json` 写入 `allowScripts: { "<内核包名>": true }`（只放行内核包本身；npm 10/11 忽略此字段）。

### 7.4 客户端需要配合（`packages/client`）
1. 设置 → 内核页：每个第三方内核加“运行模式”切换（单选/开关）：“使用 LULUX 模型（推荐，无需登录）”= `scoped`，“使用 CLI 自己的登录”= `global`；读写 `kernel.modeSettingKey` 对应的设置键（`PATCH /api/settings { [modeSettingKey]: 'scoped'|'global' }`），保存后重新拉 `GET /api/kernels`、`GET /api/agents`。
2. scoped 下：显示“将使用：<scopedProvider.name> / <scopedProvider.model>”；`scopedProvider=null` 时提示“请先在模型与密钥中配置模型”并给跳转；**隐藏登录指引**（`requiresLogin=false`）。global 下照旧显示 `loginHint`。
3. 消息头运行者：kernel runtime 有 `label` 时直接显示 `label`（“Claude Code 2.1.304 · 经由 DeepSeek/deepseek-chat”），否则回退旧格式。
4. Agent 不可用原因新增 `'请先在模型与密钥中配置模型'`，按钮跳到模型与密钥设置页。
5. 错误：scoped 内核失败是 `KERNEL_FAILED`，直接展示 `message`（含上游原因）；`KERNEL_LOGIN_REQUIRED` 只会在 global 下出现。

## 8. Skill 与 Agent 自配置

格式与编写指南、内置清单见 `docs/SKILLS.md`。实现：`packages/server/src/services/skills/*`、`routes/skills.ts`；迁移 9（`skills`、`skill_usage`、`agent_skills`；`mcp_servers` 加 `transport/url/headers/created_by`）。

### 8.1 概念与存储
- **Skill** = 一个目录：`SKILL.md`（YAML frontmatter + Markdown 正文）+ 可选 `references/`、`templates/`、`scripts/`（Node `.js/.cjs/.mjs` 或 Python `.py`）。格式兼容开放的 Agent Skills（`name`、`description` 必填）。
- 所有 skill 都在 `<dataDir>/skills/<name>/`（`LULUX_SKILLS_DIR` 可改）。内置 skill 随安装包放在只读目录：`LULUX_BUILTIN_SKILLS_DIR` > `<resources>/skills`（桌面）> `/app/server/skills`（Docker）> 仓库 `packages/server/skills`（开发）；识别依据是目录里的 `MANIFEST.md`（或 `skill-creator/SKILL.md`）。
- **启动同步**（首次访问时一次）：新内置 skill 复制进来；已有副本未被改动（内容哈希 = 上次同步写入的哈希，记在 `<dataDir>/skills/.builtin-manifest.json`）且安装包版本变了 → 覆盖；改动过的保留并标 `modified=true`、`updateAvailable=true`；安装包删掉的内置 skill，未改动删除、改动过转为 `user`。手动放进 `<dataDir>/skills` 的目录登记为 `user`。
- `source`：`builtin`（只读：不可删除、不可经 Agent 修改，只能禁用 / 恢复默认）| `user`（本机文件夹导入或手动放入）| `agent`（Agent 经 `skill_create` 创建）| `imported`（zip / URL / GitHub / Agent 经 `skill_install` 安装）。
- **对话注入**（设置 `skillsEnabled`，默认 `'1'`；且该 Agent 可用 `skill_view` 时）：系统提示加入“已启用 skill 索引”（每条 `name：description`，总长 ≤ 7000 字符，含脚本的标“（含脚本）”）；用户最新消息命中某 skill 的 `keywords` 时预加载其正文（最多 2 个，各 ≤ 12000 字符），并发 SSE `skill_preload`（8.7）。
- 修改前备份：`skill_update`、带 `overwrite` 的安装会把旧版本移到 `<dataDir>/skills/.backups/<name>/<时间戳>/`。

### 8.2 公开结构
```ts
Skill = {
  name, description, source: 'builtin'|'user'|'agent'|'imported', enabled: boolean,
  category: string|null,            // trade|office|writing|research|productivity|meta|…
  keywords: string[], version: string|null, author: string|null, license: string|null,
  upstream: { source, commit: string|null } | null,   // 第三方来源（导入的 Hermes skill 等）
  requires: { tools: string[], mcp: string[], npm: string[], python: boolean },
  hasScripts: boolean, readOnly: boolean, modified: boolean, updateAvailable: boolean,
  origin: string,                   // builtin:… | zip:<文件名> | https://github.com/…/tree/<分支>/<目录> | 文件夹路径 | agent
  installedBy: 'system'|'user'|'agent', useCount: number, lastUsedAt: number|null,
  installedAt: number, updatedAt: number,
  error: string|null                // SKILL.md 无法解析时的原因（此时不进入对话索引）
}
SkillDetail = Skill & { files: { path, size }[], content: string /* 整个 SKILL.md */, body: string, frontmatter: object }
```

### 8.3 管理接口（读：`data:read`；写：`settings:write`，即 server 模式 owner/admin，member/viewer 403）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/skills?query=&category=&source=&enabled=` | → `{ skills: Skill[], categories: { id, label, count }[] }`（`categories` 按全部 skill 统计，`label` 为中文分类名） |
| GET | `/api/skills/:name` | → `SkillDetail`；不存在 404 `SKILL_NOT_FOUND` |
| GET | `/api/skills/:name/file?path=references/x.md` | → `{ path, size, binary, content, truncated }`（≤256 KB；路径穿越 / 符号链接 400 `SKILL_PATH_INVALID|SKILL_SYMLINK`；不存在 404 `SKILL_FILE_NOT_FOUND`） |
| GET | `/api/skills/:name/usage` | → `{ total, byKind: { view?, script?, preload? }, last30Days }` |
| GET | `/api/skills/:name/export` | → `application/zip`（条目为 `<name>/…`，可直接再安装） |
| PATCH | `/api/skills/:name` | body `{ enabled: boolean }`（strict）→ `{ skill }` |
| DELETE | `/api/skills/:name` | 204；内置 400 `SKILL_BUILTIN_READONLY` |
| POST | `/api/skills/:name/reset` | 内置 skill 恢复安装包版本 → `{ skill }`；非内置 400 `SKILL_NOT_BUILTIN` |
| POST | `/api/skills/install/zip` | body `{ dataBase64, filename?, subpath?, overwrite? }` |
| POST | `/api/skills/install/url` | body `{ url, subpath?, overwrite? }`：GitHub 仓库 / `tree/<分支>/<目录>` 地址、raw `SKILL.md` 地址、zip 下载地址 |
| POST | `/api/skills/install/folder` | body `{ path, overwrite? }`（本机绝对路径，source=`user`）；server 模式 404 `NOT_AVAILABLE_IN_MODE` |
| GET | `/api/agents/:id/skills` | → `{ agentId, mode: 'all'|'selected'|'none', skills: string[], available: string[] }` |
| PUT | `/api/agents/:id/skills` | body `{ mode, skills }` → 同上（`available` = 该 Agent 实际可用且已启用的 skill） |

安装三接口：新装 201、覆盖 200，返回 `{ skill, replaced }`。同名非内置已存在且未带 `overwrite` → 409 `SKILL_EXISTS`；与内置同名 → 409 `SKILL_BUILTIN_CONFLICT`（内置不能被覆盖）。包限制：zip ≤15 MB、解包后 ≤20 MB、≤300 个文件、单文件 ≤5 MB、目录 ≤8 层、路径 ≤240 字符；`..`、绝对路径、符号链接一律拒绝。错误码：`SKILL_MD_MISSING`、`SKILL_MD_INVALID`、`SKILL_NAME_INVALID`、`SKILL_PATH_INVALID`、`SKILL_SYMLINK`、`SKILL_ZIP_INVALID`（400）、`SKILL_TOO_LARGE`（413）。URL 安装默认拒绝内网/本机地址（同 `fetch_url` 的 net-guard；测试用 `LULUX_SKILLS_ALLOW_PRIVATE_URL=1` 放开）；GitHub 走 `api.github.com` + `raw.githubusercontent.com`（`LULUX_GITHUB_API`、`LULUX_GITHUB_RAW` 可改）。写操作记审计：`skill.install|skill.update|skill.delete|agent.skills`（Agent 工具触发的记 `skill.create|skill.update|skill.install`、`mcp.create|mcp.update|mcp.delete`，摘要前缀“Agent：”）。

### 8.4 Agent 工具（与 6.5 同一注册表，`server='LULUX'`，`builtin=true`）
`GET /api/chat/tools` 的 `group` 增加 `'skills'|'config'`。这些工具**不受 `kernelTools` 影响**；`builtinTools='0'` 时全部关闭；`skillsEnabled='0'` 时 skill 工具不出现。
| 工具 | group | 风险 / 审批 | 可用条件 | 说明 |
| --- | --- | --- | --- | --- |
| `skill_list` | skills | read | skillsEnabled | `{ query?, category? }` → 该 Agent 可用的 skill（最多 60 条） |
| `skill_view` | skills | read | skillsEnabled | `{ name, path? }` → SKILL.md 或附属文件内容（≤200 KB），计一次 `view` |
| `run_skill_script` | skills | write，`ask` 级别**始终审批**；`full` 级别直接执行（6.11），可“本会话允许”（按 skill 记忆，`toolKey='run_skill_script:<skill>'`） | skillsEnabled；server 模式需 owner 开启 MCP/脚本 | `{ skill, script, args?: string[≤50], stdin?, timeoutSeconds? (1–300，默认 60) }` |
| `skill_install` | config | write，始终审批 | desktop；server 模式 owner/admin | `{ url? , subpath?, path?, overwrite? }`（`path` 仅桌面） |
| `skill_create` | config | write，始终审批 | 同上 | `{ name, description (10–1024), body (≥1), keywords?, category?, files?: {path, content}[] }`，source=`agent` |
| `skill_update` | config | write，始终审批 | 同上 | `{ name, description?, body?, keywords?, files?, deleteFiles? }`；内置只读；修改前备份 |
| `mcp_list` | config | read | desktop；server 模式需开启 MCP 且 owner/admin | 不返回 env / headers 的值 |
| `mcp_add` | config | write，始终审批，**不可**“本会话允许” | 同上 | `{ name, command?, args?, env?, url?, headers?, enabled? }`（`command` 与 `url` 二选一）。命令型：批准后**仍走原生确认**（与设置页同一通道，拒绝 → 工具失败 `MCP_COMMAND_REJECTED`，不写库）；远程 HTTP 型只走普通审批 |
| `mcp_update` | config | 同上 | 同上 | 改命令 / 参数 / 环境变量时再走原生确认；http ↔ stdio 不能互改 |
| `mcp_remove` | config | 同上 | 同上 | `{ id }` |

`run_skill_script` 沙箱：cwd = 会话工作区 `<dataDir>/workspace/<sessionId>/`；只能运行该 skill `scripts/` 下的脚本（`..`、符号链接、其他扩展名拒绝）；环境变量白名单（`PATH`、`LANG`、`HOME`、`TMPDIR`… + `LULUX_SKILL_NAME`、`LULUX_SKILL_DIR`、`LULUX_WORKSPACE`、Node 的 `NODE_PATH`，Python 的 `PYTHONIOENCODING` 等），**父进程的密钥（API Key、`LULUX_ETA_*` 等）不会传入**；超时杀进程组；stdout/stderr 各保留 64 KB。`requires.npm` 里缺的包首次运行时装到 `<dataDir>/skill-runtime/node_modules`（与内核安装同一套 npm 与 `kernelRegistry` 源顺序，`--ignore-scripts`）。Python 用系统 `python3`（`LULUX_PYTHON` 可改，找不到时报错）。结果：
```ts
{ ok: exitCode===0, script, interpreter: 'node'|'python', exitCode, durationMs, installedDependencies: string[],
  outputTruncated?: string,   // 输出超过 64 KB 时出现，位于 stdout 之前（工具结果整体还会被截断，提示不会丢）
  stdout, stderr, files: { path, size, created }[], note? }
```
超时 → 工具失败“脚本运行超时（n 秒）已被终止”。新建 / 修改的工作区文件每个发一条 binary `artifact` 事件（8.7）。

### 8.5 审批卡片
`tool_request` SSE 与 `GET /api/chat/pending` 的 `PendingToolRequest` 新增：
- `approvalKind: 'tool'|'skill_script'|'skill_install'|'skill_write'|'mcp_add'|'mcp_update'|'mcp_remove'`（普通工具为 `'tool'`）；
- `canRemember: boolean`：false 时**不要显示**“本会话始终允许”（MCP 增删改）；
- `toolKey`：“本会话允许”的记忆键；
- `detail`：结构化详情。有详情的工具 `detail` **一定不为 null**：
  | approvalKind | detail |
  | --- | --- |
  | `skill_script` | `{ skill, skillSource, script, args, interpreter: 'node'|'python'|null, npmToInstall: string[], timeoutSeconds, … }` |
  | `skill_install` | `{ url, subpath, path, overwrite }` |
  | `skill_write`（create） | `{ name, description, files: ['SKILL.md', …], hasScripts }` |
  | `skill_write`（update） | `{ name, changes: ('description'|'body'|'keywords')[], files, deleteFiles, hasScripts }` |
  | `mcp_add` | 命令型 `{ transport: 'stdio', name, command, args, envKeys, nativeConfirm: true }`；远程 `{ transport: 'http', name, url, headerKeys, nativeConfirm: false }` |
  | `mcp_update` | `{ id, name, transport, command, args, envKeys?, url?, headerKeys?, enabled?, nativeConfirm }` |
  | `mcp_remove` | `{ id, name, transport }` |
  | **参数校验失败时**（任意 kind） | `{ invalid: true, errors: string[], arguments: object }`：`errors` 为“字段：原因”；`arguments` 是模型传入参数的摘要（字符串截到 300 字符、文件列表只给 path），**`headers`/`env` 只给键名**（`headersKeys`/`envKeys`）。用户批准后工具仍会以“参数不正确：…”失败返回给模型 |
  客户端：`skill_script` 卡片显示脚本、参数、将安装的 npm 包与“含可执行脚本”警示；`invalid` 卡片显示错误列表，建议默认按钮为“拒绝”。

### 8.6 MCP：远程 Streamable HTTP 传输
- `McpServer`（`GET /api/mcp/servers` 等）新增：`transport: 'stdio'|'http'`、`url`（stdio 为 `''`）、`headerKeys: string[]`（请求头加密存储，**只返回键名**）、`createdBy: 'user'|'agent'`。
- `POST /api/mcp/servers` body：`command`（本机命令）与 `url`（远程）二选一；远程可带 `headers: Record<string,string>`（≤20 个，名称 `^[A-Za-z0-9-]{1,64}$`，不能设 `Content-Type|Accept|Mcp-Session-Id|Mcp-Protocol-Version|Host|Content-Length`）。`url` 只接受 http/https 且不能内嵌账号密码。远程型不执行本机命令，**不需要原生确认**，`approved=true`。
- `PATCH`：http 型不能改 `command/args/env`，stdio 型不能改 `url/headers`（400）。改 `url/headers` 重新连接。
- 协议：Streamable HTTP（JSON-RPC over POST，响应可为 `application/json` 或 `text/event-stream`），握手后带 `Mcp-Session-Id`，关闭时 `DELETE`；走设置里的代理；取消发 `notifications/cancelled`。
- server 模式与命令型一样受“服务器安全 → 允许 MCP”开关与 owner 限制（5.8）。

### 8.7 SSE 事件
| event | data | 说明 |
| --- | --- | --- |
| `skill_preload` | `{ agentId, skills: string[] }` | 本轮按关键词预加载了这些 skill 的正文（在该 Agent 的 `agent` 事件之后、首个 `delta` 之前）。客户端可在回复上方显示小标签“已加载技能：报价计算” |
| `artifact`（binary） | `{ agentId, artifact: { id, title, language /* 扩展名 */, filename, path, size, binary: true, mime, downloadUrl } }` | 脚本生成 / 修改的工作区文件（docx/xlsx/pptx/pdf/png/json…）。**不会**追加代码块 `delta`；客户端在产物面板显示文件卡片，下载用 `fetch(downloadUrl, { headers: Authorization })` → Blob。`downloadUrl` 形如 `/api/chat/sessions/<id>/files?path=<相对路径>` |
`tool_request` 新增字段见 8.5。

### 8.8 会话工作区文件接口
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chat/sessions/:id/files?path=` | 下载工作区文件（`Content-Disposition: attachment`，`X-Content-Type-Options: nosniff`）。需要能看到该会话；路径穿越 400 `VALIDATION_ERROR`，不存在 404 |
| GET | `/api/chat/sessions/:id/files/list` | → `{ entries: { path, type: 'file'|'dir', size, modifiedAt }[], truncated }`（递归，最多 1000 条） |
| POST | `/api/chat/sessions/:id/files` | 上传（供 skill 脚本读取，如要分析的 Excel/PDF）：body `{ path, dataBase64, overwrite? }` → 201 `{ path, size }`。需要 `data:write` 且会话可写（viewer / 他人会话 403）；单文件 ≤10 MB（413 `FILE_TOO_LARGE`）；工作区总量 ≤50 MB（413 `WORKSPACE_FULL`）；同名未带 `overwrite` 409 `FILE_EXISTS`；路径规则同 `workspace_write`（400 `VALIDATION_ERROR`） |

### 8.9 设置与环境变量
- 设置：`skillsEnabled`（boolean，默认 `'1'`）。
- 环境变量：`LULUX_BUILTIN_SKILLS_DIR`（内置 skill 目录；桌面主进程自动设为 `<resources>/skills`）、`LULUX_SKILLS_DIR`（skill 存储目录）、`LULUX_PYTHON`、`LULUX_GITHUB_API`、`LULUX_GITHUB_RAW`、`LULUX_SKILLS_ALLOW_PRIVATE_URL`（仅测试）。

### 8.10 客户端需要配合（`packages/client`）
1. 设置页“技能”：列表（分类 tab、搜索、来源 / 含脚本 / 已修改 / 有更新 徽标）、详情（渲染 SKILL.md、文件树、用量）、启停、删除（非内置）、恢复默认（内置且 `modified`）、导出 zip、安装（上传 zip / 粘贴 URL / 桌面选文件夹）。
2. Agent 编辑页：技能模式 `all|selected|none` + 多选。
3. 审批卡片按 `approvalKind` 渲染 8.5 的详情；`canRemember=false` 隐藏“本会话始终允许”；`detail.invalid` 显示错误。
4. 产物面板支持 binary 产物（8.7）；输入框支持把文件上传到会话工作区（8.8），并把相对路径告诉模型（例如在消息里写“已上传 in/报价.xlsx”）。
5. MCP 设置页：新增“远程（HTTP）”类型，填 URL 与请求头；列表显示 `transport`、`headerKeys`、“由 Agent 添加”（`createdBy='agent'`）。
6. 回复上方显示 `skill_preload` 标签。

## 9. 桌面端 preload：窗口标题栏与自动更新

新增全局对象 `window.lulux`（仅桌面端；浏览器 / 远程网页里不存在，界面据此隐藏窗口按钮与更新 UI）。原有 `window.luluxAgent.window` 保留兼容（同名方法，没有 `onMaximizeChange`），`window.luluxAgent.updater` 与 `window.lulux.updater` 是同一个对象。所有相关 IPC 只接受**主窗口里本应用页面**（`fromAppPage`：发送方是主窗口 webContents、frame URL 与本地服务 origin 完全一致），内置浏览器标签页或其他 origin 调用会被忽略 / reject。

### 9.1 窗口与标题栏（按平台区分）
```ts
window.lulux.platform: 'win32' | 'darwin' | 'linux'
window.lulux.titleBar: {
  style: 'mac-native' | 'custom',
  controls: 'left' | 'right',           // mac：系统红绿灯在左上；windows/linux：界面在右上角自绘
  trafficLightInset: number,             // mac 为 80（左侧要留出的宽度，px）；其他平台 0
  doubleClickMaximizeNative: boolean,    // mac / windows 为 true；linux 为 false
}
window.lulux.win: {
  minimize(): void,
  toggleMaximize(): void,                // 最大化 ↔ 还原；mac 全屏时退出全屏
  close(): void,
  isMaximized(): Promise<boolean>,       // 最大化或全屏都为 true
  onMaximizeChange(listener: (maximized: boolean) => void): () => void,   // maximize/unmaximize/进入/退出全屏时推送；返回取消函数
}
```
主进程：macOS `titleBarStyle: 'hiddenInset'`（原生红绿灯，`trafficLightPosition {x:16,y:16}`，系统负责最小化/缩放/关闭与双击标题栏行为）；Windows / Linux `frame: false`（无系统标题栏，没有任何系统按钮）。

客户端需要配合（`packages/client`）：
1. **mac**：不画任何窗口按钮；标题栏左侧留 `trafficLightInset` 宽的空位（同样是拖拽区域）。
2. **windows / linux**：右上角自绘三个按钮，顺序 最小化 / 最大化(还原) / 关闭，Windows 风格（每个约 46×32px、无圆角、细线图标；悬停浅灰背景，**关闭悬停 `#c42b1c` 红底白色图标**，按下更深）；最大化图标随 `onMaximizeChange` 在“□ 最大化”与“❐ 还原”之间切换，初始值用 `isMaximized()`；按钮加 `title`/`aria-label`（最小化 / 最大化 / 还原 / 关闭）。
3. **拖拽区域**：顶部标题栏（侧栏顶部、会话标题栏等）设 `-webkit-app-region: drag`；其中所有可交互元素（按钮、输入框、下拉、链接、三个窗口按钮）必须设 `-webkit-app-region: no-drag`，否则点不到。拖拽区域不要覆盖滚动条与可点击内容。
4. **双击最大化**：`doubleClickMaximizeNative=true`（mac / windows）时由系统处理拖拽区域的双击，界面**不要**再在 dblclick 里调 `toggleMaximize()`（Windows / mac 的拖拽区域本来也收不到 DOM 鼠标事件）；`false`（linux）时界面在标题栏 dblclick 调 `toggleMaximize()`。
5. 非桌面（没有 `window.lulux`）：不画任何窗口按钮，不设拖拽区域。

### 9.2 自动更新（`window.lulux.updater`）
完整说明（更新源、平台支持、未签名降级、通道、失败策略）见 [AUTO-UPDATE.md](./AUTO-UPDATE.md)，类型定义见其第 4 节。要点：
- `check() / download() / install() / getState() / onState(listener) / getSettings() / setSettings(patch)`。
- `UpdaterState.status`：`disabled | idle | checking | available | not-available | downloading | downloaded | error`；`canCheck=false` 时按 `limitation`（`dev | unconfigured | mac-unsigned | portable | not-appimage | unsupported-platform`）显示原因；`canAutoInstall=false` 时“下载”改为“前往下载页”（`download()` 会打开 `downloadPage`）。
- 设置：`{ autoCheck: boolean, autoDownload: boolean, channel: 'stable' | 'beta', skippedVersion: string | null }`；未知键或类型错误 reject。
- `available.notes` 是纯文本，按纯文本渲染（不要 v-html）。
- 后台失败不打扰（`lastError.interactive=false`，status 不变为 `error`）；只有用户手动操作失败才是 `error`。
- 界面订阅 `onState` 后，主进程不再弹原生“重启并安装”对话框。

客户端需要配合（`packages/client`）：设置 → 关于与更新 页面（版本号、检查更新按钮、下载进度、发布说明、通道切换、自动检查 / 自动下载开关）与全局“新版本已就绪 · 重启并安装”非模态提示，细节见 AUTO-UPDATE.md 第 5 节。

## 10. CRM 扩展：Agent 工具、任务提醒、漏斗、商机、订单与收款、导出与备份恢复、结构化日志、内置 LULUX MCP

### 10.1 Agent 业务工具（与 4.9 同一注册表，`group='business'`、`server='LULUX'`、`builtin=true`）
| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `update_customer` | write | `{ customerId, stage?, tags?, addTags?, removeTags?, country?, website?, notes?, appendNote?, ownerId? }`；阶段变化自动记 Activity；`ownerId` 走负责人转移（连带报价，契约 5.6） |
| `add_activity` | write | `{ customerId, type: note|email|call|quote, content }` |
| `list_activities` | read | `{ customerId, type?, limit? (≤100，默认 20) }` |
| `list_quotes` / `get_quote` | read | `{ customerId?, status?, limit? }` / `{ quoteId }`（含明细与条款） |
| `update_quote` | write | `{ quoteId, currency?, incoterm?, port?, validUntil?, paymentTerms?, leadTime?, notes?, items?, status?: draft|accepted|rejected }`——**不能设为 `sent`**（发送只能由用户在邮箱里完成） |
| `generate_quote_pdf` | read | `{ quoteId, templateId? }` → PDF 写入会话工作区 `quotes/<number>.pdf`，下发 binary `artifact`（8.7）。只生成文件、不改业务数据，归 read |
| `get_email` | read | `{ messageId }` → 正文纯文本（≤8000 字，标注不可信） |
| `create_customer_from_email` | write | `{ messageId, company?, country?, website?, stage?, tags? }`（同 `POST /api/email/messages/:id/customer`） |
| `create_task` / `update_task` | write | `{ title, dueAt?, customerId?, quoteId?, priority?, notes? }` / `{ taskId, status?, dueAt?, title?, notes?, priority? }`；Agent 建的任务 `source='agent'` |
| `list_tasks` | read | `{ status?, due?: overdue|today|week, customerId?, limit? }` |
| `pipeline_stats` | read | `{ staleDays? }` → 同 `GET /api/pipeline/stats` |
| `list_team_members` | read | 可作为负责人的成员 `{ id, name, role }`（桌面版只有本机用户） |
| `list_deals` | read | `{ stage?: <DealStage>|open|closed|all, customerId?, limit? }` → `{ total, items: DealBrief[], funnel }`（`funnel` = 未关闭商机按币种的金额 / 加权金额） |
| `create_deal` / `update_deal` | write | `{ customerId, title, amount?, currency?, stage?, expectedClose?, quoteId?, notes? }` / `{ dealId, title?, amount?, currency?, stage?, probability?, expectedClose?, wonReason?, lostReason?, quoteId?, notes? }`；输单必须带 `lostReason`；Agent 建的商机 `source='agent'` |
| `convert_quote_to_order` | write | `{ quoteId, depositAmount?, dueDate?, dealId?, notes? }` → 订单（10.8） |
| `list_orders` | read | `{ status?: <OrderStatus>|open|all, customerId?, limit? }` |
| `update_order` | write | `{ orderId, status?, containerType?, containerNo?, blNo?, vessel?, portOfLoading?, portOfDischarge?, etd?, eta?, dueDate?, notes? }` |
| `record_payment` | write | `{ orderId, amount, currency?, receivedAt?, method?, reference?, notes? }`（Agent 登记的收款 `source='agent'`） |
| `list_overdue_receivables` | read | `{ overdueOnly? = true, limit? }` → `{ total, summary, items }`（催款用） |

所有 write 工具：按会话权限级别（6.11），`ask` 时需批准（可“本会话始终允许”）；viewer 返回“无权限”；member 只能改自己负责的客户 / 报价 / 任务（共享客户可加 Activity、建报价、建任务）；不可见的行按 `NOT_FOUND`。成功的 write 记审计 `agent.tool`（`entityId`=工具名，`meta={sessionId, agentId, argKeys}`）。

### 10.2 任务 / 跟进提醒
`Task = { id, title, notes, customerId|null, customerName|null, quoteId|null, dueAt: ms|null, status: open|done|cancelled, priority: low|normal|high, source: 'user'|'agent', ownerId, overdue, createdAt, updatedAt, doneAt|null }`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks?status=open|done|cancelled|all&due=overdue|today|week&customerId=&mine=1&limit=` | → `{ items: Task[], total }`；按到期时间升序（无到期在后） |
| POST | `/api/tasks` | `{ title, notes?, customerId?, quoteId?, dueAt? (ms 或 ISO), priority? }` → 201 `Task`（`data:write`） |
| GET / PATCH / DELETE | `/api/tasks/:id` | PATCH `{ title?, notes?, dueAt?, priority?, status? }`；设为 `done` 时给关联客户记一条 Activity |
可见：负责人本人、admin/owner、能看到关联客户的人；可写：负责人本人与 admin/owner。审计 `task.create|update|delete`。
到期提醒：服务端每分钟扫描，已到期、未完成、未提醒过的任务经 `/api/events` 推送 `task.due { task: Task }` 给**负责人**（每条一次；修改 `dueAt` 后重新提醒；迁移 11 `reminded_at`）。客户端收到后弹桌面通知 / 工作台提示。

### 10.3 漏斗统计
`GET /api/pipeline/stats?staleDays=14` → `{ customers: { total, byStage }, funnel: [{ stage, count, reached, conversionFromPrevious }] (lead→won), winRate, quotes: { [status]: { count, amountByCurrency } }, tasks: { open, overdue }, staleCustomers: { days, items: [{ id, company, stage, lastUpdatedAt }] } }`（按当前用户可见范围）。
新增（向后兼容，原字段不变）：
- `deals: { total, byStage: [{ stage, probability, count, amountByCurrency, weightedByCurrency }], open: { count, amountByCurrency, weightedByCurrency }, closingThisMonth: {同上}, winRate: number|null, lostReasons: [{ reason, count }] }`——**按金额加权**：`weighted = amount × probability%`，按币种分别汇总，不做汇率折算。
- `receivables: { openCount, outstandingByCurrency, overdueCount, overdueByCurrency }`。

### 10.4 客户 CSV 导出
`GET /api/customers/export?query=&stage=&tag=&ownerId=&visibility=` → `text/csv`（UTF-8 BOM，`Content-Disposition: attachment`，`X-Total-Count`）。列：`company,country,website,stage,tags(;分隔),source,owner,contact_name,contact_title,contact_email,contact_phone,contacts_count,notes,created_at,updated_at`。以 `= + - @` 开头的单元格前加 `'`（防公式注入）。需要 `data:export`（owner/admin），审计 `customer.export`。

### 10.5 整库快照备份
- `GET /api/data/backups` → `{ backups: [{ name, size, createdAt, kind: auto|manual|before-import|other }] }`；`POST /api/data/backups` → 201（手动快照）。均需 `data:export`，POST 审计 `backup.create`。
- 设置：`autoBackupHours`（0–168，默认 24，0 关闭）、`autoBackupKeep`（1–60，默认 7，只轮转自动备份）。
- `kind` 增加 `before-restore`（恢复前自动保存的当前库）与 `pre-migration`（升级迁移前的快照）。
- **恢复（下次启动生效）**：`POST /api/data/backups/:name/restore`（`data:import`，审计 `backup.restore_request`）→ `{ pending: { name, sha256, size, schemaVersion, requestedAt, requestedBy }, restartRequired: true }`。校验：文件名 `^[A-Za-z0-9][A-Za-z0-9._-]*\.db$`、文件存在（否则 404 `NOT_FOUND`）、`PRAGMA integrity_check = ok`、包含 `schema_migrations/settings/customers`、schema 版本不高于本程序（否则 400 `BACKUP_INVALID`，`message` 说明原因）；非法文件名 400 `INVALID_BACKUP_NAME`。
- `GET /api/data/restore` → `{ pending: RestorePending|null, lastResult: { ok, name, at, previous, rolledBack, error }|null }`；`DELETE /api/data/restore` → `{ cancelled: boolean }`（取消待恢复，审计 `backup.restore_cancel`）。
- 启动时（打开数据库之前）：再次比对 SHA-256（确认后文件被改动则取消）与完整性 → 当前库 checkpoint 后 `VACUUM INTO backups/before-restore-<时间>.db` → 原子替换 `<dataDir>/lulux-eta.db`（删除 `-wal/-shm`）→ 打开并跑迁移验证；任一步失败自动用 before-restore 副本回滚。结果写入 `lastResult`（启动日志也有一行）。
- 手动恢复（应用无法启动时）：退出应用，用 `<dataDir>/backups/<name>.db` 替换 `<dataDir>/lulux-eta.db`（同时删除 `lulux-eta.db-wal`、`lulux-eta.db-shm`），再启动。

### 10.6 内置本地 LULUX MCP（scoped 内核）
- 设置 `kernelCrmMcp`（boolean，默认 `'1'`）；`builtinTools='0'` 时也不注入。
- 只在 **scoped** 模式的内核运行时注入：Claude Code `--mcp-config <home>/lulux-mcp.json --allowedTools mcp__lulux`；Codex `-c mcp_servers.lulux.url=… -c mcp_servers.lulux.bearer_token_env_var="LULUX_MCP_TOKEN"`；Gemini CLI / Qwen Code `settings.json` 的 `mcpServers.lulux = { httpUrl, headers, trust: true }`。global 模式与 `kernelCrmMcp='0'` 时不注入，并清理旧配置。
- 端点 `POST /gateway/mcp`（Streamable HTTP，JSON 响应；通知 202；`GET` 405；`DELETE` 200）。访问控制同 7.2：本机回环、Host 为 `127.0.0.1|localhost:<port>`、拒绝 `Origin` / `Sec-Fetch-Site` / 代理头；`Authorization: Bearer lulux-mcp-…` 一次性令牌（只存 SHA-256，绑定会话 + Agent + 发起者身份，运行结束吊销；API token 与网关令牌都不能用）。
- 方法：`initialize`（`serverInfo.name='lulux-crm'`）、`tools/list`、`tools/call`、`ping`、`resources/list`、`prompts/list`（空）。
- `tools/list`（2026-10-21 起）：10.1 + 4.9 的业务工具；skill 工具 `skill_list` / `skill_view` / `run_skill_script`（按该内核 Agent 的 skill 配置过滤，§8）；用户在 LULUX 里添加并启用、已连接的 MCP Server 的工具，名字 `<server 短名>__<工具名>`（只含 `[a-zA-Z0-9_-]`，≤48，与内置同名时加 `_2`…），描述以 `[Server 名]` 开头。**不含**工作区、联网抓取、自配置（`skill_install` / `mcp_add` …）工具。这样 LULUX 里装的 skill 与 MCP 在任何内核的会话里都能用（skill 文件本身仍同步到各 CLI 的原生 skill 目录）。
- 审批同内置内核：用户 MCP 工具一律按 write；`run_skill_script` 在 `ask` 级别总要批准（`full` 直接执行，6.11）（`approvalKind='skill_script'`，记忆粒度 `run_skill_script:<skill>`）；MCP 工具的记忆键是内置内核里的名字 `mcp_<server>_<tool>`，两边共用。viewer 调用用户 MCP 工具返回无权限；用户 MCP 调用写审计 `agent.tool`（`meta.via='mcp'`）。轨迹 / `tool_result` 里的 `name` 是 MCP 原工具名，`server` 是 Server 名。
- 工具以发起者身份执行（RBAC 与可见性同 /api）；write 工具在对话 SSE 上下发 `tool_request`（多一个字段 `via: 'mcp'`），用 `POST /api/chat/tool-decision` 批准；结果写入该条 kernel 消息的 `toolTrace` 并下发 `tool_result`。
- 实测：Claude Code 2.1.304（真实 CLI，`test/kernel-mcp-real.test.ts`）。Codex / Gemini CLI / Qwen Code 的配置已注入但未用真实 CLI 验证；Gemini / Qwen 当前以 `--approval-mode plan` 运行，可能拒绝调用非只读 MCP 工具。

### 10.7 商机（Deal）
`DealStage = prospecting|qualified|proposal|negotiation|won|lost`（默认赢单概率 10/25/50/75/100/0 %）。
`Deal = { id, title, customerId, customerName, quoteId|null, amount, currency, stage, probability, probabilityOverridden, weightedAmount, expectedClose: 'YYYY-MM-DD'|'', wonReason, lostReason, notes, source: 'user'|'agent', ownerId, ownerName, overdue, createdAt, updatedAt, closedAt|null }`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/deals?stage=<DealStage>|open|closed|all&customerId=&mine=1&limit=` | → `{ items: Deal[], total }`，按预计成交日升序（无日期在后） |
| POST | `/api/deals` | `{ customerId, title, amount?, currency? (默认 USD), stage?, probability? (0–100，覆盖阶段默认), expectedClose?, quoteId?, wonReason?, lostReason?, notes? }` → 201 |
| GET / PATCH / DELETE | `/api/deals/:id` | PATCH 同上字段（不能改 `customerId`）+ `ownerId`（仅 admin/owner）；阶段变化给客户记一条 Activity（带原因） |
规则：同一客户可有多个商机；`stage='lost'` 必须有 `lostReason`（400 `LOST_REASON_REQUIRED`）；`quoteId` 必须属于同一客户（400 `QUOTE_CUSTOMER_MISMATCH`）；`won/lost` 时 `probability` 固定为 100/0。可见性随客户；可写：商机负责人与 admin/owner。审计 `deal.create|update|delete`。

### 10.8 订单、出运与收款
`OrderStatus = pending_production（待生产）| in_production（生产中）| shipped（已出运）| completed（已完成）| cancelled（已取消）`。
`Order = { id, number: 'SO-YYYYMMDD-NNN', customerId, customerName, quoteId, quoteNumber, dealId, currency, amount, items, incoterm, paymentTerms, depositAmount, dueDate, status, notes, shipment: { containerType, containerNo, blNo, vessel, portOfLoading, portOfDischarge, etd, eta }, paid, balance, paymentStatus: unpaid|partial|paid, overdue, overdueDays, ownerId, ownerName, createdAt, updatedAt, shippedAt, completedAt, payments?: Payment[] }`
`Payment = { id, orderId, amount, currency, receivedAt: 'YYYY-MM-DD', method, reference, notes, source, createdBy, createdAt }`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/quotes/:id/order` | `{ number?, depositAmount?, dueDate? (尾款应收日), dealId?, notes? }` → 201 `Order`。报价自动标记 `accepted`；关联商机（`dealId` 或 `quoteId` 关联的商机）自动 `won`；客户记 Activity。错误：409 `ORDER_EXISTS`（一个报价只能生成一个订单）、409 `QUOTE_REJECTED`、400 `QUOTE_EMPTY`、409 `ORDER_NUMBER_TAKEN` |
| GET | `/api/orders?status=<OrderStatus>|open|all&customerId=&mine=1&receivable=open|overdue&limit=` | → `{ items, total }` |
| GET / PATCH / DELETE | `/api/orders/:id` | GET 含 `payments`；PATCH `{ status?, depositAmount?, dueDate?, paymentTerms?, notes?, containerType?, containerNo?, blNo?, vessel?, portOfLoading?, portOfDischarge?, etd?, eta? }`。`containerType ∈ '' | LCL | 20'GP | 40'GP | 40'HQ | 45'HQ | 20'RF | 40'RF | AIR | EXPRESS | OTHER`；日期 `YYYY-MM-DD`。状态变化记 Activity；进入 `shipped` 记 `shippedAt`，`completed` 记 `completedAt` |
| GET / POST | `/api/orders/:id/payments` | POST `{ amount, currency? (须与订单一致), receivedAt? (默认今天), method?, reference?, notes? }` → 201 `{ payment, order }`。错误：400 `CURRENCY_MISMATCH`、400 `PAYMENT_EXCEEDS_BALANCE`、409 `ORDER_CANCELLED` |
| DELETE | `/api/orders/:id/payments/:pid` | 204 |
| GET | `/api/receivables?overdue=1&limit=` | → `{ items: Order[], total, summary: { openCount, outstandingByCurrency, overdueCount, overdueByCurrency } }`；按应收日升序 |
应收余额 `balance = amount − Σpayments`（已取消为 0）；`overdue` = 有余额且 `dueDate` 早于今天（服务端本地日期）。可见性随客户；可写：订单负责人（转订单的人）与 admin/owner。审计 `order.create|update|delete`、`payment.create|delete`。迁移 12（`deals`、`orders`、`payments`）。

### 10.9 结构化日志
- 文件：`<dataDir>/logs/lulux-YYYY-MM-DD.log`，每行一个 JSON：`{ ts, level: debug|info|warn|error, msg, requestId?, ... }`；单文件超过 `LULUX_LOG_MAX_MB`（默认 50）切分为 `.1 .2…`；保留 `LULUX_LOG_KEEP_DAYS`（默认 14）天；`LULUX_LOG_LEVEL`（默认 info）；`LULUX_LOG_FILE=0` 关闭。
- 每个 `/api`、`/gateway` 请求一行 `msg='http'`：`method, path（query 已脱敏）, status, ms, actorId, ip, errorCode?`；SSE 在连接关闭时记录。所有响应带 `X-Request-Id`（客户端可传入 `^[A-Za-z0-9._:-]{8,64}$` 的值，否则服务端生成 `req_<16 hex>`）；客户端报错时请把它展示 / 复制给用户，便于排查。
- 脱敏：键名含 password / secret / token / apiKey / authorization / cookie / credential / privateKey / code 等的值写 `[REDACTED]`；字符串里的 `Bearer …`、`sk-…`、`lulux-mcp-…`、`lxsetup_…`、URL 里的 `token= code= key= password=` 打码。`console.*` 同时写入日志文件。

### 10.10 JSON 导出 / 导入
`GET /api/data/export` 增加 `tasks: Task[]`、`deals: Deal[]`、`orders: Order[]`（含 `payments`）；`POST /api/data/import` 按 id 覆盖导入，`imported` 增加 `tasks / deals / orders / payments` 计数；关联客户不存在的商机 / 订单跳过，任务的 `customerId` 置空。

## 11. 工作流与定时任务

多 Agent 工作流（DAG）与定时任务。鉴权、错误格式与其它接口相同；写操作需要 `data:write`。
**可见性 / 权限**：仅本人（5.6a，迁移 19 起）——只有负责人自己可见、可改、可删除、可运行 / 取消 / 立即运行，owner/admin 也看不到别人的；`visibility` 只接受 `'private'`、`teamId` 只接受 `null`（不可见的一律 404，不泄露存在性）。迁移 18（`workflows_schedules`）。

### 11.1 数据结构
```ts
interface WorkflowNode {
  id: string; name: string
  kernelId: string            // 会话成员同一套 id：'builtin' | 'kernel-hermes' | 'kernel-claude-code' …（旧 persona id 归一为 'builtin'）
  providerId: string | null   // 仅 builtin：Provider 覆盖；null = 默认（非 builtin 节点保存为 null）
  model: string | null        // 仅 builtin：模型覆盖
  prompt: string              // ≤ 20000 字
  joinStrategy: 'all' | 'any' // 缺省 'all'
  allowWrite: boolean         // 缺省 false
  skills: string[]            // 可选 skill 名（≤20），写进节点提示词
  position: { x: number; y: number }
}
interface WorkflowEdge { id: string; source: string; target: string }
interface Workflow {
  id: string; name: string; description: string
  nodes: WorkflowNode[]; edges: WorkflowEdge[]
  viewport: { x: number; y: number; zoom: number } | null
  nodeCount: number; edgeCount: number
  ownerId: string; visibility: 'private' /* 迁移 19 起恒为 private，见 5.6a */; teamId: null
  createdAt: number; updatedAt: number
  lastRun: { id: string; status: RunStatus; startedAt: number } | null
}
type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'
interface WorkflowRun {
  id: string; workflowId: string; trigger: 'manual' | 'schedule'; scheduleId: string | null
  status: RunStatus; input: string; startedAt: number; finishedAt: number | null; error: string | null
  nodes: { nodeId: string; status: RunStatus; output: string; error: string | null
           sessionId: string | null; startedAt: number | null; finishedAt: number | null }[]   // 按拓扑序
}
```
上限：节点 100、连线 500。同一对节点之间的重复连线合并为一条。

### 11.2 工作流接口
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/workflows` | → `Workflow[]`（含完整 nodes/edges 与 `nodeCount`/`edgeCount`，按 `updatedAt` 倒序） |
| POST | `/api/workflows` | `{ name, description?, nodes?, edges?, viewport?, visibility?: 'private', teamId?: null }` → 201 `Workflow` |
| GET | `/api/workflows/:id` | → `Workflow` |
| PATCH | `/api/workflows/:id` | `{ name?, description?, nodes?, edges?, viewport?, visibility?: 'private', teamId?: null }` → `Workflow` |
| DELETE | `/api/workflows/:id` | 204；运行记录与节点的隐藏会话一并删除；指向它的定时任务被停用（`lastError: '目标工作流已删除'`） |
| POST | `/api/workflows/:id/duplicate` | → 201 `Workflow`（名称加“ 副本”，归属当前用户、private） |
| GET | `/api/workflows/:id/export` | → JSON 文件（`Content-Disposition: attachment`）：`{ format: 'lulux-workflow', version: 1, exportedAt, name, description, nodes, edges, viewport }` |
| POST | `/api/workflows/import` | `{ json: string \| object }`（导出的内容）→ 201 `Workflow`（新 id，节点 id 保留，校验同创建） |
| POST | `/api/workflows/:id/run` | `{ input?: string }` → `WorkflowRun`（`status: 'queued'`，后台执行） |
| GET | `/api/workflows/:id/runs?limit=20` | → `WorkflowRun[]`，新的在前（limit 1–100） |
| GET | `/api/workflow-runs/:runId` | → `WorkflowRun` |
| POST | `/api/workflow-runs/:runId/cancel` | → `WorkflowRun`（等运行中的节点收尾，最多 5 秒；已结束的原样返回） |

校验错误（400）：`CYCLE_DETECTED`（含自环；message 列出环上的节点名）、`DANGLING_EDGE`、`UNKNOWN_KERNEL`、`UNKNOWN_PROVIDER`、
`VALIDATION_ERROR`（字段 / 重复节点 id / 重复连线 id）、`INVALID_IMPORT`；运行空工作流 → 400 `EMPTY_WORKFLOW`。

### 11.3 执行语义
- 拓扑序执行；**根节点**的提示词 = 节点提示词 + `## 输入\n<input>`（input 为空则省略）；其余节点 = 节点提示词 + `## 上游输出` 下每个上游一节 `### <节点名>\n<输出>`（每个上游最多 20000 字，超出截断）。
- `joinStrategy: 'all'`：全部上游成功才开始；任一上游 failed / skipped / cancelled → 本节点 `skipped`（向下传递）。
- `joinStrategy: 'any'`：**第一个成功**的上游完成即开始，只带它的输出，其余上游照常跑完但输出不带入；全部上游结束且无成功 → `skipped`。
- 运行状态：取消 → `cancelled`；否则任一节点 `failed` → `failed`（`error` 汇总失败节点名与原因）；否则 `succeeded`。
- 同时运行的节点最多 **2** 个（全局，跨所有运行共享）；排队的节点保持 `queued`。
- 每个节点在一个**隐藏会话**里经正常的编排器运行（内置内核 / 命令行内核，与聊天相同：Provider、工具、skill、usage、webhook 都照常）。
  隐藏会话：`sessions.workflow_run_id` 非空，**不出现在 `GET /api/sessions`**，可凭 `nodes[].sessionId` 用 `GET /api/sessions/:id` 打开（归属运行者、private）。
  标题 `[工作流] <工作流名> · <节点名>`。节点输出 = 最终助手消息的 `content`。
  `Session.workflowRunId`（隐藏会话为所属运行 id，普通会话为 `null`；`kind` 仍为 `'single'`）；隐藏会话**只读**：`POST /api/chat`、`/api/chat/regenerate`、`/api/chat/edit`、`PATCH /api/sessions/:id` → `409 WORKFLOW_SESSION_READONLY`；不生成自动标题。客户端用只读弹窗查看，不进 Agent 页。
- **非交互审批**：节点会话里所有 `risk: 'write'` 的工具（含 `approval: 'always'` 的 skill_* / mcp_*、经 LULUX MCP 的 CLI 内核写工具）都不等界面审批：
  `allowWrite=false` 自动拒绝（全局默认 `full` 也拒绝），`allowWrite=true` 自动批准（不超过负责人的权限上限，6.11）。只读工具照常执行。
- 取消：中止运行中的节点（上游请求 / CLI 子进程随之结束），未开始的节点记为 `cancelled`。服务重启时仍在运行的记录标记为 `failed`（“服务重启，运行被中断”）。

### 11.4 定时任务
```ts
type ScheduleSpec =
  | { type: 'once'; at: number }                       // 毫秒时间戳，创建 / 修改时必须在未来
  | { type: 'interval'; minutes: number }              // ≥ 5；按锚点对齐（创建或改规则的时刻 + k·间隔）
  | { type: 'daily'; time: 'HH:mm' }
  | { type: 'weekly'; days: number[]; time: 'HH:mm' }  // 0 = 周日；去重排序
  | { type: 'cron'; expr: string }                     // 5 字段：分 时 日 月 星期；支持 * , - /、JAN-DEC、SUN-SAT、星期 7 = 周日、@daily/@hourly/@weekly/@monthly/@yearly
type ScheduleTarget =
  | { type: 'workflow'; workflowId: string; input?: string }
  | { type: 'prompt'; kernelId: string; prompt: string; sessionMode: 'new' | 'append'; sessionId?: string | null }
interface Schedule {
  id: string; name: string; target: ScheduleTarget; spec: ScheduleSpec; timezone: string // IANA，缺省 = 设置 timezone，否则系统时区
  enabled: boolean; nextRunAt: number | null; lastRunAt: number | null
  lastStatus: RunStatus | null; lastError: string | null
  ownerId: string; visibility: 'private' /* 迁移 19 起恒为 private，见 5.6a */; teamId: null; createdAt: number; updatedAt: number
}
interface ScheduleRun { id: string; scheduleId: string; status: RunStatus; startedAt: number; finishedAt: number | null
  error: string | null; workflowRunId: string | null; sessionId: string | null; missed: boolean }  // missed = 补跑
```
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/schedules` | → `Schedule[]`（新建的在前） |
| POST | `/api/schedules` | `{ name, target, spec, timezone?, enabled?, visibility?: 'private', teamId?: null }` → 201 `Schedule` |
| GET / PATCH / DELETE | `/api/schedules/:id` | PATCH 字段同创建（均可选）→ `Schedule`；DELETE → 204 |
| POST | `/api/schedules/:id/run-now` | → `ScheduleRun`（`running`，后台执行；不改变 `nextRunAt`；停用的任务也可立即运行） |
| GET | `/api/schedules/:id/runs?limit=20` | → `ScheduleRun[]`，新的在前 |
| POST | `/api/schedules/preview` | `{ spec, timezone?, count? }` → `{ next: number[] }`（默认 5 个；只需 `data:read`；`once` 的时间可以是过去） |

校验错误（400）：`INVALID_SCHEDULE`（规则不合法、间隔 < 5、once 已过去、cron 永远不会触发）、`INVALID_TIMEZONE`、`UNKNOWN_KERNEL`、
`WORKFLOW_NOT_FOUND`、`SESSION_NOT_FOUND`；目标工作流不是自己能运行的 / 追加到别人的会话 → 403。

- **时区与夏令时**：按 `timezone` 的本地墙钟计算。不存在的本地时间（春季拨快，如 America/New_York 02:30）顺延到拨快后的同一分钟（03:30）；重复的本地时间（秋季拨回）只在第一次出现时触发。
- **调度器**：服务进程内定时器，对准最近的 `nextRunAt`（最长 60 秒复查），`nextRunAt` 持久化；触发前先推进 `nextRunAt`。once 触发后 `enabled=false`、`nextRunAt=null`。
  停用 → `nextRunAt=null`；重新启用 / 改规则 → 从当前时刻算下一次（不补停用期间的）。
- **错过的运行**（应用关闭 / 休眠）：迟到不超过设置 `scheduleMissedRunHours`（默认 24，0–168，0 = 不补跑）的只补跑**一次**（`missed: true`），否则记一条 `skipped`（“错过了 … 的运行（超出补跑窗口）”）并跳到下一次。
- 同一任务上一次还没结束时，新的触发记为 `skipped`（“上一次运行尚未结束”）。
- 以**任务负责人**的身份运行（owner/admin 立即运行别人的任务也一样）；负责人账号已删除 / 停用 → 该次 `failed`。
- 工作流目标：创建一次 `trigger: 'schedule'` 的 `WorkflowRun`，`ScheduleRun.workflowRunId` 指向它，状态随它结束。
- 提示词目标：`sessionMode: 'new'` 新建一个**普通（可见）**会话（标题 `[定时] <任务名> · <MM/DD HH:mm>`），`'append'` 在指定会话里发一条用户消息；回复后 `ScheduleRun.sessionId` 指向该会话。写工具同样自动拒绝（非交互）。

### 11.5 事件与审计
`/api/events`（只推给能看到对应工作流 / 定时任务的用户）：
- `workflow.run` `{ type: 'workflow.run', runId, workflowId, status }`：queued → running → succeeded / failed / cancelled。
- `workflow.node` `{ type: 'workflow.node', runId, workflowId, nodeId, status, delta? }`：状态变化（无 `delta`）与运行中的文本增量（`status: 'running'` + `delta`）。
- `schedule.run` `{ type: 'schedule.run', scheduleId, runId, name, status, error }`：开始（running）与结束（succeeded / failed / cancelled / skipped），用于通知铃铛。

审计动作：`workflow.create`（含复制）/ `workflow.update` / `workflow.delete` / `workflow.import` / `workflow.run` / `workflow.cancel`，
`schedule.create` / `schedule.update` / `schedule.delete` / `schedule.run_now` / `schedule.fire`（自动触发与补跑，记在负责人名下）。

## 变更记录
- 2026-10-20 初版。
- 2026-10-21 服务端 + 客户端：**会话权限级别**（6.11，迁移 20）。`Session.permissionLevel`、`defaultPermissionLevel` 取代 `toolApproval`（旧键双向同步）、`GET /api/permissions`、团队上限 `/api/team/permission-caps` 与 403 `PERMISSION_LEVEL_EXCEEDED`、SSE `start.permissionLevel`、LULUX MCP 桥按级别过滤 + Claude Code `approval_prompt`、全部 CLI 内核的参数映射；`full` 下仅 `mcp_add/update/remove` 仍需确认。
- 2026-10-20 服务端：**§10 企业级 P0**——商机 `/api/deals` 与按金额加权的漏斗（`/api/pipeline/stats` 增加 `deals`、`receivables`，原字段不变）；报价转订单 `POST /api/quotes/:id/order`、`/api/orders`、收款 `/api/orders/:id/payments`、`/api/receivables`（10.7、10.8，迁移 12）；8 个 Agent 工具（10.1）；结构化日志与 `X-Request-Id`（10.9）；备份恢复 `POST /api/data/backups/:name/restore`、`GET/DELETE /api/data/restore`（10.5）；JSON 导出含任务 / 商机 / 订单（10.10）；按需工具集设置 `toolLoading` 与 `tool_search`、同轮写工具串行（6.5.1）。
- 2026-10-20 服务端：**新 Agent id**（头像沿用作者原版设计的 `packages/client/public/agents/<旧 id>.png`，见 2026-10-21 更正）。persona 类（LULUX 自有角色，原职责不变）：
  | 新 id | 名称 | 职责 | 头像 | 旧 id（自动迁移） |
  | --- | --- | --- | --- | --- |
  | `lux-trade` | 远航 | 外贸业务：客户开发、报价与谈判 | `/agents/hermes.png` | `hermes` |
  | `lux-planner` | 拾序 | 任务拆解与执行 | `/agents/pi.png` | `pi` |
  | `lux-analyst` | 洞见 | 市场与竞品分析 | `/agents/grok.png` | `grok` |
  | `lux-data` | 织数 | 数据处理、表格与自动化 | `/agents/codex.png` | `codex` |
  | `lux-writer` | 执笔 | 商务写作与审校 | `/agents/claude.png` | `claude` |
  默认 Agent：`lux-trade`。旧库里 `session_members.agent_id`、`messages.sender_agent_id`、`settings.defaultAgentId` 中的旧 id 由迁移改写为新 id；接口仍接受旧 id 作为输入别名（自动映射），但只返回新 id。
  kernel 类（只有真实内核驱动，名称为第三方产品名）：`kernel-claude-code`（kernelId `claude-code`）、`kernel-codex`（`codex`）、`kernel-gemini-cli`（`gemini-cli`）、`kernel-qwen-code`（`qwen-code`）。头像见 2026-10-21 更正。
- 2026-10-20 服务端：开发态 Vite 端口实际为 `51790`（见 vite.config.ts），服务端在非 production 下同时放行 Origin `http://localhost:51790`、`http://127.0.0.1:51790`、`http://localhost:5173`、`http://127.0.0.1:5173`。**Vite proxy 必须设 `changeOrigin: true`**（否则 Host 是 `localhost:51790`，会被 Host 白名单 403）。
- 2026-10-20 服务端：**响应包装约定**。已有接口保持原包装：`GET /api/agents → { agents: Agent[] }`、`{ providers }`、`{ provider }`、`{ sessions }`、`{ session, messages }`、`{ messages }`、`{ servers }`、`{ server }`、`{ state }`、`GET/PATCH /api/settings → { settings }`。第 3 节新接口一律按契约返回裸结构：`GET /api/kernels → Kernel[]`、`GET /api/customers → { items, total }`、`GET /api/customers/:id → Customer`、`GET /api/products → Product[]`、`GET /api/quotes → Quote[]`、`GET /api/inquiry-rules → InquiryRule[]`、`GET /api/quote-templates → QuoteTemplate[]`、`GET /api/customers/:id/activities → Activity[]`，`GET /api/settings/schema → SettingSchema[]`。POST 新建返回 201 + 实体；DELETE 返回 204 无 body。新实体都额外带 `createdAt`/`updatedAt`（毫秒时间戳）。
- 2026-10-20 服务端：**设置值格式**。`GET /api/settings` 只返回白名单键，值仍是字符串（兼容旧版）：boolean 为 `'0'|'1'`，integer 为十进制字符串。`PATCH` 同时接受 `true/false`、数字与字符串，服务端规范化后存储；未知键 400 `UNKNOWN_SETTING`，非法值 400 `INVALID_SETTING`/`INVALID_URL`。白名单：`theme`(dark|light|system)、`language`(zh-CN|en-US)、`defaultProviderId`、`defaultAgentId`（接受旧 id，存新 id）、`contextLimit`(2–200)、`proxyUrl`、`webhookUrl`（仅 http/https）、`webhookEnabled`、`toolApproval`(ask|auto)、`allowMcpWithoutNativeConfirm`（默认 `'0'`）。schema 条目：`{ key, type: 'string'|'boolean'|'integer'|'enum', default, enum?, min?, max?, description }`。
- 2026-10-20 服务端：**Provider 公开结构** `{ id, name, kind, baseUrl, model, models, createdAt, hasApiKey, apiKeyPreview, apiKeyError }`；`apiKeyError` 正常为 null，主密钥变化导致无法解密时为中文提示（此时对话返回 409 `API_KEY_UNAVAILABLE`，请用户重新填 Key）。`PATCH` 里 `apiKey: ''` 表示保持原 Key。`baseUrl` 只接受 http/https。`discover-models` 15 秒超时，失败 502 `UPSTREAM_TIMEOUT|UPSTREAM_UNREACHABLE|UPSTREAM_ERROR`。
- 2026-10-20 服务端：**MCP**。`McpServer` 增加 `approved: boolean`。旧库里的 MCP 记录（以及未经确认的记录）不会自动启动，`state.status='error'`、`state.error` 提示需确认；客户端调用 `POST /api/mcp/servers/:id/refresh` 会触发原生确认，允许后才启动。只改 `name`/`enabled` 不需要确认；改 `command`/`args`/`env` 需要。拒绝 → 403 `MCP_COMMAND_REJECTED`。`env` 键名需匹配 `^[A-Za-z_][A-Za-z0-9_]*$`。
- 2026-10-20 服务端：**消息与 SSE**。`Message` 增加 `runtime: {kind:'provider',providerName,model} | {kind:'kernel',kernelId,version} | null`（用户消息为 null）。SSE：`start.provider` 可能为 null（会话全是内核 Agent 时）；`start.members[]` 与 `agent` 事件都带 `runtime` 与 `kind`；`done.message.runtime` 同上；`error` 事件为 `{ agentId?, name?, code, message }`，内核相关 code：`KERNEL_LOGIN_REQUIRED`（附带登录指引）、`KERNEL_FAILED`。发消息前的校验失败以普通 JSON 错误返回（不打开 SSE）：404 `NOT_FOUND`、400 `NO_PROVIDER|NO_MODEL|NO_AGENT`、409 `KERNEL_UNAVAILABLE|API_KEY_UNAVAILABLE`。工具调用与结果现在进入后续轮次的上下文。
- 2026-10-20 服务端：**内核**。`Kernel.requiresLogin` 对四个第三方内核恒为 true，`loginHint` 是给用户看的登录方法。kernel Agent 的 `unavailableReason`：`'未安装'`，或检测不到凭据时 `'需要登录'`（macOS 上 Claude Code 凭据在钥匙串里，无法检测，按可用处理，真正未登录时对话返回 `KERNEL_LOGIN_REQUIRED`）。安装需要本机有 npm（Node.js 22+）；没有时 `status='error'`、`error` 写明原因。`latestVersion` 后台查询 npmmirror，首次 GET 可能为 null，几秒后再取即有值。
- 2026-10-20 服务端：**其他细节**。`GET /api/health` → `{ ok: true }`（需要 token）。`POST /api/data/import` → `{ imported: Record<table, number>, backup: string }`（`backup` 为快照路径，可不展示）；导入不包含 API Key，已存在的 Provider 不覆盖。`GET /api/quotes/:id/html` 需要 token，客户端请用 fetch 取文本后放进 `iframe srcdoc`（或 Electron printToPDF），不能直接作为 iframe src；`?templateId=` 可选，默认用默认模板。`GET /api/quotes?customerId=` 可筛选。询盘规则按 `priority` 从大到小匹配，同优先级按创建时间；一条规则内所有条件同时满足才命中；没有命中时 `verdict='review'`、`matchedRuleId=null`。客户导入 `errors[].row` 为 1 起算的行号（对应 `rows` 数组下标 + 1）；`mapping` 可用字段：`company, country, website, stage, tags, source, notes, contactName, contactTitle, contactEmail, contactPhone, contactWhatsapp`（tags 列用逗号/分号分隔）。本机锁连续 5 次 PIN 错误后锁定 30 秒（429 `LOCK_RATE_LIMITED`）；`disable` PIN 错误 403 `LOCK_PIN_INVALID`；已启用时再 `setup` 409。
- 2026-10-20 服务端：**主窗口 CSP**（桌面主进程注入，服务端托管页面时也返回同样的头）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`。注意 `srcdoc` 产物 iframe 继承父页面 CSP，**产物 HTML 里的内联脚本不会执行**（这是有意的安全取舍，见审计 S0-2）；客户端不要在 index.html 里放内联脚本或外部 CDN 资源。主窗口里所有跨源导航与 `window.open` 都被拦截，http/https 交给系统浏览器；应用内链接请用路由，外链用 `window.luluxAgent.browser.openExternal(url)`（仅 http/https）。
- 2026-10-20 服务端：**邮箱/团队契约已定**（第 4 节邮箱、第 5 节团队与服务器模式；第 3 节“暂不实现”作废）。
- 2026-10-20 服务端：**内核网关与 scoped 模式**（第 7 节）。第三方内核默认 `scoped`：CLI 经本机 `/gateway/*`（Anthropic Messages / OpenAI Responses / Chat Completions / Gemini 兼容）使用会话的 LULUX Provider，不再需要各自登录；设置新增 `kernelModeClaudeCode|kernelModeCodex|kernelModeGeminiCli|kernelModeQwenCode`（`scoped|global`，默认 scoped）；`Kernel` 增加 `mode/modeSettingKey/scopedProvider`，`requiresLogin=mode==='global'`；kernel `unavailableReason` 增加 `'请先在模型与密钥中配置模型'`；kernel `runtime` 增加 `mode/providerName/model/label`。第 3 节 Kernels/Agents 中“需要登录”相关描述仅适用于 global 模式。客户端需加“内核模式”切换（7.4）。
- 2026-10-20 服务端：**内置内核**（第 6 节，审计见 `docs/BUILTIN-KERNEL.md`）。新增设置项 12 个；`POST /api/chat` 加 `targetAgentIds`/`context`；新增 `/api/chat/stop|regenerate|edit|pending|tools|capabilities|search-config`、`/api/chat/sessions/:id/context|export|messages/:mid/markdown`、`/api/usage`、`/api/usage/records`；SSE 新增 `reasoning`、`retry`、`downgrade`、`continuation`、`tool_limit`、`artifact`、`compaction`、`stopped`，`start`/`error`/`done`/`tool_*` 加字段；`/api/events` 新增 `session.title`；`Message` 加 `reasoning`/`usage`/`finishReason`；通用内置工具 8 个与业务工具同一注册表；`builtinTools='0'` 关闭全部内置工具，`kernelTools='0'` 只关通用工具。迁移 8（`builtin_kernel`）。
- 2026-10-21：**服务端持有的会话运行**（6.9）。断开 SSE 不再中止对话；同会话已有运行时 409 `RUN_ACTIVE`（取代“新请求中止旧的”）；新增 `GET /api/sessions/:id/stream?after=`、`POST /api/sessions/:id/cancel`、`GET /api/sessions/:id/run`、`GET /api/chat/runs`；`Session.running/activeRunId`；SSE 事件带 `id: <seq>`，新增 `replayed`；`/api/events` 新增 `session.run`；`Message.finishReason` 新增 `streaming`（草稿，逐步落库）/ `interrupted`（服务关闭或崩溃）。登录页两栏改名：本机 → “LULUX”，连接服务器 → “云端 LULUX”（英文 “LULUX” / “LULUX Cloud”）。
- 2026-10-20 服务端/打包：**内核安装不再需要本机 Node/npm**。桌面安装包随附 npm 12（`<resources>/npm`），服务端用自身运行时（Electron + `ELECTRON_RUN_AS_NODE=1`）执行 `npm-cli.js` 与内核 CLI 的 JS 入口，并在 `<dataDir>/kernels/.node-shim/` 生成 `node` 垫片供 postinstall / CLI 子进程使用；第 3 节 Kernels 中“安装需要本机有 npm”作废（开发态仍可用仓库 `node_modules/npm` 或本机 npm）。安装源：新增设置项 **`kernelRegistry`**（string，默认 `''` = `LULUX_KERNEL_REGISTRY` 或 `https://registry.npmmirror.com`；只接受 http/https，非法 400 `INVALID_SETTING`），网络/源类失败（ETIMEDOUT、ENOTFOUND、E404、E5xx、EINTEGRITY 等）自动回退 `https://registry.npmjs.org`（`LULUX_KERNEL_REGISTRY_FALLBACK` 可改，`off` 关闭），`GET /api/kernels/:id/log` 会记录换源；`latestVersion` 查询同样按源顺序。安装后检查平台二进制包（codex / claude-code 的 optionalDependencies），缺失时 `status='error'` 并说明。客户端可在内核设置页提供“安装源”输入框（PATCH `kernelRegistry`）。
- 2026-10-20 服务端：**删除会话**（`DELETE /api/sessions/:id`、`DELETE /api/data/sessions`）同时删除 `<dataDir>/workspace/<sessionId>/` 与各内核的 `kernels/<id>/home/<sessionId>/`。**MCP 取消**：对话停止或工具调用超时时向 MCP Server 发送 `notifications/cancelled { requestId, reason }`。
- 2026-10-20 服务端：**Skill 系统与 Agent 自配置**（第 8 节，编写指南与内置清单见 `docs/SKILLS.md`）。迁移 9；新增 `/api/skills*`、`/api/agents/:id/skills`、会话工作区文件接口（下载 / 列表 / 上传）；Agent 工具 `skill_list|skill_view|run_skill_script|skill_install|skill_create|skill_update|mcp_list|mcp_add|mcp_update|mcp_remove`（`/api/chat/tools` 的 `group` 增加 `skills|config`，不受 `kernelTools` 影响）；SSE 新增 `skill_preload`，`artifact` 增加 binary 形态（`binary/mime/downloadUrl`）；`tool_request` 与 `PendingToolRequest` 增加 `approvalKind/detail/canRemember`（`detail` 在参数校验失败时为 `{ invalid, errors, arguments }`，不为 null）；`McpServer` 增加 `transport/url/headerKeys/createdBy`，支持远程 Streamable HTTP MCP（只走普通审批，请求头加密存储只回键名）；设置新增 `skillsEnabled`。随包 38 个内置 skill（`packages/server/skills`，打包到 `<resources>/skills` / Docker `/app/server/skills`）。
- 2026-10-20 服务端：**Skill 收尾修复**。远程 HTTP MCP 经 `mcp_add` 添加后报 “This operation was aborted”：原因是 `mcp_add` 先 `sync()`（启动连接）再 `refresh()`（关闭进行中的连接并复用这次失败的 attempt）；现在 `refresh` 先等待进行中的连接结束再重连，被替换的旧连接不再覆盖状态，`mcp_add` 直接 `refresh`。`skill_create/skill_update` 的 `body` 最少 1 个字符（原 20）。`run_skill_script` 输出超限提示改为 `outputTruncated` 字段（位于 `stdout` 之前）。Skill 安装的审计 `entityId` 取 skill 名。
- 2026-10-20 桌面端：**第 9 节 桌面端 preload**。新增 `window.lulux { platform, titleBar, win, updater }`：标题栏按平台区分（mac `hiddenInset` 原生红绿灯在左上；Windows / Linux 无边框，界面右上角自绘 最小化 / 最大化(还原) / 关闭，关闭悬停红色），`win.onMaximizeChange` 推送最大化状态，窗口类 IPC 改为只接受本应用页面；自动更新 `window.lulux.updater`（electron-updater + GitHub Releases，见 `docs/AUTO-UPDATE.md`）。客户端代码注释里引用的“契约 §5.11”即本节 §9.1（§5.11 是部署）。
- 2026-10-20 服务端：**第 10 节 CRM 扩展**。Agent 业务工具新增 14 个（客户更新 / 跟进 / 报价查改 / PI PDF / 从邮件建客户 / 任务 / 漏斗 / 成员）；迁移 10（`tasks` + 索引）；`/api/tasks*`、`/api/pipeline/stats`、`/api/customers/export`、`/api/data/backups`；设置 `kernelCrmMcp`、`autoBackupHours`、`autoBackupKeep`；内置本地 LULUX MCP（`POST /gateway/mcp`）只在 scoped 内核运行时注入。
- 2026-10-21：**头像更正——恢复原版**。Agent 头像一律用作者原版设计的文件：persona `lux-trade→/agents/hermes.png`、`lux-planner→/agents/pi.png`、`lux-analyst→/agents/grok.png`、`lux-data→/agents/codex.png`、`lux-writer→/agents/claude.png`（按旧 id 一一对应）；kernel 类 Agent 的 `avatar` 为 `/icon.png`（LULUX 原版图标），客户端按 `kernelId` 显示原版内核管理页的标志 `src/assets/{claude,codex,gemini,qwen}.svg`。此前生成的 `/agents/lux-*.png`、`/agents/kernel-*.png` 已删除。头像不入库，读取时由目录算出，旧库无需迁移。
- 2026-10-21：**选择器只列内核**。persona 全部下线：旧 id（`lux-*`、`hermes`/`pi`/`grok`/`codex`/`claude`）作为输入别名映射到 `builtin`（迁移 13 改写旧库），`Agent.kind` 为 `builtin | kernel`。`GET /api/agents` 顺序：`builtin`（LULUX，`/icon.png`）、`kernel-hermes`（`/agents/hermes.png`）、`kernel-claude-code`（`/agents/claude.png`）、`kernel-codex`（`/agents/codex.png`）、`kernel-pi`（`/agents/pi.png`）、`kernel-grok`（`/agents/grok.png`）、`kernel-gemini-cli`、`kernel-qwen-code`（后两个 `/icon.png`，客户端显示原版 svg 标志）。每个 kernel 有 `tagline`（选择器里的一行说明）。
- 2026-10-21：**Grok 内核**（`kernel-grok`，kernelId `grok`，设置 `kernelModeGrok`）。xAI 官方 Grok Build CLI，npm `@xai-official/grok`（Apache-2.0）。安装版本要求 `>=1.0.0`（registry.npmmirror.com 上停在 0.1.x，镜像报 ETARGET 后自动回退 npmjs）；LULUX 自己把平台包里的 brotli 原生二进制解压到 `bin/grok-native` 直接运行。运行：`grok --prompt-file <0600 临时文件> --output-format streaming-json --no-alt-screen --always-approve --no-auto-update --tools read_file,list_dir,grep --no-subagents --no-plan --disable-web-search -m lulux`。scoped：`GROK_HOME=<隔离目录>`，`config.toml` 的 `[model.lulux]`（`base_url` = 网关 `/gateway/openai/v1`，`env_key=LULUX_GATEWAY_KEY`，`api_backend=chat_completions`），会话标题等旁路模型也指向 `lulux`；关闭 Claude / Cursor 兼容扫描；LULUX MCP 在 `[mcp_servers.lulux]`（`bearer_token_env_var=LULUX_MCP_TOKEN`）。Grok 1.0 的 MCP 工具总是按需发现（模型经 `search_tool` / `use_tool` 调 `lulux__<tool>`）。skill 同步到 `$GROK_HOME/skills`。global 模式用 CLI 自己的 `grok login` / `XAI_API_KEY`。实测：真实 Grok Build 1.0.62（linux-arm64）经网关 + LULUX MCP（`test/kernel-mcp-hermes-pi-real.test.ts`）。未验证：真实 xAI 账号登录（global 模式）、Windows / macOS 上的解压与运行。
- 2026-10-21：**图片输入**（6.2.1）。迁移 15 `messages.attachments`（14 为 `local_accounts`）；`/api/chat`、`/api/chat/edit` 新增 `attachments`；`Message.attachments`；SSE 新增 `vision` 事件，`downgrade.what` 增加 `'vision'`，`compaction` 增加 `kind:'images'`；错误码 `INVALID_ATTACHMENT`；mock-openai 新增 `GET /__mock/last`。
- 2026-10-21：**会话类型 `Session.kind: 'single' | 'group'`**（迁移 17，回填：成员多于一个的旧会话为 `group`）。群聊只能新建：`POST /api/sessions` 带 `kind:'group'`、`agentIds`、可选 `groupName` / `supervisorId`（默认 `builtin`），总是空历史的新会话；不带 `kind` 时按成员数推断。单聊恰好一个内核：`PATCH agentIds` 只能换成另一个内核（仍是单聊），多于一个、或给单聊设 `groupName` / `supervisorId` → `400 SESSION_KIND`；群聊内可增删成员（至少一个，仍是群聊）。是否群聊看 `kind`，不看成员数（编排、主管、客户端都改为按 `kind`）。内置内核显示名改为 **LULUX**（id 仍为 `builtin`）。
- 2026-10-21 服务端：**第 11 节 工作流与定时任务**。迁移 18：`workflows` / `workflow_runs` / `workflow_run_nodes` / `schedules` / `schedule_runs`，`sessions.workflow_run_id`（工作流节点的隐藏会话，不进会话列表）；新增设置 `scheduleMissedRunHours`；`/api/events` 新增 `workflow.run` / `workflow.node` / `schedule.run`；非交互运行的写工具按节点 `allowWrite` 自动批准 / 拒绝。
- 2026-10-21：**工作流客户端**。`Session` 新增 `workflowRunId: string | null`；工作流节点的隐藏会话只读（`409 WORKFLOW_SESSION_READONLY`），不生成自动标题，客户端侧栏兜底过滤；`ScheduleRun.missed` 在运行记录里显示“补跑”。节点 `kernelId` 两端都是 Agent id（`builtin` / `kernel-claude-code` …），内置内核显示为 **LULUX**。
- 2026-10-21 服务端/客户端：**账户隔离与多人群聊**（迁移 19 `session_participants`）。会话、工作流、定时任务改为**仅本人**（5.6a）：admin/owner 也看不到别人的，`visibility` 只接受 `private`、`teamId` 只接受 `null`，旧库一律改为 private；`GET /api/sessions?scope=all` 废弃（忽略）。群聊可邀请真人同事（6.10）：`Session.participants` / `myRole`，`Message.senderUserId` / `senderName`；新增 `GET /api/sessions/colleagues`、`/api/sessions/:id/participants`（GET/POST/PATCH/DELETE，`me` = 退出）、会话实时事件 `GET /api/sessions/:id/events`（`ready`/`message`/`session`/`run`/`removed`）；`/api/events` 新增 `session.message` / `session.updated` / `session.removed`；`POST /api/sessions` 新增 `userIds`；错误码 `NOT_GROUP_OWNER`、`OWNER_CANNOT_LEAVE`、`NOT_YOUR_MESSAGE`、`OTHERS_REPLIED`、`SERVER_MODE_ONLY`、`USER_NOT_FOUND`、`GROUP_FULL`。多人群聊里交给模型的用户消息带【发言人】前缀。
- 2026-10-21 服务端/客户端：**长期记忆**（6.12，迁移 21 `memory_entries` / `memory_prefs` / `memory_snapshots` / `memory_extractions`；合并会话权限级别后：记忆工具在任何权限级别（含“仅可查看”）都提供且免审批）。新增 `/api/memory*`；Agent 工具 `memory_add|memory_replace|memory_remove`（`ToolSpec.group` 增加 `memory`，`approval` 增加 `'never'`，新增 `personal`），同时经 LULUX MCP 暴露；内置内核系统提示与 CLI 内核提示词前置注入会话冻结快照；后台自动提取（`/api/events` 新增 `memory.updated`，usage `purpose` 增加 `memory`）；导出 / 导入含 `memory`；错误码 `MEMORY_REJECTED`、`MEMORY_FULL`、`MEMORY_ENTRY_TOO_LONG`、`MEMORY_NO_MATCH`、`MEMORY_AMBIGUOUS`。客户端：设置 → 记忆（开关、两个分区的条目增删改、用量条、清空全部），工具卡片“已更新记忆”。
- 2026-10-21 服务端/客户端：**记忆安全加固**（迁移 23 `memory_prefs.group_memory`、`sessions.origin`）。记忆工具在“仅可查看”、非交互运行（工作流 / 定时任务）、多人群聊里不再提供（取代上一条“任何权限级别都提供”的说法；设置页 / REST 管理不受影响）；多人群聊默认不注入记忆快照，新增账号开关 `groupMemory`（设置 → 记忆“群聊中使用我的记忆”）；guard 增加 NFKC、完整隐藏字符清洗、连字符统一与更宽的口令规则，`render()` 再清洗存量条目；自动提取跳过多人群聊、定时任务 / 工作流会话（持久化来源）与含 global CLI 内核的会话，`remove` 需整条匹配；global CLI 的会话模型运行时再按 `CLI_MODELS` 白名单校验（不在白名单 → 不传 `--model`）；客户端面板状态键改为 `lulux.panel.<accountId>.<sessionId>`（每账号保留最近 200 个）。未处理：停用账号的记忆不自动清理。
