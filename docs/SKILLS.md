# LULUX ETA 技能（Skill）

技能是给 Agent 的“操作手册”：一个目录，里面一份 `SKILL.md`（何时用、怎么做、模板与检查清单），外加可选的参考资料、模板和可执行脚本。Agent 在对话里先看到所有已启用技能的一行索引，需要时再读全文、运行脚本。

- 接口、事件、审批卡片的字段契约见 `docs/API-CONTRACT.md` 第 8 节。
- 内置技能源文件在 `packages/server/skills/`（目录清单 `MANIFEST.md`，第三方来源 `THIRD_PARTY_SKILLS.json`）。

## 1. 技能在哪里、怎么生效

| 位置 | 内容 |
| --- | --- |
| `packages/server/skills/`（打包后：桌面 `<resources>/skills`，Docker `/app/server/skills`） | 内置技能，只读，随版本更新 |
| `<dataDir>/skills/<name>/` | 运行时使用的全部技能（内置副本 + 用户 / Agent / 导入的） |
| `<dataDir>/skills/.backups/<name>/<时间戳>/` | 覆盖或 `skill_update` 前的旧版本 |
| `<dataDir>/skill-runtime/node_modules/` | 脚本声明的 npm 依赖（首次运行时安装） |

- **启动同步**：服务端首次用到技能时，把安装包里的内置技能同步进 `<dataDir>/skills`。只覆盖**没被改过**的内置副本（按内容哈希判断）；改过的保留并在界面上提示“有更新”，可在详情页“恢复默认”。
- **服务端如何找到内置目录**：环境变量 `LULUX_BUILTIN_SKILLS_DIR` 优先；否则依次尝试打包目录与仓库目录，以目录中存在 `MANIFEST.md`（或 `skill-creator/SKILL.md`）为准。桌面主进程会自动把 `LULUX_BUILTIN_SKILLS_DIR` 设为 `<resources>/skills`（单文件 CJS 服务端没有 `import.meta.url`）。**发布前务必保留 `packages/server/skills/MANIFEST.md`。**
- **对话中**（设置 `skillsEnabled` 开启时）：系统提示注入技能索引（`name：description`）；用户消息命中某技能的 `keywords` 时自动预加载正文（最多 2 个），界面显示“已加载技能”。其余技能由 Agent 按需 `skill_view`。
- **按 Agent 配置**：每个 Agent 可选“全部 / 仅选中的 / 不用技能”（`PUT /api/agents/:id/skills`）。
- **团队服务器**：所有人可浏览技能；安装、启停、删除、按 Agent 配置只有 owner/admin；Agent 自己创建 / 安装技能的工具也只对 owner/admin 暴露。脚本执行与 MCP 默认关闭，需 owner 在“服务器安全”中开启。

## 2. 编写指南

### 2.1 目录结构
```
<name>/
├── SKILL.md          必需：YAML frontmatter + Markdown 正文
├── references/       可选：较长的参考资料（术语表、法规摘要、产品参数）
├── templates/        可选：可直接填写的模板（邮件、表格结构、JSON 输入样例）
└── scripts/          可选：可执行脚本（.cjs/.js/.mjs 用 Node，.py 用 Python 3）
```
限制：解包后 ≤ 20 MB、≤ 300 个文件、单文件 ≤ 5 MB、目录 ≤ 8 层、路径 ≤ 240 字符；不允许符号链接、`..`、绝对路径。

### 2.2 frontmatter
```yaml
---
name: monthly-sales-report          # 必填：小写字母/数字/连字符，≤ 64，与目录名一致
description: 生成月度销售报告：汇总上月订单……用户要“月报”“上月业绩”时使用。   # 必填，≤ 1024
license: BSL-1.1                    # 可选
metadata:
  category: productivity            # trade | office | writing | research | productivity | meta
  keywords: [月报, 销售报告, 业绩]   # 命中用户消息时自动预加载
  version: 1.0.0
  author: 你的名字
  requires:
    tools: [search_customers, run_skill_script]   # 用到的 LULUX 工具（说明用途）
    npm: [exceljs@4]                # Node 脚本需要的 npm 包（首次运行自动安装）
    python: false                   # 脚本是否需要 Python 3
  # 导入第三方技能时：
  # source: https://github.com/<owner>/<repo>
  # upstream-commit: <commit>
---
```
- 解析器支持 YAML 常用子集（标量、列表 `[a, b]` / `- a`、嵌套映射、`|`/`>` 块）。`keywords`、`category`、`requires` 等扩展键写在 `metadata:` 下，也兼容写在顶层；`tags` 视同 `keywords`。
- **description 决定技能会不会被用上**：模型在索引里只看到 name + description。写清“做什么 + 什么时候用”，带上用户会说的词。
- **keywords 要具体**：2–4 字的业务词最好（“报价”“CIF”“信用证”）；“邮件”“文件”这类泛词会误触发预加载。

### 2.3 正文
1. **何时使用**：触发场景，以及不适用的情况。
2. **需要的输入**：参数、缺省值、从哪里取——优先用 LULUX 工具查（`search_customers`、`get_customer`、`search_emails`），缺失再问用户。
3. **步骤**：编号，每步写明调用哪个工具、参数怎么填；写操作（`create_quote_draft`、`create_email_draft`、`create_customer`）注明需要用户批准。
4. **模板与检查清单**：可直接套用的输出格式；交付前自查项。
5. **注意事项**：合规风险、不能做的事（邮件草稿不会自动发送、不编造数据、价格与汇率要注明来源和日期）。

SKILL.md 建议 < 300 行；长资料放 `references/`，正文写“需要时用 `skill_view` 读取 `references/x.md`”。正文里引用工具请用 LULUX 的真实工具名（见 API 契约 6.5、4.9、8.4）。

### 2.4 脚本
- 由 `run_skill_script` 运行，**每次都需要用户批准**（即使“自动执行工具”已开启；用户可选择“本会话内允许该技能”）。
- 工作目录 = 会话工作区，读写相对路径；新建 / 修改的文件自动出现在产物面板并可下载。用户可先把 Excel/PDF 上传到会话工作区再让脚本处理。
- Node 优先用 `.cjs`（CommonJS）；可 `require` Node 内置模块、`pdfkit`（LULUX 自带）以及 `requires.npm` 声明的包（安装时 `--ignore-scripts`）。Python 只用标准库，或在正文中写明需要用户自行安装的包。
- 输入：命令行参数或 stdin JSON；输出：stdout 打印结果（Markdown 或 JSON），错误写 stderr 并以非 0 退出。stdout/stderr 各保留 64 KB，大结果写文件。
- 环境：只有白名单变量（`PATH`、`HOME`、`LANG`、临时目录等）和 `LULUX_SKILL_NAME`、`LULUX_SKILL_DIR`（读模板用）、`LULUX_WORKSPACE`；**不提供任何 API Key**。默认 60 秒超时（最多 300 秒），超时杀掉整个进程组。
- 安全：只接受工作区内的相对路径；不要联网上传用户数据。

### 2.5 创建、安装与测试
- **让 Agent 写**：说“把这个流程做成技能”，Agent 会参考内置的 `skill-creator`，用 `skill_create` 保存（需批准），之后可 `skill_update`（自动备份）。
- **安装现成的**：设置 → 技能 → 安装：上传 zip、粘贴 GitHub 地址（仓库、`tree/<分支>/<目录>`、raw `SKILL.md`）或 zip 链接；桌面版还可选本机文件夹。仓库里有多个技能时填子目录。
- **手动**：把目录放进 `<dataDir>/skills/`，重启后登记为“用户”技能。
- **测试**：用真实例子走一遍：`skill_view` 看内容；含脚本的先单独 `node scripts/x.cjs …` 跑通，再在对话里 `run_skill_script`。
- 内置技能只读；想改就用新名字另建（或导出 zip 修改后再导入）。

## 3. 内置技能清单（38 个）

原创 26 个（外贸 16 + 办公 / 写作 / 效率 10），导入自 Hermes Agent 12 个。“脚本”一列为 `scripts/` 下可运行的入口；括号内为首次运行时自动安装的 npm 包。

### 外贸业务（原创，16 个）

| 技能 | 说明 | 脚本 |
| --- | --- | --- |
| `complaint-claim-handling` | 外贸投诉与索赔处理 | — |
| `container-loading` | 装柜与体积计算 | `cbm_calc.cjs` |
| `customer-background-check` | 外贸客户背景调查 | — |
| `export-compliance-screening` | 出口合规与制裁名单筛查提示 | — |
| `follow-up-cadence` | 外贸客户跟进节奏与催单 | — |
| `fx-freight-lookup` | 汇率与海运费查询 | — |
| `hs-code-tax-rebate` | HS 编码归类与出口退税查询思路 | — |
| `inquiry-triage` | 外贸询盘分析与分级 | — |
| `market-research` | 外贸目标市场调研 | — |
| `negotiation-tactics` | 外贸谈判与还价应对 | — |
| `payment-terms-lc` | 外贸付款方式与信用证审核 | — |
| `post-trade-show-followup` | 展会后客户跟进 | — |
| `quote-calculator` | 外贸报价计算 | `quote_calc.cjs` |
| `sample-management` | 外贸样品管理 | — |
| `trade-documents` | 生成外贸单据 | `trade_docs.cjs` |
| `trade-email-writer` | 外贸开发信与多语种回复 | — |

### 办公、写作与效率（原创，10 个）

| 技能 | 分类 | 说明 | 脚本 |
| --- | --- | --- | --- |
| `data-charts` | 文档与办公 | 数据图表 | `chart_svg.cjs` |
| `excel-xlsx` | 文档与办公 | Excel 表格生成与分析 | `analyze_xlsx.cjs`, `make_xlsx.cjs`（npm：exceljs@4） |
| `pdf-tools` | 文档与办公 | PDF 生成与提取 | `extract_pdf.cjs`, `make_pdf.cjs`（npm：pdf-parse@1.1.4） |
| `ppt-pptx` | 文档与办公 | 生成 PowerPoint 演示文稿（.pptx） | `make_pptx.cjs`（npm：pptxgenjs@4） |
| `word-docx` | 文档与办公 | 生成 Word 文档（.docx） | `make_docx.cjs`（npm：docx@9） |
| `translate-polish` | 写作与沟通 | 翻译与润色 | — |
| `writing-templates` | 写作与沟通 | 商务写作模板库 | — |
| `email-digest-todos` | 效率与待办 | 邮件摘要与待办提取 | — |
| `meeting-minutes` | 效率与待办 | 会议纪要 | — |
| `skill-creator` | 技能开发 | 指导创建和改进技能（Skill） | — |

### 导入自 Hermes Agent（MIT，12 个）

上游：https://github.com/NousResearch/hermes-agent，提交 `1f91fb386a60f5589146b05ee88e911bb58120e8`。

| 技能 | 分类 | 说明 | 原作者 | 上游路径 | 脚本 |
| --- | --- | --- | --- | --- | --- |
| `one-three-one-rule` | 写作与沟通 | 1-3-1 决策简报：一个问题、三个选项、一个推荐，用于向上级/客户提出需要决策的事项 | Willard Moore | `optional-skills/communication/one-three-one-rule` | — |
| `simple-english` | 写作与沟通 | 简明英语写作与检查规则：让非英语母语的客户也容易读懂邮件、说明书与文档 | AminBlg (https://github.com/AminBlg/SimpleEnglish), ported by Hermes Agent | `optional-skills/creative/simple-english` | — |
| `social-media-content-calendar` | 写作与沟通 | 社交媒体内容日历：基于已核实的产品事实、案例与关键日期，排出多平台发帖计划与文案草稿 | Ben Barclay (benbarclay), Hermes Agent | `optional-skills/creative/social-media-content-calendar` | — |
| `competitor-news-monitor` | 调研与分析 | 跟踪一组竞争对手/客户公司的重大新动态（新品、价格、融资、合作、诉讼等），只报告有原始来源支撑的重要事件 | Ben Barclay (benbarclay), Hermes Agent | `skills/research/competitor-news-monitor` | — |
| `domain-intel` | 调研与分析 | 被动域名情报：WHOIS 注册时间、DNS/MX、SSL 证书、子域名（证书透明日志），用于核实客户官网与邮箱域名（如域名注册时间过新） | FurkanL0, Hermes Agent | `optional-skills/research/domain-intel` | `domain_intel.py` |
| `grounded-citations` | 调研与分析 | 有据可查的引用：给调研回答与报告中的每条外部事实加编号引用与来源列表，并可校验引用与原文摘录 | Hermes Agent + Teknium | `skills/research/grounded-citations` | `sources.py` |
| `product-price-monitor` | 调研与分析 | 监控具体商品（如竞品在电商平台上的售价）的全口径价格与库存，按条件判断是否需要提醒 | Ben Barclay (benbarclay), Hermes Agent | `skills/productivity/product-price-monitor` | — |
| `decision-questionnaire` | 效率与待办 | 把一个待定决策或模糊需求转成结构化问卷，逐项收集用户/客户的选择后再执行 | Matt Pocock (mattpocock/skills, to-questionnaire) + Hermes Agent | `optional-skills/productivity/decision-questionnaire` | — |
| `document-to-action-items` | 效率与待办 | 从合同、信用证、招标文件、会议材料等文档中提取带出处的义务、截止日期与待办事项 | Ben Barclay (benbarclay), Hermes Agent | `skills/productivity/document-to-action-items` | — |
| `email-inbox-triage` | 效率与待办 | 把收件箱变成可决策的队列：按紧急回复/需回复/仅行动/等待他人/参考/噪音分类，校准用户语气后起草回复草稿供批准 | Ben Barclay (benbarclay), Hermes Agent | `skills/email/email-inbox-triage` | — |
| `meeting-action-items` | 效率与待办 | 从会议记录或转写稿中提取决议、待办（负责人/截止日）与未决问题，并附原文出处 | Ben Barclay (benbarclay), Hermes Agent | `skills/productivity/meeting-action-items` | — |
| `weekly-review-planning` | 效率与待办 | 每周复盘与下周计划：盘点完成情况、未完成事项、日程与优先级，产出可执行的周计划 | Ben Barclay (benbarclay), Hermes Agent | `skills/productivity/weekly-review-planning` | — |


## 4. 来源与许可

- **原创技能（26 个）**：LULUX ETA 自有作品，与本项目同为 Business Source License 1.1（`license: BSL-1.1`）。未从第三方文档类技能中取用任何文字或代码。
- **Hermes Agent 导入（12 个）**：来自 NousResearch/hermes-agent（https://github.com/NousResearch/hermes-agent ），提交 `1f91fb386a60f5589146b05ee88e911bb58120e8`，MIT License，Copyright (c) 2025 Nous Research。改动：工具名换成 LULUX 工具（`workspace_read`、`workspace_write`、`fetch_url`、`run_skill_script`、`search_emails`、`create_email_draft`、`skill_view`）；删除或替换 Hermes 专有设施（定时任务、connector 技能、`~/.hermes` 路径）；重写 frontmatter，保留 `source`、`upstream-commit`、`license: MIT` 与原作者。每个导入技能的 `SKILL.md` 都记录了这些字段。
- **未导入**：目录自带 LICENSE/NOTICE 或注明非 MIT 来源（如 Anthropic）的 Hermes 技能一律不导入（docx / xlsx / powerpoint / pdf / humanizer 等），对应能力由原创技能 `word-docx`、`excel-xlsx`、`ppt-pptx`、`pdf-tools`、`translate-polish` 提供。完整的导入 / 跳过清单与 MIT 全文见根目录 `THIRD_PARTY_LICENSES.md`（“Built-in skills imported from Hermes Agent”）与 `NOTICE`；机器可读清单 `packages/server/skills/THIRD_PARTY_SKILLS.json`；重新导入脚本 `tools/dev/import-hermes-skills.py`。
- **脚本依赖不随包分发**：`docx`、`exceljs`、`pptxgenjs`、`pdf-parse` 等由用户机器在首次运行对应脚本时从 npm 源下载到 `<dataDir>/skill-runtime`，适用其各自许可（均为 MIT，见 `THIRD_PARTY_LICENSES.md`“Runtime npm packages installed on demand by built-in skills”）。`pdfkit` 是服务端自身依赖，随包分发。
- **用户 / Agent / 导入的技能**：由安装者负责其来源与许可；导出 zip 会原样保留其中的 LICENSE 文件与 frontmatter。
