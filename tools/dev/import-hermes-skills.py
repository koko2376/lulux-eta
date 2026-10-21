#!/usr/bin/env python3
"""
从 NousResearch/hermes-agent（MIT）官方仓库导入适合“外贸 + 通用办公”的 skill 到 packages/server/skills/。
用法：python3 tools/dev/import-hermes-skills.py <hermes-agent 仓库路径>

规则（见 docs/SKILLS.md “第三方 skill”）：
- 只从 Hermes 官方仓库导入，不从任何衍生项目拿；
- skill 目录内自带 LICENSE/NOTICE、或注明源自 Anthropic 等非 MIT 来源的一律不导入；
- 每个导入的 skill 在 frontmatter 记 source、upstream-commit、license: MIT，保留原作者；
- Hermes 专属工具名改为 LULUX 工具（skill_view、run_skill_script、fetch_url、workspace_* 等），
  正文开头加一段“改动说明”。
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_URL = "https://github.com/NousResearch/hermes-agent"
ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "packages" / "server" / "skills"

# 通用工具名替换（只替换反引号里的工具名，避免误伤正文）
TOOL_MAP = {
    "`read_file`": "`workspace_read`",
    "`write_file`": "`workspace_write`",
    "`patch`": "`workspace_write`",
    "`web_extract`": "`fetch_url`",
    "`browser_navigate`": "`fetch_url`",
    "`terminal`": "`run_skill_script`",
    "`execute_code`": "`run_skill_script`",
}

CRON_NOTE = (
    "LULUX 目前没有定时任务：把监控约定写入工作区文件后，告诉用户“需要检查时对我说『运行 {skill} 检查 <名称>』”，"
    "每次检查按下面的 Tick 步骤执行。"
)

SKILLS = [
    {
        "path": "skills/productivity/document-to-action-items",
        "category": "productivity",
        "keywords": ["待办提取", "文档待办", "合同义务", "截止日期", "行动项", "action items"],
        "zh": "从合同、信用证、招标文件、会议材料等文档中提取带出处的义务、截止日期与待办事项。",
        "replace": [
            ("`workspace_read` for local files", "`workspace_read` for workspace files (PDFs via the `pdf-tools` skill)"),
            ("related_skills: [pdf, pdf, docx, notion]", ""),
        ],
    },
    {
        "path": "skills/productivity/meeting-action-items",
        "category": "productivity",
        "keywords": ["会议待办", "会议行动项", "会议转写", "action items", "meeting notes"],
        "zh": "从会议记录或转写稿中提取决议、待办（负责人/截止日）与未决问题，并附原文出处。",
        "replace": [],
    },
    {
        "path": "skills/productivity/weekly-review-planning",
        "category": "productivity",
        "keywords": ["周复盘", "周计划", "每周回顾", "日程", "weekly review", "计划"],
        "zh": "每周复盘与下周计划：盘点完成情况、未完成事项、日程与优先级，产出可执行的周计划。",
        "replace": [],
    },
    {
        "path": "skills/productivity/product-price-monitor",
        "category": "research",
        "keywords": ["价格监控", "竞品价格", "比价", "price monitor", "降价提醒"],
        "zh": "监控具体商品（如竞品在电商平台上的售价）的全口径价格与库存，按条件判断是否需要提醒。",
        "cron": "product-price-monitor",
        "replace": [
            ("under `~/.hermes/price-watches/<watch-slug>.json`, then create the job:", "at `price-watches/<watch-slug>.json` in the session workspace (via `workspace_write`), then:"),
            ("`fetch_url` or `fetch_url`", "`fetch_url`"),
            ("the tick for the watch contract at ~/.hermes/price-watches/<watch-slug>.json", "the tick for the watch contract at price-watches/<watch-slug>.json"),
        ],
    },
    {
        "path": "skills/research/competitor-news-monitor",
        "category": "research",
        "keywords": ["竞品动态", "竞争对手", "竞品新闻", "competitor", "行业动态"],
        "zh": "跟踪一组竞争对手/客户公司的重大新动态（新品、价格、融资、合作、诉讼等），只报告有原始来源支撑的重要事件。",
        "cron": "competitor-news-monitor",
        "replace": [
            ("under `~/.hermes/competitor-watches/<watch-slug>.json`, then create the job:", "at `competitor-watches/<watch-slug>.json` in the session workspace (via `workspace_write`), then:"),
            ("Use `rss-feeds` (optional) or `blogwatcher` (optional, stateful) for feeds, `reddit-reading` for community discussion, and `web_search`/`fetch_url` for pages.",
             "Use `web_search` and `fetch_url` for pages and feeds (RSS/Atom URLs can be fetched directly with `fetch_url`)."),
            ("or plain feed reading (`blogwatcher`)", "or plain feed reading"),
        ],
    },
    {
        "path": "skills/email/email-inbox-triage",
        "category": "productivity",
        "keywords": ["邮箱整理", "收件箱", "邮件分拣", "inbox", "未回复邮件", "inbox zero"],
        "zh": "把收件箱变成可决策的队列：按紧急回复/需回复/仅行动/等待他人/参考/噪音分类，校准用户语气后起草回复草稿供批准。",
        "replace": [
            ("This skill owns thread-aware prioritization and reply policy; connector skills (`himalaya`, `google-workspace`) own provider commands.",
             "This skill owns thread-aware prioritization and reply policy; in LULUX the mailbox is read with `search_emails` (synced IMAP accounts) and replies are saved with `create_email_draft`."),
            ("(use the connector skill directly)", "(use `search_emails` directly)"),
            ("Load `himalaya`, `google-workspace`, or the relevant connector. Search with structured filters,",
             "Use `search_emails` (filters: `query`, `customerId`, `verdict`, `folder`, `limit`). Search with structured filters,"),
            ("pull a bounded set of the user's recent sent replies via the connector skill",
             "pull a bounded set of the user's recent sent replies with `search_emails` (`folder: \"sent\"`)"),
            ("Send, label, archive, or create follow-ups only within approval. For ambiguous send errors, inspect Sent before retrying — SMTP may have succeeded while save-to-Sent failed, and a blind retry duplicates the mail.",
             "In LULUX the agent never sends mail: save each approved reply with `create_email_draft` (`replyToMessageId`, `customerId`) and tell the user to review and send it from Mailbox → Drafts. Labeling/archiving is done by the user in the mailbox."),
            ("related_skills: [himalaya, google-workspace]", ""),
        ],
    },
    {
        "path": "optional-skills/communication/one-three-one-rule",
        "category": "writing",
        "keywords": ["1-3-1", "决策简报", "方案对比", "向老板汇报", "三个方案"],
        "zh": "1-3-1 决策简报：一个问题、三个选项、一个推荐，用于向上级/客户提出需要决策的事项。",
        "replace": [],
    },
    {
        "path": "optional-skills/productivity/decision-questionnaire",
        "category": "productivity",
        "keywords": ["决策问卷", "需求澄清", "问卷", "questionnaire", "澄清需求"],
        "zh": "把一个待定决策或模糊需求转成结构化问卷，逐项收集用户/客户的选择后再执行。",
        "replace": [],
    },
    {
        "path": "optional-skills/creative/simple-english",
        "category": "writing",
        "keywords": ["简明英语", "simple english", "简单英语", "非母语", "plain english"],
        "zh": "简明英语写作与检查规则：让非英语母语的客户也容易读懂邮件、说明书与文档。",
        "replace": [
            ("## How to use it in Hermes", "## How to use it in LULUX"),
            ("Use `workspace_read` to load it, then `workspace_write` for targeted section rewrites or `workspace_write` for a full rewrite.",
             "Use `workspace_read` to load it, then `workspace_write` to save the rewritten file."),
        ],
    },
    {
        "path": "optional-skills/creative/social-media-content-calendar",
        "category": "writing",
        "keywords": ["社媒日历", "内容日历", "LinkedIn", "社交媒体", "content calendar", "社媒运营"],
        "zh": "社交媒体内容日历：基于已核实的产品事实、案例与关键日期，排出多平台发帖计划与文案草稿。",
        "replace": [
            ("Load `humanizer` for voice; generate visuals with the `image_generate` tool where assets are needed.",
             "Use the `translate-polish` skill for voice; LULUX does not generate images — list the visual assets needed and their status so the user can supply them."),
        ],
    },
    {
        "path": "optional-skills/research/domain-intel",
        "category": "research",
        "keywords": ["域名查询", "whois", "域名注册", "SSL证书", "DNS", "域名年龄", "domain"],
        "zh": "被动域名情报：WHOIS 注册时间、DNS/MX、SSL 证书、子域名（证书透明日志），用于核实客户官网与邮箱域名（如域名注册时间过新）。",
        "requires_python": True,
        "replace": [
            ("python SKILL_DIR/scripts/domain_intel.py ", "domain_intel.py "),
            ("`SKILL_DIR` is the directory containing this SKILL.md file. All output is structured JSON.",
             "In LULUX run it with `run_skill_script` (`skill: \"domain-intel\"`, `script: \"domain_intel.py\"`, `args: [\"whois\", \"example.com\"]`); each run needs user approval and Python 3 on the machine. All output is structured JSON."),
            ("- **Use `run_skill_script` with `curl -I`** for a simple \"is this URL reachable\" check", "- **Use `fetch_url`** for a simple \"is this URL reachable\" check"),
            ("| \"Check if a URL is reachable\" | `run_skill_script` with `curl -I` | Simple HTTP check |", "| \"Check if a URL is reachable\" | `fetch_url` | Simple HTTP check |"),
        ],
    },
    {
        "path": "skills/research/grounded-citations",
        "category": "research",
        "keywords": ["引用", "来源", "出处", "citation", "事实核查", "调研报告"],
        "zh": "有据可查的引用：给调研回答与报告中的每条外部事实加编号引用与来源列表，并可校验引用与原文摘录。",
        "requires_python": True,
        "replace": [
            ("Retrieval comes from whatever is configured: `web_search`, `fetch_url`,\n`fetch_url`, or `run_skill_script` (curl, CLIs).",
             "Retrieval comes from `web_search` and `fetch_url`."),
            ("Ledger location: `$HERMES_HOME/cache/citations/ledger.json` (profile-aware).\nOverride per task with `--ledger <path>` or `HERMES_CITATION_LEDGER`.",
             "Ledger location in LULUX: `.citations/ledger.json` inside the session workspace.\nOverride per task with `--ledger <path>`."),
            ("S=~/.hermes/skills/research/grounded-citations/scripts/sources.py\n", ""),
            ("`hermes skills install official/social-media/reddit-reading` or\n`hermes skills install official/research/rss-feeds` before using them.",
             "these optional Hermes skills are not bundled with LULUX; use `web_search`/`fetch_url` instead."),
            ("(or `HERMES_CITATION_LEDGER`)", ""),
        ],
        "file_patches": {
            "scripts/_hermes_home.py": ("__REPLACE_ALL__", '''"""Resolve the citation ledger home for standalone skill scripts.

Modified for LULUX ETA (originally resolved HERMES_HOME): in LULUX the skill script
runs with the session workspace as its working directory (exported as
LULUX_WORKSPACE), so the ledger lives in <workspace>/.citations/.
The function name is kept so sources.py stays close to upstream.
"""

from __future__ import annotations

import os
from pathlib import Path


def get_hermes_home() -> Path:
    """Return the LULUX session workspace (falls back to the current directory)."""
    val = os.environ.get("LULUX_WORKSPACE", "").strip()
    return Path(val) if val else Path.cwd()
'''),
            "scripts/sources.py": [
                ('return get_hermes_home() / "cache" / "citations" / "ledger.json"', 'return get_hermes_home() / ".citations" / "ledger.json"  # LULUX: session workspace'),
                ("  $HERMES_HOME/cache/citations/ledger.json", "  <LULUX session workspace>/.citations/ledger.json"),
            ],
            "references/grounding-rationale.md": [("Hermes has no such UI layer", "LULUX has no such UI layer")],
        },
        "extra_note": (
            "In LULUX every shell line of the form `python \"$S\" <args…>` below means: call `run_skill_script` with "
            "`skill: \"grounded-citations\"`, `script: \"sources.py\"`, `args: [<args…>]` (each run needs user approval). "
            "To attach quotes with `--from page.txt`, first save the fetched page text with `workspace_write`."
        ),
    },
]

SKIP = [
    ("skills/productivity/docx", "目录自带 LICENSE 文件（按规则不导入），改为原创 word-docx 技能"),
    ("skills/productivity/xlsx", "目录自带 LICENSE 文件（按规则不导入），改为原创 excel-xlsx 技能"),
    ("skills/productivity/powerpoint", "目录自带 LICENSE 文件（按规则不导入），改为原创 ppt-pptx 技能"),
    ("skills/productivity/pdf", "目录自带 LICENSE 文件（按规则不导入），改为原创 pdf-tools 技能"),
    ("skills/creative/humanizer", "目录自带 LICENSE（作者 Siqi Chen），按规则不导入；润色由原创 translate-polish 覆盖"),
    ("optional-skills/finance/excel-author", "注明 author: Anthropic、license: Apache-2.0（非 MIT 来源），不导入"),
    ("optional-skills/finance/pptx-author", "注明 author: Anthropic、license: Apache-2.0（非 MIT 来源），不导入"),
    ("optional-skills/research/duckduckgo-search", "依赖 pip 包 ddgs 与 execute_code；LULUX 已有 web_search"),
    ("skills/web/blocked-page-recovery", "依赖 curl/浏览器的反封锁抓取技巧，LULUX 无浏览器工具且不宜绕过网站限制"),
    ("skills/productivity/google-workspace / notion / airtable / box / maps / teams-meeting-pipeline", "依赖第三方 API 凭据或 Hermes 连接器"),
    ("skills/research/arxiv / llm-wiki", "学术论文/Hermes 知识库专用，与外贸办公关系弱"),
    ("optional-skills/research/osint-investigation", "个人信息调查风险高，客户背调由原创 customer-background-check 覆盖"),
    ("optional-skills/research/searxng-search / parallel-cli / scrapling / qmd / blogwatcher / rss-feeds", "依赖外部 CLI 或服务"),
    ("optional-skills/data-science/jupyter-notebook", "依赖 Jupyter 运行环境"),
    ("skills/apple/*", "仅适用 macOS/Apple"),
    ("skills/note-taking/obsidian、skills/email/himalaya", "依赖本机第三方 CLI/应用"),
    ("skills/software-development/*、devops/*、mlops/*、autonomous-ai-agents/*", "开发调试/Hermes 基础设施类"),
    ("skills/creative/*（多数）、media/*、social-media/*、gaming/*、blockchain/*、smart-home/*、health/*、payments/* 等", "与外贸办公无关或依赖专有服务"),
]


def split_frontmatter(text: str):
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        raise SystemExit("frontmatter not found")
    return m.group(1), m.group(2)


def field(front: str, key: str):
    m = re.search(rf"^{key}:\s*(.+)$", front, re.M)
    if not m:
        return None
    value = m.group(1).strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    return value


def tags(front: str):
    m = re.search(r"^\s+tags:\s*\[(.*?)\]", front, re.M)
    return [t.strip() for t in m.group(1).split(",")] if m else []


def yaml_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    repo = Path(sys.argv[1]).resolve()
    commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    imported = []
    for spec in SKILLS:
        src = repo / spec["path"]
        name = src.name
        # 规则：目录内有 LICENSE/NOTICE 或注明 Anthropic 的不导入
        for f in src.rglob("*"):
            if f.is_file() and re.match(r"(LICENSE|NOTICE|COPYING)", f.name, re.I):
                raise SystemExit(f"{spec['path']} contains {f.name}; refusing to import")
            if f.is_file() and f.suffix in (".md", ".py", ".txt") and re.search(r"anthropic", f.read_text(errors="ignore"), re.I):
                raise SystemExit(f"{spec['path']} mentions Anthropic ({f.name}); refusing to import")
        dest = DEST / name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        text = (dest / "SKILL.md").read_text()
        front, body = split_frontmatter(text)
        description = field(front, "description") or ""
        author = field(front, "author") or "Hermes Agent"
        version = field(front, "version") or "1.0.0"
        upstream_tags = tags(front)
        for old, new in TOOL_MAP.items():
            body = body.replace(old, new)
        for old, new in spec.get("replace", []):
            if old and old not in body and old not in front:
                print(f"  ! {name}: replacement not found: {old[:60]!r}", file=sys.stderr)
            body = body.replace(old, new)
        body = body.replace("`fetch_url` or `fetch_url`", "`fetch_url`")
        if spec.get("cron"):
            body = re.sub(r"```\ncronjob\(action=\"create\",.*?```", CRON_NOTE.format(skill=spec["cron"]), body, flags=re.S)
            body = body.replace("the recurring check runs as a `cronjob` tick", "the recurring check is re-run on request (LULUX has no scheduler)")
            body = re.sub(r"\(the `[a-z-]+` automation blueprint scaffolds this\)", "", body)
            body = body.replace("and the job exists", "and the watch contract file is saved")
        keywords = spec["keywords"] + [t for t in upstream_tags if t not in spec["keywords"]]
        source = f"{REPO_URL}/tree/{commit}/{spec['path']}"
        requires = "\n  requires:\n    python: true" if spec.get("requires_python") else ""
        new_front = "\n".join(
            [
                f"name: {name}",
                f"description: {yaml_str(spec['zh'] + ' ' + description)}",
                "license: MIT",
                "metadata:",
                f"  author: {yaml_str(author)}",
                f"  version: {yaml_str(version)}",
                f"  category: {spec['category']}",
                f"  keywords: [{', '.join(yaml_str(k) for k in keywords)}]",
                f"  source: {yaml_str(source)}",
                f"  upstream-commit: {commit}",
                f"  upstream-license: \"MIT (Copyright (c) 2025 Nous Research) — see THIRD_PARTY_LICENSES.md\"",
                "  modified: \"LULUX ETA: tool names adapted to LULUX (workspace_read/workspace_write/fetch_url/run_skill_script/search_emails/create_email_draft), Hermes-only infrastructure references removed\"",
            ]
        ) + requires
        note = (
            f"> 本技能导入自 Hermes Agent（MIT，作者：{author}；上游：{REPO_URL}，提交 {commit[:12]}，路径 `{spec['path']}`）。"
            "LULUX 改动：工具名改为 LULUX 工具，去掉 Hermes 专属基础设施的引用。"
        )
        if spec.get("extra_note"):
            note += "\n>\n> " + spec["extra_note"]
        lines = body.split("\n")
        insert_at = next((i + 1 for i, l in enumerate(lines) if l.startswith("# ")), 0)
        lines[insert_at:insert_at] = ["", note]
        (dest / "SKILL.md").write_text(f"---\n{new_front}\n---\n" + "\n".join(lines))
        for rel, patch in spec.get("file_patches", {}).items():
            target = dest / rel
            if isinstance(patch, tuple) and patch[0] == "__REPLACE_ALL__":
                target.write_text(patch[1])
                continue
            content = target.read_text()
            for old, new in patch:
                if old not in content:
                    print(f"  ! {name}/{rel}: patch not found: {old[:60]!r}", file=sys.stderr)
                content = content.replace(old, new)
            target.write_text(content)
        imported.append({"name": name, "path": spec["path"], "author": author})
        print(f"imported {name}")
    manifest = {"source": REPO_URL, "commit": commit, "license": "MIT", "imported": imported, "skipped": [{"path": p, "reason": r} for p, r in SKIP]}
    (DEST / "THIRD_PARTY_SKILLS.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
