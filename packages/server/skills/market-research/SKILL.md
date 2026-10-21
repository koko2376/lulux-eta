---
name: market-research
description: 外贸目标市场调研：评估一个国家/地区对某产品的进口规模与趋势、主要竞争来源、价格带、渠道与客户类型、准入认证与关税、物流与付款风险，输出带来源的市场调研报告与进入建议。用户问“某国市场怎么样”“开发哪个市场”“找客户从哪下手”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [市场调研, 目标市场, 市场分析, 进口数据, 竞争对手, 准入, 认证, 开发市场, market research, 国别分析]
  requires:
    tools: [web_search, fetch_url, create_artifact, run_skill_script]
---

# 目标市场调研

## 范围确认
产品（最好有 HS 编码，见 hs-code-tax-rebate 技能）、目标国家（1–3 个）、我方定位（价格带、OEM/品牌、产能）、调研目的（选市场/找客户/定价）。

## 数据来源（全部用 `web_search` / `fetch_url` 查询，记录 URL 与数据年份）
| 维度 | 推荐来源 |
| --- | --- |
| 进口规模与来源国 | UN Comtrade（comtradeplus.un.org）、ITC Trade Map（trademap.org，部分需注册）、WITS（wits.worldbank.org）、目的国统计局 |
| 关税与贸易措施 | 目的国税则（美国 HTS、欧盟 TARIC、英国 Trade Tariff 等）、WTO Tariff Download、反倾销公告 |
| 准入认证 | 欧盟 CE/RoHS/REACH/WEEE、美国 FCC/UL/DOE/FDA/CPSC、英国 UKCA、加拿大 CSA/IC、澳洲 RCM/SAA、沙特 SASO/SABER、俄白哈 EAC、印度 BIS、巴西 INMETRO、日本 PSE |
| 宏观与风险 | World Bank 数据、汇率走势、中国信保国别风险报告、各国使馆经商处（mofcom.gov.cn 驻外经商机构）|
| 渠道与竞争 | 当地电商（Amazon 站点、Mercado Libre、Noon、Jumia 等）价格与热销款、行业协会、展会名录、Google Maps 搜索批发商/零售商 |
| 客户线索 | 展会参展商名录、行业协会会员、进口提单数据（见 customer-background-check 技能）|

## 分析框架
1. **需求**：近 3–5 年进口额与增速、人均消费、季节性。
2. **竞争**：前五大来源国份额（中国占比）、主要品牌、价格带（终端价 → 倒推进口价，常见零售加价 2–4 倍）。
3. **准入**：必须认证、标签语言、能效/环保法规、关税（MFN 与自贸协定优惠）、附加税。
4. **渠道**：进口商/批发商/连锁零售/电商/工程项目，各自的采购特点（量、价、账期）。
5. **风险**：付款与汇率、政治与制裁、清关难度、物流时效与运价。
6. **结论**：市场吸引力（高/中/低）、进入方式与优先客户类型、首年目标与行动计划。

## 报告模板
```
# <产品> × <国家> 市场调研（数据截至 YYYY）
## 结论速览
- 吸引力：高/中/低 ｜ 建议：… ｜ 关键门槛：…
## 1. 市场规模与趋势（表格 + 来源）
## 2. 竞争格局（来源国份额、主要品牌、价格带）
## 3. 准入与税费（认证、关税、附加税、标签）
## 4. 渠道与目标客户画像
## 5. 风险评估
## 6. 进入策略与 90 天行动计划
## 数据来源与未核实事项
```
需要图表时用 data-charts 技能生成 SVG（`run_skill_script`），再用 `create_artifact` 展示；正式报告可用 word-docx 技能导出 Word。

## 注意
- 数据要注明年份与口径（进口额 CIF 计价、单位 USD），找不到的写“未查到”，不要编造数字。
- 区分事实与推测；推测要写依据。
