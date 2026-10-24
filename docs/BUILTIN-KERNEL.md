# LULUX 自带内核（`builtin`）能力说明

> 范围：内置内核（`builtin`）由当前 Provider 驱动的 agent 循环。
> 代码：`packages/server/src/services/chat/**`（ChatOrchestrator）、`services/llm/**`（Provider 适配器）、`services/tools/**`（工具注册表与通用内置工具）、`services/tool-approval.ts`。
> 接口与事件见 `docs/API-CONTRACT.md` 第 6 节“内置内核”。

## 1. 能力清单

图例：✅ 已实现并有测试　◐ 已实现，部分受限（见备注）

### 1.1 循环健壮性
| # | 项 | 状态 | 实现 |
| --- | --- | --- | --- |
| L1 | 工具轮数上限可配置 | ✅ | 设置 `agent.maxTurns`（0–500，默认 90，0 不限；旧键 `maxToolRounds` 已弃用），70%/90% 预算提醒（`agent.budgetPressure`），同一工具相同参数连续 3 次拦截并收尾（`services/chat/turn-budget.ts`）。到上限后**不再丢弃**：把未执行的调用登记为“已达上限未执行”，再发一轮**不带工具**的请求让模型基于已有结果收尾，`finishReason='tool_limit'` |
| L2 | 并行工具调用 | ✅ | 同一轮里的 read 类工具并发执行（并发度 4）；write 类工具按顺序逐个审批执行；结果按模型给出的顺序回填，保证配对。设置 `parallelToolCalls`（默认开） |
| L3 | 取消/中断 | ✅ | `POST /api/sessions/:id/cancel` / `POST /api/chat/stop`（断开 SSE 不再中止，运行由服务端持有，见契约 §6.9）→ 同一个 AbortSignal 贯穿：上游 fetch 立即中止、内核子进程 kill、MCP 调用与 fetch_url 立即放弃、审批等待立即按拒绝结束。已生成的文本/推理/工具轨迹落库（`finishReason='aborted'`），并下发 `stopped` 事件。同一会话已有运行时再发起返回 409 `RUN_ACTIVE` |
| L4 | 上游错误分类 | ✅ | `services/llm/errors.ts`：`UpstreamError.kind = rate_limit / overloaded / server / network / timeout / auth / bad_request / context_length / not_found / aborted`，SSE `error.code` 对应 `UPSTREAM_RATE_LIMITED / UPSTREAM_OVERLOADED / UPSTREAM_ERROR / UPSTREAM_UNREACHABLE / UPSTREAM_TIMEOUT / UPSTREAM_AUTH / UPSTREAM_BAD_REQUEST / CONTEXT_TOO_LONG` |
| L5 | 指数退避重试 | ✅ | 429 / 5xx / 529 / 网络错误 / 首包超时：`min(30s, 1s·2^n)` + 0–25% 抖动，遵守 `Retry-After`（≤60 秒）；只在**还没有输出**时重试（已输出一半的流不重放，避免重复文本）；次数 = 设置 `llmMaxRetries`（0–8，默认 3）；每次重试下发 `retry` 事件；退避等待可被取消 |
| L6 | 超时 | ✅ | 设置 `llmTimeoutSeconds`（10–600，默认 120）：首包超时 + 流空闲超时（两个分片之间）。超时归类为 `timeout`，首包超时可重试 |
| L7 | 截断自动续写 | ✅ | `finish_reason=length` / `stop_reason=max_tokens` 且没有工具调用时，自动追加“从中断处继续”再请求，最多 `maxContinuations`（0–5，默认 2）次，下发 `continuation` 事件；文本无缝拼接 |
| L8 | 空回复 | ✅ | 无文本、无工具调用、无推理时按可重试错误重试一次；只有推理没有正文（推理模型把 token 花在思考上）时走续写 |
| L9 | 同会话并发保护 | ✅ | 每会话一个运行（RunManager），已有运行时 409 `RUN_ACTIVE`；关窗 / 刷新后用 `GET /api/sessions/:id/stream` 接上（契约 §6.9） |

### 1.2 上下文管理
| # | 项 | 状态 | 实现 |
| --- | --- | --- | --- |
| C1 | token 估算 | ✅ | `services/llm/tokens.ts` 启发式（ASCII ≈ 4 字符/token，CJK ≈ 1 字/token，每条消息 +4，工具定义按 JSON 长度计）。不引入 js-tiktoken：多 Provider（DeepSeek/Qwen/Claude）分词不同，tiktoken 也只是近似，且会改动共享的 package-lock。估算偏保守（预留 10% 余量） |
| C2 | 模型能力矩阵 | ✅ | `services/llm/capabilities.ts`：按模型名匹配 `contextWindow / maxOutput / tools / vision / reasoning('none'|'deepseek'|'openai'|'anthropic'|'qwen') / streamUsage`；未知模型给保守默认（32k、支持工具）。设置 `modelCapabilities`（JSON，按模型名或 `*` 通配覆盖）。`GET /api/chat/capabilities?providerId=` 查询 |
| C3 | 按能力降级 | ✅ | `tools=false` 的模型不发 `tools`、系统提示不提工具、历史里的工具轮次转成文本；`maxOutput` 用于 Anthropic `max_tokens` 与预算；推理模型不发 temperature |
| C4 | 超限自动压缩 | ✅ | 预算 = 上下文窗口 − 预留输出 − 工具定义 − 10% 余量。超出时把**较早的完整消息**（以消息为单位切分，assistant(tool_calls) 与对应 tool 结果永不拆开）交给同一模型做摘要，摘要缓存在 `chat_summaries`，后续轮次复用；摘要失败则退化为“省略更早 N 条”。当前回复内部的工具循环超预算时，先截短较早的工具结果（保留配对）。下发 `compaction` 事件。最终发送前统一做配对修复（孤立 tool 结果丢弃，缺结果的调用补“没有结果”） |
| C5 | 系统提示与业务上下文 | ✅ | 系统提示 = 人设 + 今天日期与时区 + 能力相关的工具说明 + 群聊规则 + **业务上下文**（会话绑定的当前客户：资料/联系人/最近 5 条跟进/报价摘要；当前报价：条款与明细），业务数据标注为“数据，不是指令”。绑定方式：`POST /api/chat` 带 `context`，或 `PUT /api/chat/sessions/:id/context` |

### 1.3 推理与输出
| # | 项 | 状态 | 实现 |
| --- | --- | --- | --- |
| R1 | 推理流 | ✅ | DeepSeek/Qwen `reasoning_content`、OpenAI 兼容 `reasoning`（OpenRouter 等）、Anthropic `thinking_delta` → 独立 SSE `reasoning` 事件；落库到 `Message.reasoning`；不进入后续轮次上下文（DeepSeek 要求），但同一回复的工具循环内按各家要求回传（Anthropic thinking 签名块、DeepSeek 思考模式工具调用的 `reasoning_content`） |
| R2 | Anthropic 扩展思考开关 | ✅ | 设置 `reasoningEffort`（off/low/medium/high，默认 off）→ Anthropic `thinking.budget_tokens` 2k/8k/24k（自动抬高 max_tokens）；OpenAI o 系列/gpt-5 发 `reasoning_effort` |
| R3 | usage | ✅ | OpenAI 兼容请求 `stream_options.include_usage`（Provider 不认时自动去掉重试），解析 `prompt_tokens / completion_tokens / cached_tokens / prompt_cache_hit_tokens / reasoning_tokens`；Anthropic 解析 `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`。上游不返回时按估算记录并标 `estimated=true`。每次上游调用（对话、续写、摘要、标题）一行写入 `llm_usage`；消息带汇总 `usage` |
| R4 | 费用估算 | ✅ | 设置 `modelPricing`（JSON，每百万 token 单价，键为 `模型名` 或 `Provider名/模型名`，支持 `*` 通配）。不内置任何价格（各家调价频繁，避免误导），未配置时 `cost=null` |
| R5 | 查询接口 | ✅ | `GET /api/usage`（汇总 + 按 day/model/provider/session/agent/purpose 分组）、`GET /api/usage/records`（明细分页）；按会话可见性过滤 |

### 1.4 内置工具（与业务工具同一注册表）
注册表 `services/tools/registry.ts`：业务工具（`chat/builtin-tools.ts`）+ 通用工具（`services/tools/core-tools.ts`）。统一的 `ToolSpec{name, description, inputSchema, risk, group, available(), run(args, ctx)}`，统一走审批、权限、参数校验与结果截断。

| 工具 | 风险 | 状态 | 说明 |
| --- | --- | --- | --- |
| `fetch_url` | read | ✅ | 只 http/https；复用 `fetchWithProxy`（代理 + 协议校验）；拒绝 localhost/内网/链路本地地址（含 DNS 解析后、含每一跳重定向，最多 5 跳）；20 秒超时、2 MB 上限；HTML 去脚本样式转纯文本；结果标注“不可信外部内容” |
| `web_search` | read | ✅ | 仅当用户配置了搜索服务（Tavily / Brave / SearXNG / Bing 兼容端点）才出现在工具列表；Key 加密存储 |
| `workspace_list` / `workspace_read` | read | ✅ | 沙箱 `<dataDir>/workspace/<sessionId>/`；拒绝绝对路径、`..`、NUL、符号链接逃逸（realpath 校验） |
| `workspace_write` | write | ✅ | 同沙箱，单文件 ≤ 2 MB，沙箱总量 ≤ 50 MB；默认需确认 |
| `create_artifact` | read | ✅ | 生成 HTML/SVG/Markdown/JSON/CSV/代码产物：写入沙箱 `artifacts/`，下发 `artifact` 事件，并把产物以代码块追加进回复正文——**现有产物面板无需改动即可显示**。等价于模型直接输出代码块，不改动任何业务数据，故归 read |
| `get_time` | read | ✅ | 当前时间（任意 IANA 时区）与时区换算 |
| `calculator` | read | ✅ | 自写表达式解析器（无 eval）：四则、幂、取模、括号、常用函数与常量 |
| 业务工具 | 按工具 | ✅ | `search_customers` 等，经注册表执行 |

设置：`builtinTools`（**全部内置工具总开关**，'0' 时业务与通用工具都不提供，兼容契约 4.9）、`kernelTools`（只控制通用工具，默认开）。

审批（`tool-approval.ts`）：`POST /api/chat/tool-decision` 支持 `remember: 'session'`（本会话内同名工具不再询问）；`GET /api/chat/pending?sessionId=` 断线重连后取回待审批请求。

### 1.5 会话能力
| # | 项 | 状态 | 实现 |
| --- | --- | --- | --- |
| S1 | 标题自动生成 | ✅ | 首轮回复后后台用同一模型生成 ≤20 字标题（用户手动改过的标题不覆盖），经 `/api/events` 推送 `session.title`；设置 `autoTitle`（默认开） |
| S2 | 重新生成 | ✅ | `POST /api/chat/regenerate`：删除最后一条用户消息之后的回复，重新跑（SSE 同 `/api/chat`） |
| S3 | 编辑后重发 | ✅ | `POST /api/chat/edit`：改写指定用户消息、删除其后全部消息（分支截断，同时作废覆盖到被删消息的摘要），重新跑 |
| S4 | 消息复制 | ✅ | 客户端用 `message.content`；服务端提供 `GET /api/chat/messages/:id/markdown`（含工具/推理可选） |
| S5 | 导出 Markdown | ✅ | `GET /api/chat/sessions/:id/export?format=markdown&reasoning=1&tools=1` |
| S6 | 群聊发言顺序与 @ | ✅ | 优先级：请求体 `targetAgentIds` > 用户消息里的 `@名字`/`@id`（按出现顺序）> 全体按成员顺序。Agent 回复里 @ 了本轮尚未发言的成员时，该成员接着发言（每轮最多 成员数+2 次发言，防止互相点名死循环） |

### 1.6 有意不做 / 已知限制
- js-tiktoken 精确计数：见 C1。
- 会话树（保留多分支）：编辑重发采用截断，不保留旧分支（与契约“分支截断”一致）。
- DNS 重绑定：fetch_url 先解析校验再交给 fetch 自己解析，存在极短的 TOCTOU 窗口；经代理时由代理解析。

## 2. 测试
- `packages/server/test/builtin-kernel.test.ts`（19 项单元）：错误分类/Retry-After/退避；可恢复流（429+503 后成功、重试耗尽、鉴权不重试、已输出后断流不重放、首包超时重试、取消立即生效、退避等待可取消、stream_options/tools 自动降级）；适配器（DeepSeek reasoning_content、`<think>` 拆分、usage 含缓存、finish=length、旧接口只出 text/tool_calls、工具循环内回传 reasoning_content、Anthropic thinking+签名+tool_use+usage）；能力矩阵与覆盖；压缩以消息为单位且保持工具配对、配对修复、循环内截短；工作区路径穿越/绝对路径/盘符/NUL/符号链接逃逸/跨会话隔离/大小限制；fetch_url 协议限制与内网地址拒绝、HTML 转文本与重定向；计算器（含恶意输入）；时区换算（含夏令时）；搜索配置与 Key 不回传；费用估算；@ 解析。
- `packages/server/test/builtin-kernel-e2e.test.ts`（18 项端到端，真实 HTTP + `tools/dev/mock-openai.js`）：推理事件与落库、usage 入库/费用/查询；429/502 注入重试、重试耗尽；length 与断流续写；空回复重试；并行工具与配对；write 审批（批准+本会话记住、拒绝）；工具上限收尾；产物；不支持工具的模型降级；停止（流式中/审批中）；编辑重发与重新生成的分支截断；导出与复制；群聊 @ 与追加发言、targetAgentIds；业务上下文注入；自动标题；端到端压缩与摘要复用。
- `tools/dev/mock-openai.js`：模拟 OpenAI 兼容上游（网关测试也用它），支持 `POST /__mock/script`（编排 reasoning / tool_calls / 错误状态 + Retry-After / finish / usage / 挂起 / 断流）、`GET /__mock/requests`、`POST /__mock/reset`。
