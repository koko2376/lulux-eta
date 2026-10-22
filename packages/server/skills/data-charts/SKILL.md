---
name: data-charts
description: 数据图表：把表格/统计结果做成静态 SVG 图表（柱状、条形、折线、面积、饼图、环形、堆叠柱），在产物面板展示或用于报告；附选图指南与数据核对清单。用户要“画个图”“做成图表”“可视化一下”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: office
  keywords: [图表, 画图, 可视化, 柱状图, 折线图, 饼图, chart, SVG, 数据可视化]
  requires:
    tools: [workspace_write, workspace_read, run_skill_script, create_artifact]
---

# 数据图表

> 产物面板中的 HTML 不执行脚本（安全策略），所以图表一律生成**静态 SVG**，不要输出依赖 JS 图表库的 HTML。

## 选图指南
| 目的 | 图表 |
| --- | --- |
| 比较类别大小（市场、产品） | `bar`（类别名长或 > 8 个用 `hbar`） |
| 时间趋势（月度出口额） | `line`（强调总量用 `area`） |
| 构成占比（≤ 6 类） | `pie` / `donut`；类别多时用 `bar` 排序 |
| 构成随类别变化 | `stacked` |
| 两个系列对比（今年 vs 去年） | `bar` 多系列 |

## 步骤
1. 准备数据：来自用户、Excel（excel-xlsx 技能的 analyze 脚本分组汇总）或业务数据；核对单位与口径。
2. 写 chart JSON（见 `chart_svg.cjs` 头部注释）：`type`、`title`、`subtitle`（写单位与数据来源/时间）、`labels`、`series`。
3. `workspace_write` 存为 `chart.json`，`run_skill_script`：`skill: "data-charts"`，`script: "chart_svg.cjs"`，`args: ["chart.json", "出口额.svg"]`。
4. 展示：`workspace_read` 读取 SVG 内容，用 `create_artifact`（`language: "svg"`）显示在产物面板；或直接告诉用户文件可下载。
5. 用一两句话解读图表（最大值、增长、异常），不要只丢一张图。

## 数据核对清单
- [ ] 单位一致（千美元/万元），在副标题注明。
- [ ] 类别排序有意义（按数值降序或时间顺序）。
- [ ] 饼图各部分之和 = 100%；类别 ≤ 6，其余合并为“其他”。
- [ ] 不截断纵轴制造夸张效果（脚本纵轴从 0 开始）。
- [ ] 数据来源与日期写清楚。
