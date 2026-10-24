/**
 * Server error message catalog (zh → en).
 *
 * Errors are thrown with Chinese messages; the error middleware translates them
 * for clients that ask for English (X-Lulux-Lang / Accept-Language).
 *
 * Each entry is `[zhTemplate, enTemplate]`. `{0}`, `{1}` … (or `{name}`) mark the
 * dynamic parts: they are captured from the Chinese message (or taken from
 * `AppError.params`) and substituted into the English template. Captured values
 * that are themselves Chinese are translated again through this catalog, so
 * nouns and nested messages (e.g. `发送失败：SMTP 连接失败：…`) come out in English.
 *
 * Keys are error codes. `_` holds shared messages: fragments (nouns, labels),
 * messages produced by helper errors (schedule specs, workflow graphs, skill
 * packages, zod validators) and anything reused across codes. Lookup order is
 * the error's own code, then `_`, then every other code.
 */
export type CatalogEntry = readonly [zh: string, en: string];

export const ERROR_CATALOG: Record<string, readonly CatalogEntry[]> = {
  // ── generic / HTTP layer ─────────────────────────────────────────
  BAD_REQUEST: [["请求格式不正确", "Malformed request"]],
  NOT_FOUND: [
    ["{0}不存在", "{0} not found"],
    ["接口不存在", "Endpoint not found"],
    ["负责人不存在或已停用", "Owner not found or disabled"],
    ["接收人不存在或已停用", "Recipient not found or disabled"],
  ],
  METHOD_NOT_ALLOWED: [["不支持的请求方法", "Method not allowed"]],
  PAYLOAD_TOO_LARGE: [["请求体过大", "Request body too large"]],
  UNSUPPORTED_MEDIA_TYPE: [
    ["请求体只接受 application/json", "Request body must be application/json"],
  ],
  NOT_IMPLEMENTED: [["未实现", "Not implemented"]],
  ERROR: [["请求失败", "Request failed"]],
  INVALID_JSON: [["请求体不是合法的 JSON", "Request body is not valid JSON"]],
  INTERNAL_ERROR: [
    ["服务器内部错误", "Internal server error"],
    ["对话处理失败", "The conversation failed to process"],
  ],
  HOST_NOT_ALLOWED: [["不允许的 Host", "Host not allowed"]],
  ORIGIN_NOT_ALLOWED: [
    ["不允许的跨源请求", "Cross-origin request not allowed"],
  ],
  FEATURE_DISABLED: [
    [
      "团队服务器默认禁用内核，需 owner 在“服务器安全”中开启",
      "Kernels are disabled on team servers by default; the owner can enable them under “Server security”",
    ],
    [
      "团队服务器默认禁用 MCP，需 owner 在“服务器安全”中开启",
      "MCP is disabled on team servers by default; the owner can enable it under “Server security”",
    ],
  ],
  NOT_AVAILABLE_IN_MODE: [
    [
      "团队服务器模式不使用本机锁",
      "The local lock is not used in team server mode",
    ],
    ["该接口仅在本机模式可用", "This endpoint is only available in local mode"],
    [
      "该接口仅在团队服务器模式可用",
      "This endpoint is only available in team server mode",
    ],
    [
      "团队服务器模式不支持从本机文件夹导入",
      "Importing from a local folder is not supported in team server mode",
    ],
    ["desktop 模式没有会话", "Desktop mode has no login sessions"],
    ["desktop 模式没有账号密码", "Desktop mode has no account password"],
  ],
  SERVER_MODE_ONLY: [
    [
      "只有团队服务器模式可以邀请同事进群",
      "Only team server mode can invite colleagues to a group",
    ],
  ],

  // ── validation ────────────────────────────────────────────────
  VALIDATION_ERROR: [
    ["需要提供 title、groupName、agentIds、members、supervisorId、permissionLevel、model 或 reasoningEffort", "Provide title, groupName, agentIds, members, supervisorId, permissionLevel, model or reasoningEffort"],
    ["agentIds 与 members 只能给一个", "Provide either agentIds or members, not both"],
    ["节点「{0}」的主管只能是 LULUX、无主管或本节点的成员", "The supervisor of node “{0}” must be LULUX, none, or one of the node’s members"],
    ["缺少 fromUserId", "fromUserId is required"],
    ["days 必须是数字", "days must be a number"],
    [
      "不能直接创建 owner；先创建为 admin，再转让所有权",
      "An owner cannot be created directly; create an admin first, then transfer ownership",
    ],
    ["请填写备份目录", "Enter a backup folder"],
    ["备份目录不正确", "Invalid backup folder"],
    ["备份目录必须是绝对路径", "The backup folder must be an absolute path"],
    [
      "不能把磁盘根目录作为备份目录",
      "A drive root cannot be used as the backup folder",
    ],
    [
      "不能使用系统目录作为备份目录",
      "A system folder cannot be used as the backup folder",
    ],
    [
      "备份目录不能是数据目录本身，请选择子目录或其他磁盘",
      "The backup folder cannot be the data folder itself; choose a subfolder or another drive",
    ],
    ["dir 必须是字符串或 null", "dir must be a string or null"],
    ["接收人不能是交接人本人", "The recipient cannot be the departing member"],
    [
      "有定时任务运行的是工作流，转移定时任务时需要一并转移工作流",
      "Some scheduled tasks run workflows; transfer workflows together with scheduled tasks",
    ],
    ["参数不是数字：{0}", "Not a number: {0}"],
    ["需要 sessionId", "sessionId is required"],
    ["内容不能为空", "Content cannot be empty"],
    ["目前只支持 format=markdown", "Only format=markdown is supported"],
    ["需要 providerId 或 model", "providerId or model is required"],
    ["SearXNG 需要填写服务地址", "SearXNG requires a service URL"],
    ["groupBy 只能是 {0}", "groupBy must be one of {0}"],
    [
      "远程 HTTP MCP 不能改成本机命令；请删除后重新添加",
      "A remote HTTP MCP server cannot be changed to a local command; delete it and add it again",
    ],
    [
      "本机命令 MCP 不能改成远程 HTTP；请删除后重新添加",
      "A local command MCP server cannot be changed to remote HTTP; delete it and add it again",
    ],
    ["请先填写代理地址", "Enter a proxy address first"],
    ["请先填写 Webhook 地址", "Enter a webhook URL first"],
    [
      "主管只能选择 LULUX、无主管或本群的成员",
      "The supervisor must be LULUX, none, or a member of this group",
    ],
    [
      "需要提供 title、groupName、agentIds、supervisorId、permissionLevel、model 或 reasoningEffort",
      "Provide title, groupName, agentIds, supervisorId, permissionLevel, model or reasoningEffort",
    ],
    ["标题不能为空", "Title cannot be empty"],
    ["群聊至少需要一个成员", "A group chat needs at least one member"],
    ["需要 path", "path is required"],
    [
      "只能共享给自己所在的团队",
      "You can only share with a team you belong to",
    ],
    [
      "共享给团队时必须指定团队（teamId）",
      "A team (teamId) is required when sharing with a team",
    ],
    [
      "不能单独设置的权限：{0}",
      "This permission cannot be set individually: {0}",
    ],
    [
      "不能直接邀请 owner；先邀请为 admin，再转让所有权",
      "You cannot invite an owner directly; invite them as admin, then transfer ownership",
    ],
    [
      "导入内容必须是导出格式的 JSON 对象",
      "Import content must be a JSON object in export format",
    ],
    [
      "OAuth 账户不能设置密码，请重新授权",
      "OAuth accounts cannot have a password; re-authorize instead",
    ],
    [
      "附件内容为空或不是合法的 base64",
      "Attachment is empty or not valid base64",
    ],
    ["messageId 与 customerId 至少提供一个", "Provide messageId or customerId"],
    ["记忆内容不能为空", "Memory content cannot be empty"],
    [
      "请提供要修改的条目 id 或 old_text（条目里的一段原文）",
      "Provide the entry id or old_text (a passage from the entry) to modify",
    ],
    ["模型名不合法：{0}", "Invalid model name: {0}"],
    ["柜型只能是：{0}", "Container type must be one of: {0}"],
    [
      "追加到会话时需要 sessionId",
      "sessionId is required when appending to a session",
    ],
    ["请求体必须是设置项对象", "Request body must be an object of settings"],
    ["不能删除 SKILL.md", "SKILL.md cannot be deleted"],
    ["请提供文件夹的绝对路径", "Provide an absolute folder path"],
    ["文件夹不存在", "Folder does not exist"],
    ["参数校验失败（{0}）", "Validation failed ({0})"],
  ],
  INVALID_URL: [
    ["搜索服务地址格式不正确", "Invalid search service URL"],
    [
      "搜索服务地址只支持 http/https",
      "Search service URL must use http or https",
    ],
    ["地址格式不正确", "Invalid URL"],
    ["只支持 http/https 地址", "Only http/https URLs are supported"],
    ["不允许访问该地址", "Access to this address is not allowed"],
    ["{0}格式不正确", "{0} is invalid"],
    [
      "{0}只支持 http:// 或 https://",
      "{0} must start with http:// or https://",
    ],
    ["{0}缺少主机名", "{0} is missing a host name"],
  ],
  INVALID_SETTING: [["设置项 {0} {1}", "Setting {0}: {1}"]],
  UNKNOWN_SETTING: [["未知设置项：{0}", "Unknown setting: {0}"]],
  CONFIRM_REQUIRED: [
    [
      "开启前请确认风险（confirm: 'I_UNDERSTAND'）：{0}",
      "Confirm the risk before enabling (confirm: 'I_UNDERSTAND'): {0}",
    ],
  ],

  // ── auth / login / accounts ───────────────────────────────────
  UNAUTHORIZED: [
    ["缺少或无效的访问令牌", "Missing or invalid access token"],
    ["请先登录", "Please sign in first"],
  ],
  SESSION_EXPIRED: [
    [
      "登录已过期，请重新登录",
      "Your session has expired; please sign in again",
    ],
  ],
  USER_DISABLED: [
    [
      "账号已停用，请联系管理员",
      "This account is disabled; contact your administrator",
    ],
    ["对方账号已停用", "That account is disabled"],
  ],
  LOCAL_LOGIN_REQUIRED: [
    ["请先登录本机账户", "Sign in to the local account first"],
  ],
  LOGIN_RATE_LIMITED: [
    [
      "尝试次数过多，请 {0} 分钟后再试",
      "Too many attempts; try again in {0} min",
    ],
    ["尝试次数过多，请 {0} 秒后再试", "Too many attempts; try again in {0} s"],
  ],
  LOCK_RATE_LIMITED: [
    ["尝试次数过多，请 {0} 秒后再试", "Too many attempts; try again in {0} s"],
  ],
  SETUP_ALREADY_DONE: [
    ["已经初始化过管理员", "The administrator has already been set up"],
  ],
  SETUP_TOKEN_INVALID: [
    [
      "setup token 不正确（见服务启动日志或数据目录下的 setup-token 文件）",
      "Incorrect setup token (see the server start-up log or the setup-token file in the data directory)",
    ],
  ],
  SETUP_REQUIRED: [
    [
      "服务器尚未初始化，请先创建管理员",
      "The server is not set up yet; create an administrator first",
    ],
  ],
  INVALID_CREDENTIALS: [
    ["邮箱或密码错误", "Incorrect email or password"],
    ["用户名或密码错误", "Incorrect username or password"],
  ],
  PASSWORD_INCORRECT: [["当前密码不正确", "Current password is incorrect"]],
  WEAK_PASSWORD: [
    ["密码至少 8 个字符", "Password must be at least 8 characters"],
    ["密码最多 128 个字符", "Password must be at most 128 characters"],
    ["密码不能与邮箱相同", "Password cannot be the same as your email"],
    ["密码不能与用户名相同", "Password cannot be the same as your username"],
  ],
  INVITE_EMAIL_MISMATCH: [
    [
      "这个邀请只能用指定的邮箱接受",
      "This invitation can only be accepted with the invited email",
    ],
  ],
  EMAIL_TAKEN: [["该邮箱已注册", "This email is already registered"]],
  INVITE_INVALID: [["邀请码无效", "Invalid invitation code"]],
  INVITE_EXPIRED: [
    [
      "邀请已过期、已用完或已撤销",
      "The invitation has expired, been used up, or been revoked",
    ],
  ],
  CANNOT_MODIFY_OWNER: [
    [
      "owner 始终拥有全部权限，不能单独设置",
      "The owner always has every permission; it cannot be set individually",
    ],
    [
      "管理员不能修改 owner 或授予 owner 角色",
      "Admins cannot modify the owner or grant the owner role",
    ],
    ["管理员不能重置 owner 的密码", "Admins cannot reset the owner's password"],
    ["管理员不能邀请 owner", "Admins cannot invite an owner"],
  ],
  CANNOT_MODIFY_SELF: [
    ["不能修改自己的权限", "You cannot change your own permissions"],
    [
      "不能修改自己的角色或停用自己",
      "You cannot change your own role or disable yourself",
    ],
    ["不能转让给自己", "You cannot transfer to yourself"],
  ],
  LAST_OWNER: [["至少要保留一个 owner", "At least one owner must remain"]],
  USERNAME_INVALID: [
    ["用户名需要 2–32 个字符", "Username must be 2–32 characters"],
    [
      "用户名只能包含字母、数字、中文和 . _ -",
      "Username may only contain letters, digits, Chinese characters and . _ -",
    ],
  ],
  USERNAME_TAKEN: [["这个用户名已经存在", "This username already exists"]],
  LOCAL_ACCOUNT_EXISTS: [
    [
      "这台电脑已经有本机账户，请先登录",
      "This computer already has a local account; please sign in",
    ],
  ],
  RECOVERY_CODE_INVALID: [
    ["用户名或恢复码不正确", "Incorrect username or recovery code"],
  ],
  RESET_FILE_MISSING: [
    ["数据目录里没有 {0} 文件", "There is no {0} file in the data directory"],
  ],
  LOCAL_ACCOUNT_NOT_FOUND: [["没有这个本机账户", "No such local account"]],
  RESET_FILE_LOCKED: [
    [
      "无法删除 {0} 文件，请手动删除后重试",
      "Could not delete the {0} file; delete it manually and retry",
    ],
  ],
  LOCK_ALREADY_ENABLED: [
    [
      "本机锁已启用，请先停用后再重新设置",
      "The local lock is already enabled; disable it before setting it again",
    ],
  ],
  LOCK_PIN_INVALID: [["PIN 不正确", "Incorrect PIN"]],
  USER_NOT_FOUND: [
    [
      "只能邀请本组织在用的同事",
      "You can only invite active colleagues in your organization",
    ],
  ],

  // ── permissions ───────────────────────────────────────────────
  FORBIDDEN: [
    ["只有 owner 可以修改", "Only the owner can change this"],
    ["自动发送只能由用户在界面上开启", "Auto-send can only be turned on by the user in the app"],
    ["只能控制自己会话里的浏览器", "You can only control the browser in your own sessions"],
    ["只能控制自己会话里的电脑操作", "You can only control computer use in your own sessions"],
    ["只有 owner 或管理员可以操作", "Only the owner or an admin can do this"],
    ["只有 owner 可以创建管理员", "Only the owner can create admins"],
    [
      "只有 owner / admin 可以彻底删除回收站里的记录",
      "Only the owner or an admin can permanently delete records in the trash",
    ],
    ["没有权限：{0}", "Permission denied: {0}"],
    [
      "只能修改自己负责的{0}",
      "This {0} is owned by someone else; you can only modify your own",
    ],
    ["只能修改自己的{0}", "You can only modify your own {0}"],
    [
      "只有 owner 可以操作内核 / MCP",
      "Only the owner can manage kernels / MCP",
    ],
    ["只能停止自己会话里的对话", "You can only stop runs in your own sessions"],
    [
      "只能审批自己会话里的工具调用",
      "You can only approve tool calls in your own sessions",
    ],
    [
      "只有群主或群管理员可以修改群设置",
      "Only the group owner or group admins can change group settings",
    ],
    [
      "只能向自己的会话上传文件",
      "You can only upload files to your own sessions",
    ],
    [
      "只有 owner 或管理员可以修改成员权限",
      "Only the owner or admins can change member permissions",
    ],
    [
      "只有 owner 可以修改管理员的权限",
      "Only the owner can change an admin's permissions",
    ],
    ["只有 owner 可以转让所有权", "Only the owner can transfer ownership"],
    [
      "只有 owner 可以修改服务器安全选项",
      "Only the owner can change server security options",
    ],
    [
      "只能在自己的会话里发消息",
      "You can only send messages in your own sessions",
    ],
    [
      "只有管理员可以转移商机负责人",
      "Only admins can change the owner of a deal",
    ],
    ["不能用别人的邮箱发送", "You cannot send from someone else's mailbox"],
    [
      "只能为自己负责的工作流设置定时任务",
      "You can only schedule workflows you own",
    ],
    ["只能追加到自己的会话", "You can only append to your own sessions"],
  ],
  PERMISSION_LEVEL_EXCEEDED: [
    [
      "管理员限制你最高只能使用“{0}”权限",
      "Your administrator limits you to the “{0}” permission level",
    ],
  ],

  // ── chat / sessions / groups ──────────────────────────────────
  TOOL_REQUEST_EXPIRED: [
    [
      "这次工具调用已结束或已超时",
      "This tool call has already finished or timed out",
    ],
  ],
  MESSAGE_NOT_FOUND: [["消息不存在", "Message not found"]],
  NOT_YOUR_MESSAGE: [
    [
      "只能编辑或重新生成自己发的消息",
      "You can only edit or regenerate your own messages",
    ],
  ],
  OTHERS_REPLIED: [
    [
      "之后已有同事发言，不能再编辑或重新生成这条消息",
      "A colleague has replied since; this message can no longer be edited or regenerated",
    ],
  ],
  WORKFLOW_SESSION_READONLY: [
    [
      "这是工作流节点的运行会话，只能查看",
      "This is a workflow node run session and is read-only",
    ],
  ],
  SESSION_KIND: [
    ["成员资料只属于群聊；请用 kind: group 新建群聊", "Member profiles only apply to group chats; create one with kind: group"],
    ["成员资料只属于群聊；请新建群聊", "Member profiles only apply to group chats; create a group chat"],
    ["单聊只能有一个内核；同一内核多个成员请新建群聊", "A single chat has exactly one kernel; create a group chat to add the same kernel more than once"],
    ["只有群聊能设置成员资料", "Only group chats have member profiles"],
    [
      "群名与主管只属于群聊；请用 kind: group 新建群聊",
      "Group name and supervisor only apply to group chats; create one with kind: group",
    ],
    [
      "单聊只能有一个内核；要多个成员一起聊，请新建群聊",
      "A direct chat has a single kernel; create a group chat to talk with several members",
    ],
    [
      "群名与主管只属于群聊；请新建群聊",
      "Group name and supervisor only apply to group chats; create a group chat",
    ],
    [
      "单聊不能邀请同事；请新建群聊",
      "You cannot invite colleagues to a direct chat; create a group chat",
    ],
    [
      "单聊只能有一个内核；多个成员请新建群聊",
      "A direct chat has a single kernel; create a group chat for several members",
    ],
  ],
  COMPUTER_UNAVAILABLE: [
    [
      "电脑操作不可用：需要桌面端本地模式，并在设置里打开“电脑操作（实验性）”",
      "Computer use is unavailable: it needs the desktop app in local mode, with “Computer use (experimental)” turned on in Settings",
    ],
  ],
  NOT_GROUP_OWNER: [
    [
      "只有群主可以解散群聊；你可以退出群聊",
      "Only the group owner can dissolve the group; you can leave it",
    ],
    [
      "只有群主可以设置群管理员",
      "Only the group owner can appoint group admins",
    ],
    [
      "只有群主可以移出群管理员",
      "Only the group owner can remove group admins",
    ],
  ],
  OWNER_CANNOT_LEAVE: [
    [
      "群主不能退出或被移出；可以解散群聊",
      "The group owner cannot leave or be removed; dissolve the group instead",
    ],
  ],
  GROUP_FULL: [
    ["一个群最多 {0} 位同事", "A group can have at most {0} colleagues"],
  ],
  SESSION_NOT_FOUND: [
    ["会话不存在", "Session not found"],
    [
      "要追加的会话不存在或没有权限",
      "The session to append to does not exist or you lack access",
    ],
  ],
  FILE_TOO_LARGE: [
    ["单个文件不能超过 10 MB", "A single file cannot exceed 10 MB"],
  ],
  FILE_EXISTS: [
    [
      "同名文件已存在；如需覆盖请设置 overwrite",
      "A file with this name already exists; set overwrite to replace it",
    ],
  ],
  WORKSPACE_FULL: [
    [
      "会话工作区已超过 50 MB 上限",
      "The session workspace exceeds the 50 MB limit",
    ],
  ],
  INVALID_ATTACHMENT: [],
  NO_AGENT: [["会话没有可用的 Agent", "This session has no available agent"]],
  NOTHING_TO_REGENERATE: [
    ["没有可以重新生成的用户消息", "There is no user message to regenerate"],
  ],
  NOT_USER_MESSAGE: [["只能编辑用户消息", "Only user messages can be edited"]],
  EMPTY_REPLY: [["模型没有返回内容", "The model returned no content"]],
  RUN_ACTIVE: [
    [
      "这个会话正在运行，请等它完成或先停止",
      "This session is running; wait for it to finish or stop it first",
    ],
  ],

  // ── providers / models / kernels ──────────────────────────────
  KERNEL_UNAVAILABLE: [
    ["「{0}」暂不可用：{1}", "“{0}” is unavailable: {1}"],
    ["{0} 未安装", "{0} is not installed"],
  ],
  NO_PROVIDER: [
    [
      "请先在设置中添加一个模型 Provider",
      "Add a model provider in Settings first",
    ],
  ],
  NO_MODEL: [
    [
      "Provider「{0}」还没有选择模型，请到设置中完成配置",
      "Provider “{0}” has no model selected; finish setting it up in Settings",
    ],
  ],
  API_KEY_UNAVAILABLE: [["Provider「{0}」的 {1}", "Provider “{0}”: {1}"]],
  UNKNOWN_MODEL: [
    ["{0} 不支持模型「{1}」", "{0} does not support model “{1}”"],
    ["Provider「{0}」没有模型「{1}」", "Provider “{0}” has no model “{1}”"],
  ],
  UNKNOWN_PROVIDER: [
    ["Provider 不存在", "Provider not found"],
    [
      "节点「{0}」的 Provider 不存在：{1}",
      "Provider for node “{0}” not found: {1}",
    ],
  ],
  GROUP_MEMBERS: [
    ["群里至少要有一个 Agent 成员", "A group chat needs at least one agent member"],
    ["群成员里没有可用的内核", "None of the group members is a known kernel"],
    ["节点「{0}」是群聊讨论，至少需要一个成员", "Node “{0}” is a group discussion and needs at least one member"],
  ],
  GROUP_MEMBER_LIMIT: [
    ["同一内核最多 {0} 个成员", "At most {0} members per kernel"],
    ["一个群最多 {0} 个 Agent 成员", "A group chat has at most {0} agent members"],
  ],
  UNKNOWN_KERNEL: [
    ["节点「{0}」的成员内核不存在：{1}", "Member kernel for node “{0}” not found: {1}"],
    ["内核不存在：{0}", "Kernel not found: {0}"],
    ["节点「{0}」的内核不存在：{1}", "Kernel for node “{0}” not found: {1}"],
  ],
  UPSTREAM_ERROR: [
    ["服务商返回 {0}：{1}", "Provider returned {0}: {1}"],
    [
      "服务商返回的不是 JSON，请检查 Base URL",
      "The provider did not return JSON; check the Base URL",
    ],
    ["服务商没有返回任何模型", "The provider returned no models"],
    ["模型没有返回内容", "The model returned no content"],
    ["{0}：{1}", "{0}: {1}"],
  ],
  UPSTREAM_TIMEOUT: [
    ["模型调用失败：超时", "Model call failed: timed out"],
    [
      "连接服务商超时（{0} 秒）",
      "Connecting to the provider timed out ({0} s)",
    ],
  ],
  UPSTREAM_UNREACHABLE: [
    ["无法连接服务商：{0}", "Cannot reach the provider: {0}"],
  ],
  KERNEL_FAILED: [
    [
      "{0}（经由 LULUX 模型）运行失败：{1}",
      "{0} (via LULUX model) failed: {1}",
    ],
    ["{0}（经由 LULUX 模型）运行失败", "{0} (via LULUX model) failed"],
    ["{0} 运行失败：{1}", "{0} failed: {1}"],
    ["{0} 运行失败", "{0} failed"],
    ["无法启动 {0}：{1}", "Could not start {0}: {1}"],
  ],
  KERNEL_LOGIN_REQUIRED: [
    [
      "{0} 需要登录：{1}（内核返回：{2}）",
      "{0} requires sign-in: {1} (kernel said: {2})",
    ],
    ["{0} 需要登录：{1}", "{0} requires sign-in: {1}"],
  ],
  KERNEL_BUILTIN: [
    [
      "内置内核无需安装或卸载",
      "The built-in kernel does not need to be installed or uninstalled",
    ],
  ],
  KERNEL_BUSY: [
    ["该内核正在处理中，请稍后", "This kernel is busy; try again shortly"],
  ],
  KERNEL_NOT_INSTALLED: [["内核尚未安装", "Kernel is not installed"]],
  MCP_COMMAND_REJECTED: [
    [
      "用户在确认对话框中拒绝了这个 MCP 命令",
      "The user rejected this MCP command in the confirmation dialog",
    ],
    [
      "没有桌面端原生确认通道。如在浏览器开发态使用，请先在设置中开启 allowMcpWithoutNativeConfirm",
      "No native desktop confirmation channel. For browser development, enable allowMcpWithoutNativeConfirm in settings",
    ],
  ],
  PROXY_UNREACHABLE: [["代理连接失败：{0}", "Proxy connection failed: {0}"]],
  WEBHOOK_FAILED: [
    ["Webhook 发送失败：{0}", "Webhook delivery failed: {0}"],
    ["Webhook 返回 HTTP {0}", "Webhook returned HTTP {0}"],
  ],

  // ── CRM: customers / quotes / deals / orders ─────────────────
  BAD_ARGS: [
    ["参数 {0} 必须是整数", "Parameter {0} must be an integer"],
    ["币种代码不正确：{0}/{1}", "Invalid currency codes: {0}/{1}"],
    ["只能给收到的邮件打询盘分", "Only received emails can be scored as inquiries"],
    ["序列步骤不存在", "Sequence step not found"],
    ["单证类型只能是 ci / pl / co", "Document type must be ci / pl / co"],
    ["请输入品名", "Enter a product name"],
    ["订单只有 {0} 行明细，没有第 {1} 行", "The order has only {0} line(s); there is no line {1}"],
    ["这封没有草稿，无法发送", "This email has no draft and can't be sent"],
    ["发送时段的开始要早于结束", "The sending window must start before it ends"],
    ["{0} 暂不支持报价计算，目前支持 EXW / FOB / CFR / CIF / DDP", "{0} is not supported for price calculation yet; supported: EXW / FOB / CFR / CIF / DDP"],
    ["targetUnitPrices 有 {0} 个，明细有 {1} 条，数量必须一致", "targetUnitPrices has {0} values but there are {1} line items; they must match"],
    ["第 {0} 行「{1}」缺少 unitCost（单位成本）", "Row {0} “{1}” is missing unitCost"],
    ["运费按 cbm 计价时，每条明细都要填 cbmPerUnit（单位体积）", "When freight is priced per cbm, every line item needs cbmPerUnit"],
    ["{0} 报价需要海运费：请直接填运费（costs.freight），或提供 {1} 从运价表查", "{0} pricing needs ocean freight: enter it directly (costs.freight), or provide {1} to look it up in the freight rate table"],
    ["运价表里没有 {0}{1} {2} 的有效运价：请直接填运费，或先在运价表里添加这条航线", "No valid freight rate for {0}{1} {2}; enter the freight directly or add this lane to the freight rate table"],
    ["参数不是整数：{0}", "Not an integer: {0}"],
  ],
  PROVIDER_RATE_LIMITED: [
    [
      "数据源「{0}」请求过于频繁，请稍后再试",
      "The data source “{0}” is rate-limiting requests; try again later",
    ],
  ],
  PROVIDER_UPSTREAM: [
    [
      "数据源「{0}」暂时不可用，请稍后再试",
      "The data source “{0}” is unavailable right now; try again later",
    ],
    [
      "数据源暂时不可用，请稍后再试",
      "The data source is unavailable right now; try again later",
    ],
  ],
  CUSTOMER_NOT_FOUND: [["客户不存在", "Customer not found"]],
  PROSPECT_ALREADY_CONVERTED: [["该潜客已经转为客户，不能重复转换", "This prospect has already been converted to a customer"]],
  FX_UNAVAILABLE: [
    ["汇率暂时获取不到，请稍后再试，或在设置里手动锁定汇率", "Exchange rates are unavailable right now; try again later or lock a rate in Settings"],
    ["汇率数据里没有币种 {0}，请稍后再试或在设置里手动锁定", "No exchange rate for {0}; try again later or lock a rate in Settings"],
  ],
  SANCTIONS_DOWNLOAD_FAILED: [["制裁名单下载失败：{0}", "Sanctions list download failed: {0}"]],
  CUSTOMER_HAS_RECORDS: [
    [
      "该客户名下还有 {0}（含回收站），请先彻底删除这些记录再删除客户",
      "This customer still has {0} (including the trash); permanently delete those records before deleting the customer",
    ],
    [
      "该客户名下有 {0}，不能删除。请先转移或处理这些记录。",
      "This customer has {0} and cannot be deleted. Transfer or resolve those records first.",
    ],
  ],
  QUOTE_NOT_FOUND: [["报价单不存在", "Quote not found"]],
  QUOTE_CUSTOMER_MISMATCH: [
    ["报价单不属于该客户", "The quote does not belong to this customer"],
  ],
  QUOTE_NUMBER_TAKEN: [
    [
      "报价单号 {0} 被回收站里的报价单占用，彻底删除后才能复用",
      "Quote number {0} is used by a quote in the trash; permanently delete it to reuse the number",
    ],
    ["报价单号 {0} 已存在", "Quote number {0} already exists"],
  ],
  QUOTE_REJECTED: [
    [
      "已拒绝的报价不能转为订单",
      "A rejected quote cannot be converted to an order",
    ],
  ],
  QUOTE_EMPTY: [
    [
      "报价没有明细或金额为 0，不能转为订单",
      "The quote has no line items or a zero total and cannot be converted to an order",
    ],
  ],
  LOST_REASON_REQUIRED: [
    [
      "标记输单时必须填写输单原因",
      "A reason is required when marking a deal as lost",
    ],
  ],
  DEAL_CUSTOMER_MISMATCH: [
    ["商机不属于该客户", "The deal does not belong to this customer"],
  ],
  ORDER_EXISTS: [["该报价已生成订单 {0}", "This quote already has order {0}"]],
  ORDER_NUMBER_TAKEN: [
    [
      "订单号 {0} 被回收站里的订单占用，彻底删除后才能复用",
      "Order number {0} is used by an order in the trash; permanently delete it to reuse the number",
    ],
    ["订单号 {0} 已存在", "Order number {0} already exists"],
  ],
  ORDER_CANCELLED: [
    [
      "已取消的订单不能登记收款",
      "Payments cannot be recorded on a cancelled order",
    ],
  ],
  CURRENCY_MISMATCH: [
    [
      "收款币种必须与订单一致（{0}）",
      "Payment currency must match the order ({0})",
    ],
  ],
  PAYMENT_EXCEEDS_BALANCE: [
    [
      "收款金额超过应收余额 {0} {1}",
      "Payment exceeds the outstanding balance of {0} {1}",
    ],
  ],
  INVALID_IMPORT: [
    ["导入内容不是合法的 JSON", "Import content is not valid JSON"],
    ["导入内容不是工作流", "Import content is not a workflow"],
    ["不支持的导入格式：{0}", "Unsupported import format: {0}"],
  ],
  BACKUP_FAILED: [["备份失败：{0}", "Backup failed: {0}"]],
  BACKUP_INVALID: [],
  INVALID_BACKUP_NAME: [["备份文件名不正确", "Invalid backup file name"]],

  // ── email ─────────────────────────────────────────────────────
  EMAIL_AUTH_FAILED: [
    [
      "{0} 登录失败：{1}（请确认已开启 IMAP/SMTP，并使用授权码 / 应用专用密码）",
      "{0} sign-in failed: {1} (make sure IMAP/SMTP is enabled and use an authorization code / app password)",
    ],
  ],
  EMAIL_CONNECT_FAILED: [["{0} 连接失败：{1}", "{0} connection failed: {1}"]],
  EMAIL_SECRET_UNAVAILABLE: [
    [
      "邮箱密码无法用当前主密钥解密，请在邮箱设置里重新填写",
      "The mailbox password cannot be decrypted with the current master key; re-enter it in mailbox settings",
    ],
    [
      "邮箱凭据无法用当前主密钥解密，请重新授权",
      "The mailbox credentials cannot be decrypted with the current master key; re-authorize",
    ],
  ],
  EMAIL_ACCOUNT_EXISTS: [
    ["你已经添加过这个邮箱", "You have already added this mailbox"],
  ],
  NO_EMAIL_ACCOUNT: [["请先添加一个邮箱账户", "Add a mailbox first"]],
  DRAFT_ALREADY_SENT: [
    ["草稿已发送，不能修改", "The draft has been sent and cannot be changed"],
    ["草稿已发送", "The draft has already been sent"],
    ["草稿正在发送", "The draft is being sent"],
    ["草稿已发送或正在发送", "The draft has been sent or is being sent"],
  ],
  ATTACHMENT_TOO_LARGE: [["附件超过 15 MB", "Attachment exceeds 15 MB"]],
  NO_RECIPIENTS: [["请填写收件人", "Enter at least one recipient"]],
  EMAIL_SEND_FAILED: [["发送失败：{0}", "Sending failed: {0}"]],
  EMAIL_SYNC_FAILED: [["同步失败：{0}", "Sync failed: {0}"]],
  NO_HTML: [["这封邮件没有 HTML 正文", "This email has no HTML body"]],
  ALREADY_LINKED: [
    ["这封邮件已经关联了客户", "This email is already linked to a customer"],
  ],
  ATTACHMENT_NOT_SYNCED: [
    [
      "邮件尚未同步到服务器，暂时无法下载附件",
      "The email has not been synced to the server yet; attachments cannot be downloaded",
    ],
  ],
  ATTACHMENT_GONE: [
    [
      "服务器上的邮箱已重建，请重新同步后再下载",
      "The mailbox was rebuilt on the server; sync again before downloading",
    ],
    [
      "服务器上已找不到这封邮件",
      "This email can no longer be found on the server",
    ],
    ["附件已不存在", "The attachment no longer exists"],
  ],
  OAUTH_EXCHANGE_FAILED: [
    [
      "连接授权服务器失败：{0}",
      "Could not reach the authorization server: {0}",
    ],
    ["授权服务器拒绝：{0}", "The authorization server refused: {0}"],
    [
      "服务商没有返回 refresh token（请确认 scope 含 offline_access / access_type=offline）",
      "The provider returned no refresh token (make sure the scope includes offline_access / access_type=offline)",
    ],
    [
      "无法从授权结果读取邮箱地址",
      "Could not read the email address from the authorization result",
    ],
  ],
  EMAIL_REAUTH_REQUIRED: [
    [
      "OAuth 授权已失效，请重新授权该邮箱",
      "OAuth authorization has expired; re-authorize this mailbox",
    ],
    [
      "OAuth 刷新失败，请重新授权：{0}",
      "OAuth refresh failed; re-authorize: {0}",
    ],
  ],
  OAUTH_NOT_CONFIGURED: [
    [
      "请先在设置里填写 {0} OAuth Client ID",
      "Enter the {0} OAuth Client ID in Settings first",
    ],
  ],
  OAUTH_STATE_EXPIRED: [
    [
      "授权会话不存在或已过期，请重新发起",
      "The authorization session does not exist or has expired; start again",
    ],
  ],

  // ── memory ────────────────────────────────────────────────────
  MEMORY_ENTRY_TOO_LONG: [
    [
      "单条记忆最多 {0} 字（当前 {1} 字），请拆成更短的条目",
      "A memory entry can be at most {0} characters (currently {1}); split it into shorter entries",
    ],
  ],
  MEMORY_FULL: [
    [
      "「{0}」已用 {1}/{2} 字，再写入 {3} 字会超出预算。请先用 memory_replace 合并 / 精简，或用 memory_remove 删掉过时的条目，再重试。",
      "“{0}” uses {1}/{2} characters; writing {3} more would exceed the budget. Merge or trim with memory_replace, or delete stale entries with memory_remove, then retry.",
    ],
  ],
  MEMORY_NO_MATCH: [
    ["没有找到包含「{0}」的记忆条目", "No memory entry contains “{0}”"],
  ],
  MEMORY_AMBIGUOUS: [
    [
      "有 {0} 条记忆都包含「{1}」，请给出更长、唯一的一段原文",
      "{0} memory entries contain “{1}”; give a longer, unique passage",
    ],
  ],
  MEMORY_REJECTED: [
    [
      "内容像是改变助手行为的指令（提示注入），不能存入记忆。",
      "The content looks like an instruction to change the assistant’s behavior (prompt injection) and cannot be saved to memory.",
    ],
    [
      "内容疑似包含密码、密钥、Token 或银行卡号，记忆里不能保存凭据。",
      "The content appears to contain a password, key, token or card number; credentials cannot be saved to memory.",
    ],
  ],

  // ── workflows / schedules ─────────────────────────────────────
  INVALID_TIMEZONE: [
    ["不是有效的 IANA 时区名：{0}", "Not a valid IANA time zone: {0}"],
  ],
  INVALID_SCHEDULE: [
    [
      "一次性任务的时间已经过去",
      "The time for this one-off task has already passed",
    ],
    ["cron 表达式永远不会触发", "The cron expression never fires"],
  ],
  WORKFLOW_NOT_FOUND: [["工作流不存在", "Workflow not found"]],
  EMPTY_WORKFLOW: [["工作流里还没有节点", "The workflow has no nodes yet"]],

  // ── skills ────────────────────────────────────────────────────
  SKILL_NOT_FOUND: [
    ["找不到 skill：{0}", "Skill not found: {0}"],
    [
      "安装包里没有这个内置 skill",
      "This built-in skill is not in the install package",
    ],
  ],
  SKILL_BUILTIN_READONLY: [
    [
      "内置 skill 不能删除，只能禁用",
      "Built-in skills cannot be deleted, only disabled",
    ],
    [
      "内置 skill 是只读的；需要改动请用 skill_create 另建一个",
      "Built-in skills are read-only; use skill_create to make your own copy",
    ],
  ],
  SKILL_NOT_BUILTIN: [
    [
      "只有内置 skill 可以恢复默认",
      "Only built-in skills can be restored to default",
    ],
  ],
  SKILL_BUILTIN_CONFLICT: [
    [
      "「{0}」是内置 skill，不能被覆盖；请换一个 name",
      "“{0}” is a built-in skill and cannot be overwritten; choose another name",
    ],
  ],
  SKILL_EXISTS: [
    [
      "已存在同名 skill「{0}」；如需覆盖请设置 overwrite",
      "A skill named “{0}” already exists; set overwrite to replace it",
    ],
    [
      "已存在同名 skill「{0}」，请用 skill_update 修改或换个名字",
      "A skill named “{0}” already exists; use skill_update or choose another name",
    ],
  ],
  SKILL_DOWNLOAD_FAILED: [
    ["下载失败：重定向次数过多", "Download failed: too many redirects"],
    ["下载失败：HTTP {0}（{1}）", "Download failed: HTTP {0} ({1})"],
    ["下载失败：{0}", "Download failed: {0}"],
  ],

  // ── shared: fragments and helper-error messages ──────────────
  // ── merged features: member lifecycle, backups, rate limits, mailbox privacy, CRM dedupe / trash ──
  PASSWORD_CHANGE_REQUIRED: [
    [
      "管理员为你设置了临时密码，请先修改密码",
      "An admin set a temporary password for you; change your password first",
    ],
  ],
  BACKUP_DIR_INVALID: [
    ["无法创建备份目录：{0}", "Cannot create the backup folder: {0}"],
    ["备份目录不是文件夹", "The backup path is not a folder"],
    ["备份目录不可写：{0}", "The backup folder is not writable: {0}"],
  ],
  BACKUP_PENDING_RESTORE: [
    [
      "这个快照已选为下次启动时恢复，请先取消恢复",
      "This snapshot is scheduled to be restored at next startup; cancel the restore first",
    ],
  ],
  RATE_LIMITED: [
    [
      "你同时进行中的对话已达上限（{0} 个），请等其中一个完成或先停止后再发送",
      "You have reached the limit of {0} concurrent conversations; wait for one to finish or stop one before sending",
    ],
    [
      "发送太频繁：每分钟最多发起 {0} 次对话，请约 {1} 秒后再试",
      "Too many messages: at most {0} conversations per minute; try again in about {1} seconds",
    ],
  ],
  CONFIRM_SEND_AS: [
    [
      "将以成员邮箱 {0} 的身份发出，请确认后再发送",
      "This will be sent as the member mailbox {0}; confirm before sending",
    ],
  ],
  MAILBOX_PRIVATE: [
    [
      "组织未开启“管理员可查看成员邮箱”，不能查看或使用该成员的邮件内容",
      "The organization has not enabled “Admins can view member mailboxes”; this member's email content cannot be viewed or used",
    ],
  ],
  CUSTOMER_DUPLICATE: [
    [
      "可能与已有客户「{0}」（负责人 {1}）重复（{2}相同）",
      "Possible duplicate of existing customer “{0}” (owner {1}): same {2}",
    ],
  ],
  CUSTOMER_IN_TRASH: [
    [
      "所属客户也在回收站里，请先恢复客户",
      "The customer is also in the trash; restore the customer first",
    ],
  ],
  ORDER_IN_TRASH: [
    [
      "该报价单的订单 {0} 在回收站里，请先恢复或彻底删除它",
      "This quote's order {0} is in the trash; restore it or delete it permanently first",
    ],
  ],
  DOCS_INCOMPLETE: [["单证资料还不完整：{0}", "Shipping document data is incomplete: {0}"]],
  SEQUENCE_STATE: [
    ["只能暂停进行中的联系人", "Only active contacts can be paused"],
    ["只能恢复已暂停的联系人", "Only paused contacts can be resumed"],
    ["对方在退订名单里，不能恢复", "This contact unsubscribed and can't be resumed"],
    ["这封已经处理过了", "This email has already been handled"],
  ],
  _: [
    ["群聊讨论最多 12 个成员", "A group discussion has at most 12 members"],
    ["每一步都要有主题", "Every step needs a subject"],
    ["不能为负数", "Cannot be negative"],
    ["每一步都要有正文", "Every step needs a body"],
    ["请填写序列名称", "Please enter a sequence name"],
    ["最多 {0} 步", "At most {0} steps"],
    ["至少要有一步", "Add at least one step"],
    ["邮箱格式不对", "Invalid email address"],
    ["公司名", "company name"],
    ["网站", "website"],
    ["联系人邮箱", "contact email"],
    ["邮箱域名", "email domain"],
    ["电话", "phone"],
    ["{0} 个任务", "{0} task(s)"],
    // nouns used by notFound() / ownership checks
    ["会话", "Session"],
    ["报价模板", "Quote template"],
    ["客户", "Customer"],
    ["潜客", "Prospect"],
    ["运价", "Freight rate"],
    ["产品（第 {0} 行）", "Product (row {0})"],
    ["目的港不能为空", "Destination port cannot be empty"],
    ["运价必须大于 0", "Freight rate must be greater than 0"],
    ["锁汇的键应形如 USD/CNY（三位大写币种）", "Locked rate keys must look like USD/CNY (three-letter uppercase codes)"],
    ["锁定的汇率必须大于 0", "A locked rate must be greater than 0"],
    ["体积不能为负数", "Volume cannot be negative"],
    ["重量不能为负数", "Weight cannot be negative"],
    ["保险费率不能超过 10%", "Insurance rate cannot exceed 10%"],
    ["退税率不能超过 17%", "Export rebate rate cannot exceed 17%"],
    ["pricing 里 marginPct / markupPct / targetUnitPrices 只能选一种", "pricing accepts only one of marginPct / markupPct / targetUnitPrices"],
    ["毛利率不能超过 95%", "Margin cannot exceed 95%"],
    ["毛利率不能为负数", "Margin cannot be negative"],
    ["加成率不能为负数", "Markup cannot be negative"],
    ["目标单价必须大于 0", "Target unit price must be greater than 0"],
    ["明细最多 200 条", "At most 200 line items"],
    ["至少需要一条明细", "At least one line item is required"],
    ["汇率键应形如 USD/CNY", "Rate keys must look like USD/CNY"],
    ["必须指定“公司”对应的列", "Choose which column holds the company name"],
    ["国家代码必须是 2 位字母（ISO 3166-1 alpha-2）", "Country code must be 2 letters (ISO 3166-1 alpha-2)"],
    ["HS 编码必须是 2–10 位数字", "HS code must be 2–10 digits"],
    ["名单文件超过 80MB 上限", "The list file exceeds the 80 MB limit"],
    ["解析结果为空（格式可能已变化）", "Parsed no entries (the format may have changed)"],
    ["报价单", "Quote"],
    ["内核", "Kernel"],
    ["任务", "Task"],
    ["附件", "Attachment"],
    ["邮箱账户", "Mailbox"],
    ["询盘规则", "Inquiry rule"],
    ["记忆条目", "Memory entry"],
    ["草稿", "Draft"],
    ["序列", "Sequence"],
    ["序列联系人", "Sequence contact"],
    ["发送记录", "Send record"],
    ["群成员", "Group member"],
    ["文件", "File"],
    ["产品", "Product"],
    ["邮件", "Email"],
    ["运行记录", "Run"],
    ["订单", "Order"],
    ["收款记录", "Payment"],
    ["工作流", "Workflow"],
    ["定时任务", "Scheduled task"],
    ["商机", "Deal"],
    ["成员", "Member"],
    ["团队", "Team"],
    ["邀请", "Invitation"],
    ["备份文件", "Backup file"],
    ["地址", "URL"],
    ["测试地址", "Test URL"],
    ["请求体", "body"],
    // permission labels
    ["读取数据", "read data"],
    ["修改业务数据", "modify business data"],
    ["导出数据", "export data"],
    ["导入数据", "import data"],
    ["删除客户", "delete customers"],
    ["导入客户", "import customers"],
    ["删除商机", "delete deals"],
    ["删除报价单", "delete quotes"],
    ["删除订单或收款记录", "delete orders or payments"],
    ["删除任务", "delete tasks"],
    ["管理工作流与定时任务", "manage workflows and schedules"],
    ["修改产品库", "modify the product catalog"],
    ["修改组织设置", "modify organization settings"],
    ["管理模型与密钥", "manage models and keys"],
    ["管理成员", "manage members"],
    ["查看审计日志", "view audit logs"],
    ["发送邮件", "send email"],
    ["管理服务器安全选项", "manage server security options"],
    // permission levels, memory sections, record counts
    ["仅可查看", "Read only"],
    ["需审批", "Ask for approval"],
    ["完全权限", "Full access"],
    ["用户画像", "User profile"],
    ["记忆", "Memory"],
    ["{0} 个订单", "{0} order(s)"],
    ["{0} 条收款", "{0} payment(s)"],
    ["{0} 个报价", "{0} quote(s)"],
    ["{0} 个商机", "{0} deal(s)"],
    // kernel availability, provider keys, secrets
    ["服务器已禁用内核", "Kernels are disabled on this server"],
    ["未安装", "Not installed"],
    ["需要登录", "Sign-in required"],
    [
      "请先在模型与密钥中配置模型",
      "Configure a model under Models & Keys first",
    ],
    ["未知原因", "unknown reason"],
    ["API Key 无法读取", "API key cannot be read"],
    [
      "密钥无法用当前主密钥解密，请在设置中重新填写",
      "The key cannot be decrypted with the current master key; re-enter it in Settings",
    ],
    [
      "在终端运行 `hermes setup` 或 `hermes model` 选择 Provider 并配置 Key 后重启 LULUX ETA",
      "Run `hermes setup` or `hermes model` in a terminal to choose a provider and set a key, then restart LULUX ETA",
    ],
    [
      "在终端运行 `claude` 并执行 /login 完成登录，或设置环境变量 ANTHROPIC_API_KEY 后重启 LULUX ETA",
      "Run `claude` in a terminal and use /login, or set ANTHROPIC_API_KEY, then restart LULUX ETA",
    ],
    [
      "在终端运行 `codex login` 完成登录，或设置环境变量 OPENAI_API_KEY 后重启 LULUX ETA",
      "Run `codex login` in a terminal, or set OPENAI_API_KEY, then restart LULUX ETA",
    ],
    [
      "在终端运行 `pi` 并执行 /login，或设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量后重启 LULUX ETA",
      "Run `pi` in a terminal and use /login, or set ANTHROPIC_API_KEY / OPENAI_API_KEY, then restart LULUX ETA",
    ],
    [
      "在终端运行 `grok login`，或设置环境变量 XAI_API_KEY 后重启 LULUX ETA",
      "Run `grok login` in a terminal, or set XAI_API_KEY, then restart LULUX ETA",
    ],
    [
      "在终端运行 `gemini` 完成 Google 登录，或设置环境变量 GEMINI_API_KEY 后重启 LULUX ETA",
      "Run `gemini` in a terminal to sign in with Google, or set GEMINI_API_KEY, then restart LULUX ETA",
    ],
    [
      "在终端运行 `qwen` 完成登录（Qwen OAuth 或配置 OpenAI 兼容 Key）后重启 LULUX ETA",
      "Run `qwen` in a terminal to sign in (Qwen OAuth or an OpenAI-compatible key), then restart LULUX ETA",
    ],
    [
      "开启后，内核 / MCP 会以服务进程身份在服务器上执行命令，任何能对话的成员都可能借此读取服务器文件与密钥。仅在可信团队、隔离容器中开启。",
      "When enabled, kernels / MCP run commands on the server as the service process, so any member who can chat could read server files and keys. Enable only for trusted teams in an isolated container.",
    ],
    ["备份文件不存在", "Backup file not found"],
    ["已取消", "Cancelled"],
    ["无法连接模型服务：{0}", "Cannot reach the model service: {0}"],
    [
      "模型返回了空回复，正在重试",
      "The model returned an empty reply; retrying",
    ],
    // schedule specs
    ["时间格式应为 HH:mm：{0}", "Time must be HH:mm: {0}"],
    ["时间超出范围：{0}", "Time out of range: {0}"],
    ["cron {0}字段不合法：{1}", "Invalid cron {0} field: {1}"],
    ["cron {0}步长不合法：{1}", "Invalid cron {0} step: {1}"],
    ["cron {0}范围不合法：{1}", "Invalid cron {0} range: {1}"],
    [
      "cron {0}超出范围（{1}-{2}）：{3}",
      "cron {0} out of range ({1}-{2}): {3}",
    ],
    [
      "cron 表达式需要 5 个字段：分 时 日 月 星期",
      "A cron expression needs 5 fields: minute hour day month weekday",
    ],
    [
      "一次性任务需要有效的时间（毫秒时间戳）",
      "A one-off task needs a valid time (millisecond timestamp)",
    ],
    ["间隔至少 {0} 分钟", "The interval must be at least {0} minutes"],
    ["间隔不能超过一年", "The interval cannot exceed one year"],
    ["每周任务至少选择一天", "Pick at least one day for a weekly task"],
    ["星期取值 0-6（0 = 周日）", "Weekdays are 0-6 (0 = Sunday)"],
    ["未知的定时类型", "Unknown schedule type"],
    ["分", "minute"],
    ["时", "hour"],
    ["日", "day"],
    ["月", "month"],
    ["星期", "weekday"],
    // workflow graph
    ["节点 id 重复：{0}", "Duplicate node id: {0}"],
    ["连线 id 重复：{0}", "Duplicate edge id: {0}"],
    [
      "连线 {0} 指向不存在的节点",
      "Edge {0} points to a node that does not exist",
    ],
    ["节点「{0}」连向了自己", "Node “{0}” connects to itself"],
    ["连线形成了环：{0}", "The edges form a cycle: {0}"],
    // skill packages
    ["SKILL.md frontmatter 不合法：{0}", "Invalid SKILL.md frontmatter: {0}"],
    ["SKILL.md 缺少 name", "SKILL.md is missing name"],
    [
      "name「{0}」不合法：只能用小写字母、数字和连字符（不能以连字符开头或结尾），最长 64 个字符",
      "Invalid name “{0}”: use lowercase letters, digits and hyphens only (not at the start or end), up to 64 characters",
    ],
    [
      "name「{0}」必须与目录名「{1}」一致",
      "name “{0}” must match the directory name “{1}”",
    ],
    ["SKILL.md 缺少 description", "SKILL.md is missing description"],
    ["description 过长（{0} > {1}）", "description is too long ({0} > {1})"],
    ["第 {0} 行：\\u 转义不正确", "Line {0}: invalid \\u escape"],
    ["第 {0} 行：不支持的转义 \\{1}", "Line {0}: unsupported escape \\{1}"],
    ["第 {0} 行：双引号未闭合", "Line {0}: unclosed double quote"],
    ["第 {0} 行：单引号未闭合", "Line {0}: unclosed single quote"],
    [
      "第 {0} 行：不支持 YAML 锚点/别名/标签",
      "Line {0}: YAML anchors/aliases/tags are not supported",
    ],
    ["第 {0} 行：缩进不正确", "Line {0}: incorrect indentation"],
    ["第 {0} 行：应为“键: 值”", "Line {0}: expected “key: value”"],
    ["第 {0} 行：重复的键 {1}", "Line {0}: duplicate key {1}"],
    ["第 {0} 行：非法键名", "Line {0}: invalid key name"],
    [
      "第 {0} 行：YAML 不能用 Tab 缩进",
      "Line {0}: YAML cannot be indented with tabs",
    ],
    ["第 {0} 行：{1}", "Line {0}: {1}"],
    [
      "frontmatter 顶层必须是键值映射",
      "The frontmatter top level must be a key-value mapping",
    ],
    [
      "SKILL.md 必须以 --- 开头的 YAML frontmatter 开始",
      "SKILL.md must start with YAML frontmatter opened by ---",
    ],
    [
      "frontmatter 缺少结束的 ---",
      "The frontmatter is missing its closing ---",
    ],
    [
      "frontmatter 结束的 --- 必须独占一行",
      "The closing --- of the frontmatter must be on its own line",
    ],
    ["路径包含非法字符：{0}", "Path contains invalid characters: {0}"],
    ["不允许绝对路径：{0}", "Absolute paths are not allowed: {0}"],
    ["不允许路径穿越（..）：{0}", "Path traversal (..) is not allowed: {0}"],
    ["目录层级过深：{0}", "Directory nesting too deep: {0}"],
    ["路径过长：{0}…", "Path too long: {0}…"],
    [
      "文件名包含 Windows 不允许的字符：{0}",
      "File name contains characters Windows does not allow: {0}",
    ],
    ["不允许符号链接：{0}", "Symbolic links are not allowed: {0}"],
    [
      "包里没有 SKILL.md（应位于根目录或唯一的顶层目录下）",
      "The package has no SKILL.md (it should be at the root or in the single top-level directory)",
    ],
    ["文件过多（{0} > {1}）", "Too many files ({0} > {1})"],
    [
      "文件名重复（不区分大小写）：{0}",
      "Duplicate file name (case-insensitive): {0}",
    ],
    ["文件过大：{0}（{1} 字节）", "File too large: {0} ({1} bytes)"],
    ["文件过大：{0}", "File too large: {0}"],
    ["总大小超过上限（{0} MB）", "Total size exceeds the limit ({0} MB)"],
    ["文件与目录同名：{0}", "A file and a directory share the name: {0}"],
    ["文件过多（> {0}）", "Too many files (> {0})"],
    ["文件过多（{0}）", "Too many files ({0})"],
    ["总大小超过上限", "Total size exceeds the limit"],
    ["skill 名称不合法：{0}", "Invalid skill name: {0}"],
    ["路径不能为空", "Path cannot be empty"],
    ["路径超出 skill 目录", "Path is outside the skill directory"],
    ["文件不存在：{0}", "File not found: {0}"],
    ["不允许读取符号链接", "Reading symbolic links is not allowed"],
    [
      "路径通过符号链接指向了 skill 目录以外",
      "Path points outside the skill directory through a symbolic link",
    ],
    ["不是文件：{0}", "Not a file: {0}"],
    ["压缩包过大（> {0} MB）", "Archive too large (> {0} MB)"],
    ["下载内容过大", "Downloaded content is too large"],
    ["在 {0}/{1}{2} 没有找到 SKILL.md", "No SKILL.md found in {0}/{1}{2}"],
    [
      "不是有效的 zip 文件（找不到目录）",
      "Not a valid zip file (central directory not found)",
    ],
    ["不是有效的 zip 文件", "Not a valid zip file"],
    ["不支持 ZIP64", "ZIP64 is not supported"],
    [
      "压缩包内文件过多（{0} > {1}）",
      "Too many files in the archive ({0} > {1})",
    ],
    ["zip 目录损坏", "The zip directory is corrupt"],
    ["不支持加密的 zip", "Encrypted zip files are not supported"],
    [
      "解压后总大小超过上限（{0} 字节）",
      "Uncompressed size exceeds the limit ({0} bytes)",
    ],
    ["zip 条目损坏：{0}", "Corrupt zip entry: {0}"],
    ["zip 条目截断：{0}", "Truncated zip entry: {0}"],
    ["解压失败：{0}", "Decompression failed: {0}"],
    ["不支持的压缩方式 {0}：{1}", "Unsupported compression method {0}: {1}"],
    ["zip 条目大小不符：{0}", "Zip entry size mismatch: {0}"],
    ["zip 条目校验失败：{0}", "Zip entry checksum failed: {0}"],
    // field validators (zod)
    ["每条消息最多 {0} 张图片", "At most {0} images per message"],
    ["环境变量过多", "Too many environment variables"],
    ["环境变量名不合法", "Invalid environment variable name"],
    [
      "需要 command（本机命令）或 url（远程 HTTP），二选一",
      "Provide either command (local) or url (remote HTTP)",
    ],
    [
      "需要 command（本机命令型 MCP）或 url（远程 HTTP MCP），二选一",
      "Provide either command (local MCP) or url (remote HTTP MCP)",
    ],
    ["名称不能为空", "Name cannot be empty"],
    ["命令不能为空", "Command cannot be empty"],
    ["邮箱格式不正确", "Invalid email address"],
    ["不能为空", "Cannot be empty"],
    ["公司名不能为空", "Company name cannot be empty"],
    ["id 格式不正确", "Invalid id format"],
    ["日期格式应为 YYYY-MM-DD", "Date must be YYYY-MM-DD"],
    ["商机名称不能为空", "Deal name cannot be empty"],
    ["必须选择客户", "A customer must be selected"],
    ["金额不能为负数", "Amount cannot be negative"],
    ["主机名格式不正确", "Invalid host name"],
    ["主机不能为空", "Host cannot be empty"],
    ["邮箱地址格式不正确", "Invalid email address"],
    ["请填写密码 / 授权码", "Enter the password / authorization code"],
    ["收件人地址格式不正确", "Invalid recipient address"],
    ["条件值不能为空", "Condition value cannot be empty"],
    ["正则表达式无效", "Invalid regular expression"],
    ["规则名不能为空", "Rule name cannot be empty"],
    ["至少需要一个条件", "At least one condition is required"],
    ["PIN 必须是 4–12 位数字", "PIN must be 4–12 digits"],
    ["至少提供一个开关", "Provide at least one toggle"],
    ["收款金额必须大于 0", "Payment amount must be greater than 0"],
    ["请填写到账日期", "Enter the received date"],
    [
      "币种必须是 3 位字母代码，如 USD",
      "Currency must be a 3-letter code such as USD",
    ],
    ["产品名不能为空", "Product name cannot be empty"],
    ["价格不能为负数", "Price cannot be negative"],
    ["HS 编码只能包含数字和点", "HS code may only contain digits and dots"],
    ["品名不能为空", "Item name cannot be empty"],
    ["数量必须大于 0", "Quantity must be greater than 0"],
    ["单价不能为负数", "Unit price cannot be negative"],
    [
      "Logo 必须是 png/jpeg/webp/gif 的 data URL",
      "Logo must be a png/jpeg/webp/gif data URL",
    ],
    ["Logo 太大（上限约 1 MB）", "Logo is too large (limit about 1 MB)"],
    ["模板名不能为空", "Template name cannot be empty"],
    ["提示词不能为空", "Prompt cannot be empty"],
    [
      "远程 MCP 地址必须是 http(s) 地址，且不能包含账号密码",
      "A remote MCP URL must be http(s) and must not contain credentials",
    ],
    ["不能设置协议保留的请求头", "Protocol-reserved headers cannot be set"],
    ["请求头过多", "Too many headers"],
    ["请求头名称不合法", "Invalid header name"],
    [
      "截止时间格式不正确（ISO 日期，如 2026-10-25 或 Sun 2026-10-25 9:00 AM CST (UTC+08:00)）",
      "Invalid due date (ISO date such as 2026-10-25 or Sun 2026-10-25 9:00 AM CST (UTC+08:00))",
    ],
    ["节点名称不能为空", "Node name cannot be empty"],
    ["节点最多 {0} 个", "At most {0} nodes"],
    ["连线最多 {0} 条", "At most {0} edges"],
    [
      "只支持 http:// 或 https:// 地址",
      "Only http:// or https:// URLs are supported",
    ],
    [
      "仅本人可见，不支持共享（team / org）",
      "Visible only to you; sharing (team / org) is not supported",
    ],
    [
      "会话仅本人可见，不支持共享（team / org）",
      "Sessions are visible only to you; sharing (team / org) is not supported",
    ],
  ],
};
