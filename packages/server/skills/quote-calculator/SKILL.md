---
name: quote-calculator
description: 外贸报价计算：按 Incoterms 2020 从采购成本推算 EXW/FCA/FOB/CFR/CIF/CPT/CIP/DAP/DPU/DDP 报价，含出口退税抵减、国内费用、海运/拼箱/空运费、保险（110% 加成）、目的国关税与进口增值税、汇率与目标毛利率；附计算脚本，结果可直接生成 LULUX 草稿报价单。用户要“报个价”“算 CIF/FOB/DDP”“利润多少”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [报价, 报个价, 算价, FOB, CIF, CFR, EXW, DDP, DAP, Incoterms, 贸易术语, 退税, 利润, 毛利, 报价单, quotation]
  requires:
    tools: [run_skill_script, create_quote_draft, search_customers, get_customer, calculator, web_search]
---

# 报价计算（Incoterms 2020）

## 何时使用
用户给询盘或产品成本，要求报某个术语的价格、比较不同术语、或核算利润。

## 第一步：收集参数（缺的先问，能从系统查的不要问）
| 参数 | 来源 | 缺省/说明 |
| --- | --- | --- |
| 产品、数量、单位 | 询盘 / 用户 | 必填 |
| 采购单价（元，是否含税） | 用户 / 产品库 | 必填；含 13% 增值税票才能退税 |
| 出口退税率 | HS 编码查询（见 hs-code-tax-rebate 技能） | 不确定时先按 0 计并提示 |
| 每件体积 CBM、毛重 kg | 装箱资料（见 container-loading 技能） | 用于运费和拼箱判断 |
| 国内费用（拖车、港杂、报关、单证、商检） | 货代报价 | 常见整柜：拖车 800–2500 元、港杂/THC 800–1500 元、报关 150–400 元 |
| 海运费 | 货代 / 运价查询（fx-freight-lookup 技能） | 报 CFR/CIF/DAP/DDP 必需 |
| 保险费率 | 保险公司 | 普货一切险约 0.2%–0.5%，按 CIF×110% 投保 |
| 汇率 | 银行现汇买入价（fx-freight-lookup 技能） | 建议留 1%–2% 汇率缓冲 |
| 目标毛利率 | 用户 | 缺省 15%（按售价计） |
| DDP：目的国关税、进口增值税、清关与派送费 | 目的国税则 / 当地代理 | DDP 风险最大，务必核实 |

客户在系统里时：`search_customers` / `get_customer` 取国家、历史成交价与常用术语、目的港。

## 第二步：运行计算脚本
1. 把参数写成 JSON（格式见脚本头部注释或 `references/input-example.json`），用 `workspace_write` 存为 `quote-input.json`。
2. `run_skill_script`：`skill: "quote-calculator"`，`script: "quote_calc.cjs"`，`args: ["quote-input.json", "--out", "quote-result.json"]`（需要用户批准）。
3. 脚本输出 Markdown 明细表与警告；`quote-result.json` 里 `quotes[].items` 是每个产品的单价，可直接用于报价单。

没有脚本权限时，用 `calculator` 按下面公式逐步算，并把每一步列出来。

## 计算口径（脚本同口径）
- 退税额/件 = 含税采购价 ÷ (1 + 增值税率) × 退税率（退税率不超过增值税率）
- EXW 成本 = 采购成本 − 退税额
- FCA 成本 = EXW + 拖车 + 报关 + 单证
- FOB 成本 = EXW + 全部国内费用（拖车、港杂/THC、报关、单证、商检、其他）
- CFR/CPT = FOB + 国际运费
- CIF/CIP = CFR ÷ (1 − 投保加成 × 保险费率)（投保加成通常 110%）
- DAP = CIF + 目的港费用 + 派送；DPU = DAP + 卸货费
- DDP = DAP + 进口关税（CIF × 关税率）+ 进口增值税（(CIF + 关税) × 增值税率）+ 清关费
- 报价 = 成本 ÷ (1 − 毛利率)；多产品按货值比例分摊费用后得出各自单价
- 汇率：报价币种成本 = 人民币成本 ÷ 汇率

## 第三步：给用户的结论
- 推荐报哪个术语与价格（如“建议报 FOB Ningbo USD 7.99/pc，同时给 CIF Hamburg USD 8.81/pc 作参考”），说明利润、关键假设与风险。
- **术语风险提示**：EXW 买方需在中国办出口报关，很多买家做不到，通常改报 FCA；CIF/CFR 风险在装运港转移、卖方只投最低险别；DDP 卖方负责进口清关与税费，需当地进口资质或代理，进口增值税常无法抵扣；集装箱货更规范的是 FCA/CPT/CIP（FOB/CFR/CIF 适用于海运和内河）。
- 报价有效期：运价与汇率波动大时建议 7–15 天。

## 第四步：生成 LULUX 草稿报价单（用户同意后）
调用 `create_quote_draft`（需要用户批准）：
```json
{
  "customerId": "<客户 id>",
  "currency": "USD",
  "incoterm": "CIF",
  "port": "Hamburg",
  "paymentTerms": "30% T/T deposit, 70% against B/L copy",
  "leadTime": "30 days after deposit",
  "notes": "Price valid for 15 days. Based on 1×20GP, insurance 110% All Risks.",
  "items": [{ "name": "LED Panel", "spec": "600x600 40W 4000K", "qty": 2000, "unit": "pcs", "unitPrice": 8.81 }]
}
```
然后可用 `trade-email-writer` 技能写报价邮件，`create_email_draft` 带 `quoteId` 与 `attachQuotePdf: true` 保存草稿（不会自动发送）。

## 注意
- 所有输入值（运价、汇率、税率）都要说明来源与日期；没有查到的标注“假设”。
- 不确定退税率、关税时不要编，给出查询方法并按保守值计算。
