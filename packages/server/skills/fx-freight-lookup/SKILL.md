---
name: fx-freight-lookup
description: 汇率与海运费查询：用联网工具获取最新汇率（中国外汇交易中心中间价、银行现汇买卖价、公开汇率 API）与国际海运/空运运价参考（SCFI/CCFI、Drewry WCI、Freightos FBX、船公司与货代报价），整理成可用于报价的数值与风险提示。报价前查汇率、问“现在美金多少”“到汉堡一个柜多少钱”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [汇率, 美元汇率, 欧元汇率, 中间价, 海运费, 运费, 运价, SCFI, 集装箱运价, 空运价格, freight, exchange rate]
  requires:
    tools: [web_search, fetch_url, get_time, calculator]
---

# 汇率与运费查询

> 联网数据可能有延迟；报价使用的汇率与运价必须写明来源、时间与有效期。

## 一、汇率
1. **人民币中间价**（官方参考）：中国外汇交易中心 chinamoney.com.cn（`web_search` “人民币汇率中间价 今日”）。
2. **银行牌价**（结汇实际用的是银行“现汇买入价”）：中国银行外汇牌价 boc.cn/sourcedb/whpj/（`fetch_url` 页面表格）。报价成本换算应使用 **现汇买入价**（银行买入外汇的价格，即企业结汇所得）。
3. **公开汇率 API**（快速获取交叉汇率，数据来自欧洲央行，工作日更新一次）：`fetch_url` `https://api.frankfurter.app/latest?from=USD&to=CNY,EUR,GBP,JPY`，返回 JSON。
4. 用 `get_time` 标注查询时间（用户时区）。
5. 报价建议：在现汇买入价基础上预留 1%–2% 汇率缓冲；报价有效期内汇率大幅波动时注明 “prices subject to exchange rate fluctuation over ±3%”。

输出：
```
| 币种 | 中间价 | 中行现汇买入 | 来源/时间 |
| USD/CNY | … | … | … |
报价建议汇率：1 USD = x.xx CNY（已含 x% 缓冲）
```

## 二、海运/空运运价
1. **指数参考（判断趋势，不是实际报价）**：
   - 上海出口集装箱运价指数 SCFI（每周五发布，上海航运交易所 sse.net.cn）、中国出口集装箱运价指数 CCFI；
   - Drewry World Container Index（WCI，每周四）、Freightos Baltic Index（FBX）。
   用 `web_search` “SCFI 本周 欧洲航线” 等获取最新一期数值与涨跌。
2. **实际报价**：向合作货代询价最准（提供：起运港、目的港、柜型/体积重量、货物品名、预计出运日期、是否需要拖车报关、DDP/DAP 需要目的港清关派送）；船公司官网（Maersk、MSC、COSCO、CMA CGM、ONE、Hapag-Lloyd 等）有即时报价工具，多需账号——只提示用户自行查询，不要尝试登录。
3. **附加费提醒**：BAF/燃油附加费、PSS 旺季附加费、GRI 涨价、THC、文件费、苏伊士/红海绕航附加费、低硫附加费；空运注意燃油与安检费、计费重（体积重 1 CBM = 167 kg）。
4. **时效**：主要航线大致船期（如上海/宁波—汉堡约 30–40 天，—洛杉矶约 14–20 天），受绕航与港口拥堵影响，需注明“参考”。

输出：
```
航线：Ningbo → Hamburg｜柜型：40HQ
指数参考：SCFI 欧洲航线 … USD/TEU（YYYY-MM-DD，周涨跌 x%）
估算运价区间：…（假设：…）｜建议向货代确认
附加费与风险：…
```

## 与报价联动
把汇率与运费填进 quote-calculator 技能的 `fx`、`freight` 字段；运价波动大时报价有效期缩短到 7 天。
