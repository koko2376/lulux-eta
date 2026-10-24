---
name: social-media-content-calendar
description: "社交媒体内容日历：基于已核实的产品事实、案例与关键日期，排出多平台发帖计划与文案草稿。 Plan multi-platform social campaigns: briefs to posting."
license: MIT
metadata:
  author: "Ben Barclay (benbarclay), Hermes Agent"
  version: "0.1.0"
  category: writing
  keywords: ["社媒日历", "内容日历", "LinkedIn", "社交媒体", "content calendar", "社媒运营", "Social-Media", "Content-Calendar", "Campaigns", "Publishing"]
  source: "https://github.com/NousResearch/hermes-agent/tree/1f91fb386a60f5589146b05ee88e911bb58120e8/optional-skills/creative/social-media-content-calendar"
  upstream-commit: 1f91fb386a60f5589146b05ee88e911bb58120e8
  upstream-license: "MIT (Copyright (c) 2025 Nous Research) — see THIRD_PARTY_LICENSES.md"
  modified: "LULUX ETA: tool names adapted to LULUX (workspace_read/workspace_write/fetch_url/run_skill_script/search_emails/create_email_draft), Hermes-only infrastructure references removed"
---

# Social Media Content Calendar

> 本技能导入自 Hermes Agent（MIT，作者：Ben Barclay (benbarclay), Hermes Agent；上游：https://github.com/NousResearch/hermes-agent，提交 1f91fb386a60，路径 `optional-skills/creative/social-media-content-calendar`）。LULUX 改动：工具名改为 LULUX 工具，去掉 Hermes 专属基础设施的引用。

Plan a concrete calendar across selected social platforms. This skill owns campaign structure, post briefs, channel adaptation, approvals, and publishing verification; platform skills such as `xurl` own API commands. For platforms without a connector, the verified handoff ends at approved drafts for the user's scheduler — say so rather than claiming publication.

## When to Use

- "Build next month's social calendar."
- "Turn this launch into posts for X, LinkedIn, Instagram, and TikTok."
- "Draft and schedule a campaign."
- "Repurpose these articles/videos into social content."

Don't use for: single one-off posts (use the platform skill directly).

## Procedure

### 1. Define campaign constraints

Record objective, audience, offer/message, platforms, date range, cadence, voice, mandatory/prohibited claims, links, tracking convention, localization, and approval/publishing authority. Done when each proposed post has a clear business purpose.

### 2. Inventory source material

Collect verified product facts, launches, articles, media, testimonials with permission, brand assets, and key dates using `workspace_read` and `fetch_url`. Mark claim owners and expiration. Done when unsupported claims and missing assets are visible.

### 3. Build themes and calendar slots

Create a balanced mix such as education, proof, product, community, event, behind-the-scenes, and conversation. Account for platform cadence and campaign milestones. Done when dates, platforms, themes, and objectives form a coherent calendar rather than duplicate cross-posts.

### 4. Write platform-specific briefs

For each post specify hook, core message, format, copy length, CTA, link, asset dimensions/content, accessibility text, tags/mentions, and success metric. Adapt rather than copy-paste between platforms. Done when a creator can produce the asset without hidden context.

### 5. Draft copy and assets

Use the `translate-polish` skill for voice; LULUX does not generate images — list the visual assets needed and their status so the user can supply them. Preserve factual claims and shared campaign identity while respecting platform norms. Done when every calendar slot has draft copy and asset status.

### 6. Run editorial and risk review

Check factual accuracy, tone, repetition, rights/permissions, accessibility, disclosures, link destination, date relevance, and crisis sensitivity. Mark `draft`, `needs review`, or `approved`; do not publish from draft. Done when every post has a disposition and owner.

### 7. Schedule or hand off

Present the approval batch. Publish/schedule only approved posts using available platform skills (`xurl` for X); for platforms without a connector, deliver the approved package (copy, assets, timing) for the user's scheduling tool and mark those slots handed-off, not published. Read back scheduled time, account, content preview, and provider post/job ID for anything actually published. Done when the calendar reflects verified publishing or handoff status per slot.

## Pitfalls

- Identical copy on every platform.
- Filling cadence with low-value repetitive posts.
- Publishing unverified metrics, testimonials, or future claims.
- Confusing generated asset completion with scheduled publication.
- Claiming "scheduled" for platforms where the handoff ended at drafts.

## Verification

- [ ] Every post traces to a campaign objective and a verified claim inventory.
- [ ] No post was published from `draft` or `needs review` state.
- [ ] Published slots have provider-confirmed IDs; handed-off slots are marked as such.
- [ ] Rights, permissions, and disclosures checked before any publish.
