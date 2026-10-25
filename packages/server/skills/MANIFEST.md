# LULUX ETA 内置技能（Skill）

本目录随安装包分发（electron-builder extraResources → `<resources>/skills`），服务启动时同步到 `<dataDir>/skills`：只更新未被用户修改过的内置副本（按内容哈希判断）。编写规范见 docs/SKILLS.md。

共 38 个：原创 26 个，导入自 Hermes Agent（MIT）12 个（来源与许可见 THIRD_PARTY_LICENSES.md、THIRD_PARTY_SKILLS.json）。

| 技能 | 分类 | 脚本 | 来源 | 说明 |
| --- | --- | --- | --- | --- |
| `complaint-claim-handling` | 外贸业务 |  | 原创 | 外贸投诉与索赔处理 |
| `container-loading` | 外贸业务 | ✓ | 原创 | 装柜与体积计算 |
| `customer-background-check` | 外贸业务 |  | 原创 | 外贸客户背景调查 |
| `export-compliance-screening` | 外贸业务 |  | 原创 | 出口合规与制裁名单筛查提示 |
| `follow-up-cadence` | 外贸业务 |  | 原创 | 外贸客户跟进节奏与催单 |
| `fx-freight-lookup` | 外贸业务 |  | 原创 | 汇率与海运费查询 |
| `hs-code-tax-rebate` | 外贸业务 |  | 原创 | HS 编码归类与出口退税查询思路 |
| `inquiry-triage` | 外贸业务 |  | 原创 | 外贸询盘分析与分级 |
| `market-research` | 外贸业务 |  | 原创 | 外贸目标市场调研 |
| `negotiation-tactics` | 外贸业务 |  | 原创 | 外贸谈判与还价应对 |
| `payment-terms-lc` | 外贸业务 |  | 原创 | 外贸付款方式与信用证审核 |
| `post-trade-show-followup` | 外贸业务 |  | 原创 | 展会后客户跟进 |
| `quote-calculator` | 外贸业务 | ✓ | 原创 | 外贸报价计算 |
| `sample-management` | 外贸业务 |  | 原创 | 外贸样品管理 |
| `trade-documents` | 外贸业务 | ✓ | 原创 | 生成外贸单据 |
| `trade-email-writer` | 外贸业务 |  | 原创 | 外贸开发信与多语种回复 |
| `data-charts` | 文档与办公 | ✓ | 原创 | 数据图表 |
| `excel-xlsx` | 文档与办公 | ✓ | 原创 | Excel 表格生成与分析 |
| `pdf-tools` | 文档与办公 | ✓ | 原创 | PDF 生成与提取 |
| `ppt-pptx` | 文档与办公 | ✓ | 原创 | 生成 PowerPoint 演示文稿（.pptx） |
| `word-docx` | 文档与办公 | ✓ | 原创 | 生成 Word 文档（.docx） |
| `one-three-one-rule` | 写作与沟通 |  | Hermes Agent（MIT） | 1-3-1 决策简报 |
| `simple-english` | 写作与沟通 |  | Hermes Agent（MIT） | 简明英语写作与检查规则 |
| `social-media-content-calendar` | 写作与沟通 |  | Hermes Agent（MIT） | 社交媒体内容日历 |
| `translate-polish` | 写作与沟通 |  | 原创 | 翻译与润色 |
| `writing-templates` | 写作与沟通 |  | 原创 | 商务写作模板库 |
| `competitor-news-monitor` | 调研与分析 |  | Hermes Agent（MIT） | 跟踪一组竞争对手/客户公司的重大新动态（新品、价格、融资、合作、诉讼等），只报告 |
| `domain-intel` | 调研与分析 | ✓ | Hermes Agent（MIT） | 被动域名情报 |
| `grounded-citations` | 调研与分析 | ✓ | Hermes Agent（MIT） | 有据可查的引用 |
| `product-price-monitor` | 调研与分析 |  | Hermes Agent（MIT） | 监控具体商品（如竞品在电商平台上的售价）的全口径价格与库存，按条件判断是否需要提 |
| `decision-questionnaire` | 效率与待办 |  | Hermes Agent（MIT） | 把一个待定决策或模糊需求转成结构化问卷，逐项收集用户/客户的选择后再执行。 Tu |
| `document-to-action-items` | 效率与待办 |  | Hermes Agent（MIT） | 从合同、信用证、招标文件、会议材料等文档中提取带出处的义务、截止日期与待办事项。 |
| `email-digest-todos` | 效率与待办 |  | 原创 | 邮件摘要与待办提取 |
| `email-inbox-triage` | 效率与待办 |  | Hermes Agent（MIT） | 把收件箱变成可决策的队列 |
| `meeting-action-items` | 效率与待办 |  | Hermes Agent（MIT） | 从会议记录或转写稿中提取决议、待办（负责人/截止日）与未决问题，并附原文出处。  |
| `meeting-minutes` | 效率与待办 |  | 原创 | 会议纪要 |
| `weekly-review-planning` | 效率与待办 |  | Hermes Agent（MIT） | 每周复盘与下周计划 |
| `skill-creator` | 技能开发 |  | 原创 | 指导创建和改进技能（Skill） |
