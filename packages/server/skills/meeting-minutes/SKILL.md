---
name: meeting-minutes
description: 会议纪要：把会议录音转写、聊天记录或零散笔记整理成结构化纪要（议题、讨论要点、决议、待办含负责人与截止日、风险与待定事项），支持客户会议（中英双语、可直接发给客户确认）与内部会议两种格式，可导出 Word/PDF。用户贴会议记录、说“整理一下会议纪要”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: productivity
  keywords: [会议纪要, 会议记录, 纪要, minutes, 会议总结, 客户会议, 视频会议, 待办]
  requires:
    tools: [workspace_read, workspace_write, create_email_draft, get_time, run_skill_script]
---

# 会议纪要

## 步骤
1. 读取材料：用户粘贴的文本，或工作区里的转写文件（`workspace_read`；PDF 用 pdf-tools 技能提取）。
2. 确认基本信息（缺失时标“待补充”，不要编）：会议主题、时间（用 `get_time` 标注时区）、参会人及所属公司、会议类型（客户 / 内部 / 供应商）。
3. 整理：
   - 去口语化、合并重复内容，保留数字、型号、价格、日期原样；
   - **决议**只写明确达成一致的事项；**待办**必须有动作、负责人、截止日期（没有就标“待定”并列入待确认）；
   - 分歧与未决事项单列，不要替参会人下结论。
4. 输出纪要（模板见下）；客户会议提供英文版（可直接发送确认）+ 中文版。
5. 需要时：用 word-docx / pdf-tools 技能导出文件；客户会议纪要可用 `create_email_draft` 保存“会议纪要确认”邮件草稿（不会自动发送）。

## 模板（内部会议）
```
# 会议纪要：<主题>
时间：YYYY-MM-DD HH:mm（时区）｜地点/方式：…｜主持：…｜记录：AI 整理（待核对）
参会：…  缺席：…
## 一、议题与讨论要点
1. <议题>：要点…（数据/依据）
## 二、决议
- D1 …
## 三、待办事项
| # | 事项 | 负责人 | 截止 | 状态 |
| --- | --- | --- | --- | --- |
## 四、风险与待定事项
- …
## 五、下次会议
时间：… 议题：…
```

## 模板（客户会议，英文）
```
Subject: Meeting Summary – <Topic> – <Date>

Dear <Name>,
Thank you for your time today. Please find below a summary of our discussion; kindly let us know if anything needs correction.

Attendees: …
Key points:
1. Product/specs: …
2. Price & terms: … (Incoterms 2020, currency, validity)
3. Samples/timeline: …
Agreed actions:
| Action | Owner | Due date |
Open items: …
Next meeting: …

Best regards,
```

## 注意
- 价格、数量、交期等商务条款以用户核对为准；纪要中标注“待双方确认”的内容不要写成已确认。
- 涉及报价变化时提醒用户同步更新报价单（quote-calculator / create_quote_draft）。
