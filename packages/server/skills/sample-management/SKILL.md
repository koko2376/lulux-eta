---
name: sample-management
description: 外贸样品管理：判断是否寄样与样品费/快递费政策、制作寄样确认单、选择快递与申报、跟踪签收与收集测试反馈、推动样品转订单，并记录样品台账。客户要样品、寄样后跟进或盘点样品时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [样品, 寄样, 样品费, 打样, sample, 快递, DHL, FedEx, 样品单, 样品反馈, 转订单]
  requires:
    tools: [get_customer, search_customers, create_email_draft, workspace_write]
---

# 样品管理

## 一、是否寄样、谁付费（决策表）
| 情况 | 建议 |
| --- | --- |
| A 级询盘、背调可信、样品价值低 | 免费样品，客户付到付快递（提供 DHL/FedEx/UPS 到付账号）或我方预付后大货抵扣 |
| 客户信息不全、价值较高或定制样 | 收样品费（可在首单返还），快递费客户承担 |
| 疑似同行/套样、只要不同型号各一个 | 先电话/视频沟通需求，提供目录与测试报告代替实物 |
| 老客户新品 | 免费，主动寄送 |
定制样需明确：打样费、打样周期、修改次数、确认方式（照片/视频/实物）。

## 二、寄样前确认单（发给客户确认，存工作区 `样品单-<客户>-<日期>.md`）
```
Sample Confirmation
Customer: … | Contact: … | Address (in English, with postcode & phone): …
Items: 型号 / 规格 / 颜色 / 数量 / 是否带 Logo / 包装
Purpose: 测试 / 认证 / 展示 / 客户的客户确认
Sample fee: USD … (refundable against first order ≥ … pcs) | Courier: … (freight collect A/C No. … / prepaid)
Lead time: … days | Expected test result date: …
```

## 三、寄送要点
- 快递：DHL/FedEx/UPS 时效快；邮政小包便宜但慢；带电池/液体/磁性物品需走专门渠道并提供 MSDS/运输鉴定。
- 申报：品名真实，标注 “Sample, No Commercial Value” 只适用于确实无商业价值的样品；申报价值不宜虚低到异常，避免目的国扣关；收件人名称与电话完整。
- 目的国特殊要求：如巴西、印度、俄罗斯等进口样品清关较难，需确认收件人税号（CPF/CNPJ、GST、INN）。
- 附件：样品清单、规格书、测试报告；拍照留底（产品、包装、面单）。

## 四、跟进（与 follow-up-cadence 技能一致）
- 发货当天：发运单号与预计到达时间。
- 签收当天：确认收到，提供使用/测试注意事项。
- 签收后 5–7 天：发送反馈清单（外观、性能参数、包装、与现有供应商比较、价格接受度、预计订单量与时间）。
- 签收后 12–15 天：推动试单（小批量 + 定金优惠 / 打样费抵扣）。

## 五、样品台账（建议用 excel-xlsx 技能生成表格，或 workspace_write 写 CSV）
列：日期｜客户｜国家｜型号｜数量｜样品费｜快递单号｜快递费｜签收日期｜反馈结论｜是否下单｜订单号/金额｜负责人。
每月统计：寄样数、反馈率、转化率、样品成本/订单金额。

## 与系统联动
`get_customer` 确认客户阶段与历史；跟进邮件用 `create_email_draft` 保存草稿（不会自动发送）。
