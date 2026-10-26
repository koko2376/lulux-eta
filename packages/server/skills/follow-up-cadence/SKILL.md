---
name: follow-up-cadence
description: 外贸客户跟进节奏与催单：针对报价后无回复、样品后无下文、订单确认、催付款/定金、复购唤醒等场景，给出跟进时间表、每次的价值点与邮件/WhatsApp 话术，并整理成可执行的跟进计划。用户问“客户不回怎么办”“怎么催单/催款”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [跟进, 催单, 催款, 客户不回复, 报价后跟进, follow up, 唤醒客户, 复购, 定金]
  requires:
    tools: [search_customers, get_customer, search_emails, create_email_draft, get_time]
---

# 跟进节奏与催单

## 先看历史
`search_customers` → `get_customer`（阶段、最近跟进、报价）+ `search_emails`（`customerId`，看最近往来与对方最后一次回复）。弄清：卡在哪一步、对方最后说了什么、我们承诺过什么。

## 标准节奏（每次换一个价值点，不要只问 “Any update?”）
| 场景 | 时间点（从上次联系起） | 每次内容 |
| --- | --- | --- |
| 开发信无回复 | D+3、D+7、D+14、D+30 | 新案例/认证 → 行业资讯或市场价格变化 → 新品/促销 → 礼貌收尾（“如不需要我将不再打扰”）|
| 报价后无回复 | D+2、D+5、D+10、D+20 | 确认是否收到并补充一个细节（交期/包装）→ 给出选择题（A 方案/B 方案）→ 原材料涨价/汇率提醒报价有效期 → 询问是否有其他供应商的顾虑 |
| 样品寄出后 | 签收当天、D+5、D+12 | 确认签收与使用说明 → 收集测试反馈（给反馈清单）→ 推动试单（小批量方案） |
| 订单确认后待定金 | D+2、D+5、D+8 | 发 PI 与银行信息（提醒核对账户）→ 说明排产时间依赖定金 → 告知产能紧张/材料锁价期限 |
| 尾款/催款 | 到期前 3 天、到期日、逾期 3/7/15 天 | 友好提醒 + 发票/提单副本 → 说明放单条件 → 正式催告（逾期影响信用与后续合作）→ 必要时提醒用户联系信保/律师 |
| 老客户唤醒 | 上次下单后 60/90/180 天 | 补货提醒（按其历史采购周期）→ 新品 → 节日问候 + 小优惠 |

时区：用 `get_time` 换算，让邮件在对方工作日上午到达；避开对方节假日。

## 话术要点
- **选择题替代开放题**：“Would you prefer the 4000K or 6500K version for the trial order?”
- **给理由的紧迫感**（必须真实）：报价有效期、材料涨价、产能排期、海运旺季。
- **降低回复成本**：一句话可回答的问题；“Just reply 1 or 2”。
- **渠道升级**：邮件两次无回复后，若客户留过 WhatsApp/电话，可发简短消息；不要同一天多渠道轰炸。
- **催款保持专业**：附发票号、金额、到期日、银行信息变更声明（“我司账户从未变更，如收到变更通知请电话核实”）。

## 输出
1. 跟进计划表：日期（客户当地时间）｜渠道｜目的｜要点。
2. 下一封邮件草稿：用 `create_email_draft` 保存（`customerId`、`replyToMessageId` 尽量带上），提醒用户检查后手动发送。
3. 建议用户在客户页记一条跟进（Activity）。

## 模板（英文，按需改写）
- 报价后第 1 次：Hi [Name], just checking that our quotation for [product] reached you. One more detail: we can ship within [25] days if confirmed by [date]. Any questions on the specs?
- 报价后第 3 次：Hi [Name], copper prices rose ~5% this month; our quotation stays valid until [date]. Would a trial order of [qty] help you test the market first?
- 收尾：Hi [Name], I haven't heard back, so I'll assume the timing isn't right. I'll stop following up for now — feel free to reach out whenever [product] is back on your agenda.
