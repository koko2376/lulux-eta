---
name: decision-questionnaire
description: "把一个待定决策或模糊需求转成结构化问卷，逐项收集用户/客户的选择后再执行。 Turn an unanswerable decision into a questionnaire doc."
license: MIT
metadata:
  author: "Matt Pocock (mattpocock/skills, to-questionnaire) + Hermes Agent"
  version: "1.0.0"
  category: productivity
  keywords: ["决策问卷", "需求澄清", "问卷", "questionnaire", "澄清需求", "decision", "async", "stakeholder", "discovery", "communication"]
  source: "https://github.com/NousResearch/hermes-agent/tree/1f91fb386a60f5589146b05ee88e911bb58120e8/optional-skills/productivity/decision-questionnaire"
  upstream-commit: 1f91fb386a60f5589146b05ee88e911bb58120e8
  upstream-license: "MIT (Copyright (c) 2025 Nous Research) — see THIRD_PARTY_LICENSES.md"
  modified: "LULUX ETA: tool names adapted to LULUX (workspace_read/workspace_write/fetch_url/run_skill_script/search_emails/create_email_draft), Hermes-only infrastructure references removed"
---

# Decision Questionnaire

> 本技能导入自 Hermes Agent（MIT，作者：Matt Pocock (mattpocock/skills, to-questionnaire) + Hermes Agent；上游：https://github.com/NousResearch/hermes-agent，提交 1f91fb386a60，路径 `optional-skills/productivity/decision-questionnaire`）。LULUX 改动：工具名改为 LULUX 工具，去掉 Hermes 专属基础设施的引用。

Turns something the user can't answer alone into a **questionnaire**: a
Markdown document they hand to one person to fill in async, or fill out
together in a meeting. The recipient holds knowledge the user lacks; the
questionnaire pulls it out of them.

Ported from mattpocock/skills' MIT-licensed `to-questionnaire` skill.

## When to Use

- A decision blocks on facts or judgment held by someone else (a domain
  expert, a stakeholder, a vendor contact, ops)
- The user says "I need to ask X about this" or keeps deferring a decision
  pending someone else's input
- Preparing for a meeting where specific answers must come back

Do NOT use when the answer is discoverable from the environment (codebase,
docs, web) — find it yourself first.

## Core Principle: Interview the Send, Not the Subject

The user cannot answer the subject-matter questions (that's the point), but
they can ALWAYS answer questions about the send. Interview them only about
that, in two short exchanges:

1. **Who is it going to?** Role, expertise, relationship to the user. This
   fixes the questionnaire's tone and how much context it must carry. Done
   when you know who the recipient is and what they know that the user
   doesn't.
2. **What do you need back?** The specific decisions or facts the user
   can't resolve alone. Done when you have a concrete list of what the user
   must walk away able to do or decide.

Then **write the questionnaire**: draft questions aimed at the gap between
what the recipient knows and what the user needs, following the structure
below. Write it to `decision-questionnaire-<slug>.md` in the current
directory (slug from the topic) and report the absolute path. Done when the
file exists and every item from step 2 is covered by a question.

## Document Structure

Frame it as a **discovery questionnaire**: the user lacks context, the
recipient holds it. Order questions most-important-first (async means you
may only get one pass). Group under `##` headings by theme once there are
more than a handful.

Template:

```markdown
# <Questionnaire title>

**Purpose:** why this questionnaire exists and the decision riding on it.

**From:** <the user> · **To:** <the recipient> ·
**How your answers will be used:** <where they go>

## Context

One paragraph orienting a recipient who wasn't in the user's head. Enough
to answer well, not a page.

## How to answer

Deadline and rough effort. Partial answers and "I don't know" are useful:
flag anything you're unsure of rather than skipping it.

## <Theme heading>

### <One question — a single idea, never compound>

_Why this matters: <one line, only where the question could be misread or
invite a throwaway answer>._

>

## Anything else?

A closing catch-all: anything we didn't ask that we should know?
```

Every question gets an answer stub (`>`) directly beneath it.

## Pitfalls

1. **Grilling the user about the subject.** They can't answer it — that's
   why the document exists. Only interview the send.
2. **Compound questions.** One idea per question; split "and/or" questions.
3. **Burying the critical question.** Most-important-first; async
   recipients fade.
4. **Context dump.** One orienting paragraph, not the whole history.
5. **Skipping the "why this matters" line on ambiguous questions.** It's
   what turns a throwaway answer into a useful one — but don't add it to
   questions that are already unambiguous.

## Verification

- [ ] Recipient's role/knowledge and the needed outcomes captured in two
      exchanges before drafting
- [ ] Every step-2 item covered by at least one question
- [ ] Questions single-idea, most-important-first, answer stubs present
- [ ] File written and absolute path reported to the user
