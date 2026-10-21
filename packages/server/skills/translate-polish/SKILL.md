---
name: translate-polish
description: 翻译与润色：中英及多语种互译（商务邮件、产品说明、合同条款、目录与网站文案），保持术语一致、数字与单位准确；对英文/中文文本做语法纠错、地道化、语气调整（更正式/更友好/更简洁）并给出修改说明。用户要“翻译一下”“帮我润色”“改得更地道/更专业”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: writing
  keywords: [翻译, 润色, 改写, 校对, 语法, 地道, 英文润色, translate, polish, proofread, 本地化]
  requires:
    tools: [workspace_read, workspace_write]
---

# 翻译与润色

## 翻译流程
1. 确认：源/目标语言（用户未说明时：中文 → 英文；外文 → 中文）、用途（邮件/网站/说明书/合同/目录）、目标读者（国家、专业程度）、语气。
2. **术语表**：先抽取专有名词、型号、产品术语、贸易术语（Incoterms、付款条款等），统一译法；长文档把术语表存为 `术语表.md`（`workspace_write`），后续保持一致。
3. 翻译原则：
   - 意思准确优先，其次通顺地道；不增不减信息；
   - 数字、单位、型号、日期、金额原样核对（中文“万”换算为 thousand/million；日期用 2026-10-20 或 Oct 20, 2026，避免 10/11 这种歧义格式）；
   - 计量单位按目标市场习惯可加注（mm/inch，kg/lb）；
   - 合同/法律文本：直译为主、保留条款编号，标注“译文仅供参考，以原文/双方签署版本为准”；
   - 营销文案：允许意译与本地化，但不夸大、不加入原文没有的承诺。
4. 长文档分段翻译，段落一一对应；不确定处用【待确认：…】标注。

## 润色流程
1. 判断问题类型：语法错误、中式英语、语气不当、冗长、逻辑不清。
2. 输出三部分：**润色后全文** → **主要修改说明**（3–8 条，说明原因，帮助用户学习）→ 可选的**更正式/更简洁版本**。
3. 常见中式英语改法：
   - "Please kindly find the attachment" → "Please find attached …"
   - "We are very glad to receive your inquiry" → "Thank you for your inquiry."
   - "Our price is very competitive" → 给出具体数字或对比
   - "Hope you can understand" → "We appreciate your understanding."
   - "Contact me freely" → "Feel free to contact me."
   - "Open the mold" → "make the mould/tooling"；"Sample fee can be returned" → "The sample fee is refundable against your first order."

## 输出格式
```
【译文 / 润色稿】
…
【术语与说明】
- term → 译法（理由）
【待确认】
- …
```
多语种邮件的礼仪与套语见 trade-email-writer 技能的 references/culture.md（可用 skill_view 读取）。
