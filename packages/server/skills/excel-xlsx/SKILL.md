---
name: excel-xlsx
description: Excel 表格生成与分析：生成带表头样式、数字格式、真实公式、合计行、冻结窗格、筛选与条件格式的 .xlsx（报价表、客户清单、台账、对账表）；读取 .xlsx/.csv 做列统计、分组汇总（类数据透视）与 CSV 导出。用户要“做个 Excel”“分析这个表格”“按国家汇总”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: office
  keywords: [Excel, xlsx, 表格, 电子表格, CSV, 数据透视, 汇总, 统计, 台账, 报价表]
  requires:
    tools: [workspace_write, workspace_read, run_skill_script]
    npm: [exceljs@4]
---

# Excel 生成与分析

## 生成 .xlsx
1. 设计表结构：每列 `header`（显示名）、`key`（字段名）、`width`、`numFmt`（如 `#,##0`、`#,##0.00`、`0.0%`、`yyyy-mm-dd`），需要计算的列写 `formula`（用 `{key}` 引用同行其他列，如 `{qty}*{price}`）。
2. 用 `workspace_write` 写 spec JSON（格式见 `make_xlsx.cjs` 头部注释），或直接写 CSV。
3. `run_skill_script`：`skill: "excel-xlsx"`，`script: "make_xlsx.cjs"`，`args: ["spec.json", "报价表.xlsx"]`；CSV：`args: ["data.csv", "data.xlsx", "--sheet", "客户"]`。
4. 产物在产物面板可下载。公式是真实 Excel 公式（同时写入计算结果），用户改数量后金额会自动重算。

spec 示例：
```json
{"sheets":[{"name":"报价明细","title":"LED 报价单（FOB Ningbo）",
  "columns":[{"header":"品名","key":"name","width":24},{"header":"数量","key":"qty","numFmt":"#,##0"},
             {"header":"单价 USD","key":"price","numFmt":"#,##0.00"},{"header":"金额 USD","key":"amount","numFmt":"#,##0.00","formula":"{qty}*{price}"}],
  "rows":[{"name":"LED Panel 40W","qty":2000,"price":7.99}],
  "totals":{"label":"合计","sum":["qty","amount"]},
  "conditional":[{"key":"amount","greaterThan":10000,"fill":"FFF2CC"}]}]}
```

## 分析 .xlsx / .csv
1. 用户上传或已在工作区的文件（`workspace_list` 查看）。
2. `run_skill_script`：`skill: "excel-xlsx"`，`script: "analyze_xlsx.cjs"`，`args: ["订单.xlsx"]`
   - 指定工作表/预览行数：`--sheet 订单 --rows 30`；表头不在第一行：`--header-row 3`
   - 分组汇总：`--group 国家 --sum 金额 --sum 数量`（按第一个汇总列降序，`--sort asc` 升序）
   - 导出 CSV 便于进一步读取：`--export-csv 订单.csv`
3. 解读结果：先说数据概况（行数、时间范围、缺失值），再给关键发现（Top 客户/国家/产品、占比、异常值），最后给建议；需要图表用 data-charts 技能。
4. 注意统计里会包含“合计”行，引用总数时以汇总表为准或提醒用户。

## 规范与技巧
- 金额列统一币种并在表头注明；日期用真实日期类型；不要把数字存成文本。
- 大表（> 5 万行）分析时先 `--rows 5` 看结构，再按需分组汇总。
- 不支持旧版 .xls 与带宏的 .xlsm 宏代码；请用户另存为 .xlsx 或 .csv。
