---
name: writing-templates
description: 商务写作模板库：工作周报/月报、项目方案、产品介绍与卖点文案、公司简介、通知公告、请示与申请、道歉与致谢信、招聘 JD、社媒帖子（LinkedIn/Facebook）等常用文体的结构与范例，按场景快速生成初稿。用户要写某类常见文书、但没有特定模板时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: writing
  keywords: [写作模板, 周报, 月报, 工作总结, 方案, 公司简介, 产品文案, 通知, 申请, LinkedIn, 文案, 模板]
  requires:
    tools: [workspace_write]
---

# 商务写作模板

## 使用方法
1. 判断文体，问清 2–3 个关键信息（读者、目的、要点/数据）；
2. 读取对应模板：`skill_view`，`name: "writing-templates"`，`path: "templates/<文件名>"`；
3. 用真实信息填充，缺失处用【待补充：…】，不编造数据；
4. 需要文件时交给 word-docx / pdf-tools / ppt-pptx 技能导出。

## 模板目录（templates/）
| 文件 | 文体 |
| --- | --- |
| weekly-report.md | 周报/月报（销售与外贸版） |
| proposal.md | 项目方案/商业计划（一页纸到完整版） |
| company-profile.md | 公司简介（中英文，用于官网/目录/开发信附件） |
| product-copy.md | 产品卖点文案（FAB 法、平台详情页、目录） |
| notices.md | 通知公告、请示申请、致谢与道歉信 |
| social-posts.md | LinkedIn/Facebook/Instagram 外贸社媒帖子 |

## 通用写作原则
- 结论先行：第一段说清“是什么/要什么/结论是什么”。
- 具体胜于抽象：用数字、案例、时间，避免“非常好”“行业领先”。
- 一段一个意思，段落 ≤ 5 行；列表平行结构。
- 语气与读者匹配：对上级简洁有数据；对客户礼貌专业；对团队清楚可执行。
- 交付前自查：错别字、数字单位、称呼、日期、附件是否齐全。
