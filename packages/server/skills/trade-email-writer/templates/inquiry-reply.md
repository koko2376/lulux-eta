# 询盘回复 / 报价邮件模板

**Subject**: RE: [对方主题] – Quotation for [产品] ([数量])

Dear [名],

Thank you for your inquiry about [产品] on [日期/渠道]. Please find our offer below:

| Item | Specification | MOQ | Unit Price (USD) |
| --- | --- | --- | --- |
| [型号] | [规格/认证] | [MOQ] | [单价] [术语] [港口] |

- Price terms: [FOB Ningbo / CIF Hamburg] (Incoterms 2020)
- Payment: [30% T/T deposit, 70% against B/L copy]
- Lead time: [30] days after deposit
- Packing: [每箱数量、外箱尺寸、毛重]
- Validity: [15] days（原材料/汇率波动大时缩短）
- Samples: [免费/收费，可抵扣大货]

To confirm the best option for you, could you please let me know:
1. [需追问的问题 1，如目标数量或年用量]
2. [问题 2，如需要的认证/插头/标签语言]
3. [问题 3，如目的港或是否需要我们安排运输]

[如有：附件为报价单 PDF / 产品规格书]

Best regards,
[签名]

---
要点：
- 先回答对方问的每一个问题，再追问；报价必须写明币种、术语、地点与有效期。
- 报价数据来自 quote-calculator 技能的测算或 LULUX 报价单（create_quote_draft），保持一致。
- 草稿用 create_email_draft 保存（replyToMessageId 填原邮件 id；可 attachQuotePdf + quoteId 附报价单 PDF）。
