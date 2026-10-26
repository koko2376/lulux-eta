---
name: skill-creator
description: 指导创建和改进技能（Skill）：判断什么值得做成技能，设计 SKILL.md 的 name/description/关键词，组织正文（步骤、模板、检查清单）与附属文件（references/、templates/、scripts/），编写可在 LULUX 运行的 Node/Python 脚本，最后用 skill_create 或 skill_update 保存并测试。用户说“把这个流程做成技能”“帮我写个 skill”“改进某个技能”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: meta
  keywords: [技能, skill, 创建技能, 写技能, SKILL.md, 技能开发, 自动化流程, 沉淀流程]
  requires:
    tools: [skill_create, skill_update, skill_view, skill_list, run_skill_script]
---

# 技能创建指南

## 什么时候值得做成技能
- 同类任务会反复出现（每周报价、每次展会后跟进、固定格式的报告）；
- 有明确的步骤、标准或模板，别人照着做也能得到一致结果；
- 需要组织特有的知识（公司产品参数、报价规则、客户分级标准、邮件签名）。
一次性的问题直接回答即可，不必做技能。先用 `skill_list` 看是否已有相近技能，能改进就用 `skill_update`，不要重复造。

## 结构
```
<name>/
├── SKILL.md          必需：frontmatter + 正文
├── references/       可选：较长的参考资料（术语表、法规摘要、产品参数），正文里写明何时读取
├── templates/        可选：可直接填写的模板（邮件、表格结构、JSON 输入样例）
└── scripts/          可选：可执行脚本（.cjs/.js/.mjs 用 Node，.py 用 Python 3）
```

## frontmatter 写法
```yaml
---
name: monthly-sales-report          # 小写字母/数字/连字符，≤ 64 字符，与目录名一致
description: 生成月度销售报告：……（做什么 + 什么时候用，≤ 1024 字符）
metadata:
  keywords: [月报, 销售报告, 业绩]   # 用户可能说的词；命中时自动预加载
  category: productivity             # trade | office | writing | research | productivity | meta
  version: 1.0.0
  requires:
    tools: [search_customers, run_skill_script]
    npm: [exceljs@4]                 # Node 脚本需要的 npm 包（首次运行自动安装）
---
```
- **description 决定技能会不会被用上**：模型只在索引里看到 name + description。要写清“做什么”和“在什么情况下用”，包含用户会说的关键词。
- keywords 不要太宽泛（如“邮件”会误触发），2–4 字的业务词最好。

## 正文写法
1. **何时使用**：触发场景与不适用的情况。
2. **需要的输入**：列出参数、缺省值、从哪里取（优先用 LULUX 工具查，如 `search_customers`、`get_customer`、`search_emails`），缺失时问用户。
3. **步骤**：编号步骤，每步写清楚调用哪个工具、参数怎么填；涉及写操作（`create_quote_draft`、`create_email_draft`、`create_customer`）说明需要用户批准。
4. **模板与检查清单**：可直接使用的输出模板；交付前自查清单。
5. **注意事项**：风险、合规、不能做的事（如邮件草稿不会自动发送、不编造数据）。
保持 SKILL.md 精炼（建议 < 300 行）；长资料放 references/，在正文中写“需要时用 skill_view 读取 references/x.md”。

## 脚本规范（在 LULUX 中运行）
- 通过 `run_skill_script` 运行，**每次都需要用户批准**；工作目录是会话工作区，读写相对路径即可，产物自动出现在产物面板。
- Node 脚本请用 `.cjs`（CommonJS，最稳妥）；可 `require` 内置模块、`pdfkit`（LULUX 自带）以及 frontmatter `requires.npm` 声明的包。Python 只用标准库（或在说明中注明需要用户自行安装的包）。
- 输入：命令行参数或 stdin 的 JSON；输出：stdout 打印 Markdown 结果，错误写 stderr 并以非 0 退出。
- 安全：只接受工作区内的相对路径（拒绝 `..` 和绝对路径）；不要读取环境变量里的密钥（运行环境不提供）；不要联网上传数据；默认 60 秒超时（最多 300 秒）。
- 环境变量：`LULUX_SKILL_DIR`（技能目录，读取模板用）、`LULUX_WORKSPACE`（工作区）。

## 保存与测试
1. 向用户展示设计（name、description、步骤大纲、文件列表），确认后调用 `skill_create`（`name`、`description`、`body`、`keywords`、`category`、`files: [{path, content}]`），需要用户批准。
2. 用一个真实例子走一遍：`skill_view` 检查内容，含脚本时 `run_skill_script` 试运行。
3. 根据结果用 `skill_update` 修改（自动备份旧版本）。内置技能只读，需要改动时用 `skill_create` 另建一个新名字的版本。

## 示例骨架
```markdown
# 月度销售报告
## 何时使用
每月初用户要上月销售汇总时。
## 步骤
1. 让用户提供订单导出表（xlsx/csv），用 run_skill_script 运行 excel-xlsx 的 analyze_xlsx.cjs：--group 国家 --sum 金额
2. 用 data-charts 生成国家占比饼图
3. 按 templates/report.md 写报告，word-docx 导出
## 检查清单
- [ ] 金额币种一致 - [ ] 与上月对比 - [ ] 数据来源注明
```
