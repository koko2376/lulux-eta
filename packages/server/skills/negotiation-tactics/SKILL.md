---
name: negotiation-tactics
description: 外贸谈判与还价应对：面对“价格太高”“竞争对手更便宜”“要账期/降 MOQ/缩交期”等情况，先算清底线（成本、利润、让步空间），再用条件交换、拆分报价、价值强调等策略回应，给出英文话术与让步阶梯。用户问“客户嫌贵怎么回”“怎么还价”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [谈判, 还价, 砍价, 嫌贵, 降价, 价格太高, 议价, 让步, 话术, negotiation, MOQ, 账期]
  requires:
    tools: [get_customer, search_customers, calculator, run_skill_script]
---

# 谈判与还价

## 一、谈判前：算清三个数
1. **成本底线**：用 quote-calculator 技能（或已有报价单）得出当前术语下的成本；
2. **目标价**：期望毛利下的报价；
3. **最低可接受价（walk-away）**：最低毛利（如 8%）对应价格。差额就是让步空间，提前分成 2–3 级。
同时查客户历史（`get_customer`）：过往成交价、付款记录、订单潜力——决定让步力度。

## 二、原则
- **不无条件降价**：每次让步都换条件（数量、付款方式、交期、规格、长期合同）。“If you can increase the quantity to 3,000 pcs, we can offer USD 7.75.”
- **让步递减**：第一次 3%，第二次 1.5%，第三次 0.5%，让对方感到接近底线。
- **先问清楚再回应**：对方说贵时问“和哪个规格比？目标价多少？数量多少？”
- **拆分与对比**：把价格拆成材料/工艺/认证/包装，说明差异；同规格比较时提供测试数据。
- **提供选项**：A 原规格原价；B 降配（如铝材厚度、包装简化）降价；C 加量降价。让客户选而不是只谈“降不降”。
- **守住付款与交期**：价格可以小让，付款方式（定金比例）和风险条款尽量不让。
- **记录承诺**：谈妥后书面确认（邮件/PI），注明有效期。

## 三、常见场景话术
| 客户说 | 回应思路 | 英文示例 |
| --- | --- | --- |
| Your price is too high. | 问基准 + 强调价值 | Could you share which specs or target price you are comparing with? Our panel uses 0.6 mm aluminum and SMD2835 LEDs with 130 lm/W — many lower offers use thinner housing and 100 lm/W. |
| Supplier X offers 10% cheaper. | 不贬低对手，比较总成本 | I understand. Could we compare the full specs and warranty? With our 2% defect rate vs. the industry 5%, the total landed cost is often lower. |
| Give me your best price. | 用数量/条款换 | Our best price depends on volume: 2,000 pcs at USD 7.99, 5,000 pcs at USD 7.69. |
| Can you lower MOQ? | 提供有条件方案 | We can accept 500 pcs for the trial order with a USD 0.30 surcharge, refunded on the next order above 2,000 pcs. |
| We need 60 days credit. | 风险转移 | We can offer 60 days if covered by credit insurance, or 30% deposit with the balance 30 days after B/L. |
| Shorter lead time? | 说明条件 | We can deliver in 20 days if the order is confirmed by Friday and we use our stock housing. |
| 原材料没涨你凭什么涨价 | 用数据 | Copper prices rose 8% since our last quote (LME, [date]); we absorbed half of it. |

## 四、输出
1. 让步阶梯表：级别｜价格｜毛利｜交换条件。
2. 建议回复（英文 + 中文要点），需要时用 trade-email-writer 技能润色并保存草稿。
3. 风险提醒：低于底线的要求建议放弃或换方案。
