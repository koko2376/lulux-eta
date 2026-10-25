---
name: ppt-pptx
description: 生成 PowerPoint 演示文稿（.pptx）：按“结论先行”的结构规划幻灯片，支持封面、章节页、要点、双栏对比、表格、原生图表（柱/线/饼）、KPI 数字页、图片页与演讲备注，可自定义主题色与字体。用户要“做个 PPT”“公司介绍/产品推介/市场汇报幻灯片”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: office
  keywords: [PPT, pptx, 幻灯片, 演示文稿, PowerPoint, 公司介绍, 产品推介, 汇报]
  requires:
    tools: [workspace_write, run_skill_script]
    npm: [pptxgenjs@4]
---

# PPT 生成

## 先规划（给用户看大纲再生成，内容较多时）
- 明确：受众（客户/老板/团队）、时长（每页约 1–2 分钟）、目的（说服/汇报/介绍）。
- 结构建议：封面 → 议程 → 每个章节（章节页 + 2–4 页内容）→ 总结/下一步 → 联系方式。
- 每页一个观点：标题写结论（“德国市场 2026 年增长 18%”），而不是主题词（“德国市场”）。
- 要点每页 ≤ 6 条、每条 ≤ 20 字（英文 ≤ 12 词）；数据优先用图表或 KPI 页。

## 生成
1. 按 `make_pptx.cjs` 头部注释写 deck JSON（`slides[].layout`：`title`、`section`、`bullets`、`two-column`、`table`、`chart`、`kpi`、`image`），可加 `notes` 演讲备注；主题 `theme.primary/accent/font`（默认深蓝 + 橙，微软雅黑）。
2. `workspace_write` 保存为 `deck.json`；图片需先放在工作区（相对路径）。
3. `run_skill_script`：`skill: "ppt-pptx"`，`script: "make_pptx.cjs"`，`args: ["deck.json", "产品推介.pptx"]`（首次运行自动安装 pptxgenjs）。
4. 产物在产物面板下载；告诉用户页数与每页标题。

## 外贸场景模板
- **公司介绍（给客户）**：封面｜我们是谁（成立年份、工厂面积、员工、产能 KPI 页）｜核心产品（双栏或图片）｜认证与质量体系（表格）｜主要市场与客户案例｜合作流程（打样→试单→大货）｜联系方式。
- **产品推介**：痛点 → 方案 → 参数对比表 → 认证 → 价格与 MOQ → 交期与付款 → 下一步。
- **市场汇报（内部）**：结论速览 KPI → 市场数据图表 → 竞争 → 客户进展表 → 风险 → 下季度计划。

## 注意
- 图表数据要真实且注明来源；没有数据就不要做图表。
- 字体：客户电脑可能没有中文字体，英文演示用 `"font": "Arial"`。
