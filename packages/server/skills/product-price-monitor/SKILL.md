---
name: product-price-monitor
description: "监控具体商品（如竞品在电商平台上的售价）的全口径价格与库存，按条件判断是否需要提醒。 Watch product, flight, or listing prices; alert on target."
license: MIT
metadata:
  author: "Ben Barclay (benbarclay), Hermes Agent"
  version: "0.1.0"
  category: research
  keywords: ["价格监控", "竞品价格", "比价", "price monitor", "降价提醒", "Prices", "Availability", "Shopping", "Travel", "Alerts"]
  source: "https://github.com/NousResearch/hermes-agent/tree/1f91fb386a60f5589146b05ee88e911bb58120e8/skills/productivity/product-price-monitor"
  upstream-commit: 1f91fb386a60f5589146b05ee88e911bb58120e8
  upstream-license: "MIT (Copyright (c) 2025 Nous Research) — see THIRD_PARTY_LICENSES.md"
  modified: "LULUX ETA: tool names adapted to LULUX (workspace_read/workspace_write/fetch_url/run_skill_script/search_emails/create_email_draft), Hermes-only infrastructure references removed"
---

# Product Price Monitor

> 本技能导入自 Hermes Agent（MIT，作者：Ben Barclay (benbarclay), Hermes Agent；上游：https://github.com/NousResearch/hermes-agent，提交 1f91fb386a60，路径 `skills/productivity/product-price-monitor`）。LULUX 改动：工具名改为 LULUX 工具，去掉 Hermes 专属基础设施的引用。

Monitor a concrete purchasable item and alert on a normalized all-in price or availability condition. Handle variants, taxes, fees, currencies, stock, cancellation terms, and duplicate alerts explicitly. Setup runs once in the foreground; the recurring check is re-run on request (LULUX has no scheduler) .

## When to Use

- "Alert me when this laptop drops below $1,000."
- "Watch these flights for a fare under $500."
- "Tell me when this hotel has a refundable room."
- "Track ticket/listing availability."
- A cron tick fires for an existing price watch (steps 4-6).

Don't use for: one-off "what does this cost right now" lookups (use `web_search`/`fetch_url` directly).

## Procedure — Setup (foreground, once)

### 1. Define the exact item

Record source URL/provider, product/listing ID where available, variant, quantity, location, dates, travelers/guests, membership/login assumptions, condition, seller, and acceptable substitutes. Done when two variants cannot be confused.

### 2. Define the alert condition

Specify currency, all-in vs pre-tax price, maximum price, availability/stock rule, shipping, refundability, cabin/room/ticket class, cooldown, and notification destination. Done when synthetic examples have deterministic alert decisions.

### 3. Establish a live baseline, then schedule

Fetch a bounded live result with `fetch_url` and record retrieval time, source price, fees/taxes, availability, and terms. Do not schedule until one foreground fetch works. Write the watch contract (item, condition, baseline observation) to a state file at `price-watches/<watch-slug>.json` in the session workspace (via `workspace_write`), then:

LULUX 目前没有定时任务：把监控约定写入工作区文件后，告诉用户“需要检查时对我说『运行 product-price-monitor 检查 <名称>』”，每次检查按下面的 Tick 步骤执行。

Pick a cadence that respects rate limits and site terms. Done when the baseline matches the exact item contract and the watch contract file is saved.

## Procedure — Tick (each scheduled run)

### 4. Fetch and normalize

Re-fetch the source. Convert currency only with a timestamped rate and retain the source currency. Separate base price, mandatory fees, shipping/taxes, total, and availability. Exclude volatile page metadata. A failed fetch means unknown state: report or skip, but never overwrite the last good observation with an error page. Done when the observation is comparable to the baseline or explicitly marked failed.

### 5. Compare and suppress duplicates

Alert on threshold entry, qualifying availability, material lower price, or recovery as requested. Store the last good observation and last alert fingerprint in the state file. Replaying the same offer must send no second alert; respect the cooldown. Done when the alert decision is deterministic against stored state.

### 6. Deliver or stay silent

When a condition is met, the alert includes: exact item/variant, observed all-in price and source currency, availability/terms, threshold, retrieval timestamp, source link, and important uncertainty. Never claim inventory is reserved. When nothing qualifies, stay silent — no "still watching" noise unless a periodic all-clear was requested. Done when the state file reflects this run.

## Pitfalls

- Comparing a base fare with an all-in threshold.
- Alerting on the wrong size, seller, cabin, dates, or room terms.
- Overwriting a last-known-good value with an error page.
- Polling aggressively enough to trigger blocking or violate site terms.
- Scheduling before a single foreground fetch has succeeded.

## Verification

- [ ] The watch contract pins the item so two variants cannot be confused.
- [ ] One foreground fetch succeeded before any job was created.
- [ ] Alert decisions replay deterministically from the state file; duplicates suppressed.
- [ ] Failed fetches never replaced last-known-good state.
- [ ] Alerts carry all-in price, source currency, timestamp, and source link.
