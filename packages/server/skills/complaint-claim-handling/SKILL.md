---
name: complaint-claim-handling
description: 外贸投诉与索赔处理：收到质量、数量、交期、包装、运输破损等投诉时，按“安抚—取证—定责—方案—预防”流程处理，区分卖方责任/运输责任/保险理赔/买方原因，给出补偿方案对比与英文回复，输出 8D 式内部整改记录。客户投诉、索赔、要求退款折扣时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [投诉, 索赔, 质量问题, 客诉, claim, complaint, 破损, 短装, 赔偿, 退款, 8D, 理赔]
  requires:
    tools: [get_customer, search_emails, create_email_draft, workspace_write]
---

# 投诉与索赔处理

## 处理流程
1. **24 小时内回应**（即使还没结论）：表示重视、说明已启动调查、请求证据、给出下一次更新时间。不要在证据不全时承认全部责任或直接拒绝。
2. **取证清单**（请客户提供）：订单号/PI/CI、批次号或生产日期、问题数量与比例、照片/视频（外箱唛头 + 内包装 + 问题特写 + 整体）、测试报告、开箱时间、仓库签收记录（是否在 POD 上批注破损/短少）、目的港查验记录。内部调取：出货检验报告、装柜照片、留样、生产记录、提单与保险单。
3. **定责**：
   | 原因 | 责任方 | 处理路径 |
   | --- | --- | --- |
   | 生产质量（不符合确认样/规格） | 卖方 | 补发、返修、折扣或退款 |
   | 包装不当导致破损 | 通常卖方 | 同上，并改进包装 |
   | 运输途中事故（海损、野蛮装卸） | 承运人/保险 | CIF/CIP 由卖方协助、买方凭保险单向保险公司索赔；其他术语视投保方 |
   | 短装/错装 | 卖方（核对装柜记录） | 补发或退款 |
   | 买方使用/储存不当、超出质保 | 买方 | 礼貌说明，提供技术支持或商业让步 |
   | 规格理解偏差 | 双方 | 看合同与确认邮件，协商分担 |
   风险转移点按 Incoterms 判断（FOB/CFR/CIF 在装运港越过船舷/装上船时转移）。
4. **方案对比**（给用户选，再对外）：
   - 补发（下批随货 / 单独快递）：成本 = 货值 + 运费；客户体验好。
   - 下单折扣/抵扣：现金流压力小，绑定复购。
   - 部分/全额退款：用于严重问题或客户流失风险高。
   - 返修/当地维修补贴：大件货物常用。
   - 拒赔并解释：证据显示非我方责任时，附证据、语气克制，提供替代帮助。
5. **对外回复**：先共情，再事实，再方案，最后预防措施；金额与时间写清；用 `create_email_draft` 保存草稿（不自动发送）。
6. **内部整改（8D 简版）**：D1 团队｜D2 问题描述｜D3 临时措施｜D4 根因（5 Why）｜D5 纠正措施｜D6 验证｜D7 预防（检验标准/包装/供应商）｜D8 总结。用 `workspace_write` 写入 `投诉记录-<客户>-<日期>.md`。

## 回复模板
**首次回应**
Dear [Name],
Thank you for letting us know, and I'm sorry for the trouble this has caused. We take it seriously and have started an investigation with our QC team. To speed things up, could you please send: (1) photos/videos showing the carton marks and the defects, (2) the number of affected units, (3) the batch/production date on the label. We will come back with our findings and a solution by [date].

**确认我方责任后**
Our investigation found that [root cause]. We will [solution: replace 120 units free of charge with the next shipment / credit USD 960 to your next order], and we have [preventive action] to make sure it does not happen again.

## 注意
- 涉及金额先和用户确认权限范围；不要替用户承诺超出其授权的赔偿。
- 保险索赔有时效（通常发现损失后尽快通知，提赔期按保单条款），提醒客户在签收单上批注、保留货物与包装。
- 大额争议提醒用户咨询中国信保或律师。
