---
name: post-trade-show-followup
description: 展会后客户跟进：把广交会/海外展收集的名片与洽谈记录整理分级，48 小时内发出个性化跟进邮件，制定 30 天跟进计划，导入客户库并统计展会 ROI。展会结束、用户拿到一堆名片/客户清单时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [展会, 广交会, 展后跟进, 名片, trade show, exhibition, Canton Fair, 展会客户, 展会邮件]
  requires:
    tools: [search_customers, create_customer, create_email_draft, workspace_read, workspace_write]
---

# 展会后客户跟进

## 第 0 步：整理名单（展会结束当天）
1. 用户提供名片照片转写/表格/洽谈笔记（可放进工作区，用 `workspace_read` 读取；表格可用 excel-xlsx 技能的 analyze 脚本读）。
2. 统一字段：公司、国家、姓名、职位、邮箱、电话/WhatsApp、感兴趣产品、洽谈要点（价格/数量/认证/样品）、承诺事项（寄目录/报价/样品）、展位拍照编号。
3. 分级：
   - **A 热**：明确产品与数量、要求报价或样品、决策人。
   - **B 温**：有兴趣、需了解更多，或非决策人。
   - **C 冷**：只拿资料、同行、学生/服务商。
4. 去重：`search_customers` 检查是否已有客户（老客户在跟进邮件中提及合作历史）。

## 第 1 步：48 小时内首封邮件（A/B 级逐个个性化）
- 主题：`Nice meeting you at [展会名] Booth [号] – [产品]`
- 第一句点出见面细节（“we talked about the 600×600 panel for your hotel project”），兑现承诺（附报价/目录链接/样品安排），一个明确下一步。
- C 级用简短统一模板 + 目录。
- 每封用 `create_email_draft` 保存草稿（**不会自动发送**），提醒用户检查后批量发送；建议错开发送，避免同一时间大量群发进垃圾箱。

## 第 2 步：建档
A/B 级用 `create_customer` 建档（需用户批准），`source` 填“展会：<展会名+年份>”，标签加展会名与等级，备注写洽谈要点与承诺。

## 30 天跟进计划
| 时间 | A 级 | B 级 | C 级 |
| --- | --- | --- | --- |
| D+2 | 首封邮件 + 报价/样品 | 首封邮件 + 目录 | 统一感谢信 |
| D+5 | 确认收到报价，回答疑问 | 推荐 2–3 个匹配款 | — |
| D+10 | 推动样品/试单，视频会议 | 问需求与采购时间 | — |
| D+20 | 报价有效期提醒/方案调整 | 案例/认证资料 | 新品资讯 |
| D+30 | 复盘：转为样品/订单或降级 | 升降级 | 进入月度资讯名单 |

## 展会 ROI（建议生成表格）
展位与差旅成本、收集名片数、A/B/C 数量、30/90 天内样品数、订单数与金额、单个有效客户成本。

## 首封邮件模板
Subject: Great meeting you at [Fair] – [Product] quotation as promised

Dear [Name],

Thank you for visiting our booth [No.] at [Fair] on [date]. As discussed, please find attached our quotation for [product/model] ([qty]) — [one key point you discussed, e.g. CE + 5-year warranty, 30-day lead time].

[Promised item: samples will be dispatched on (date) via DHL / catalogue link: …]

Would next Tuesday or Wednesday suit you for a short video call to review the details?

Best regards,
[Signature]
