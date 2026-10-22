---
name: domain-intel
description: "被动域名情报：WHOIS 注册时间、DNS/MX、SSL 证书、子域名（证书透明日志），用于核实客户官网与邮箱域名（如域名注册时间过新）。 Passive recon of subdomains, SSL certs, WHOIS, and DNS."
license: MIT
metadata:
  author: "FurkanL0, Hermes Agent"
  version: "1.0.0"
  category: research
  keywords: ["域名查询", "whois", "域名注册", "SSL证书", "DNS", "域名年龄", "domain", "Domains", "OSINT", "Research"]
  source: "https://github.com/NousResearch/hermes-agent/tree/1f91fb386a60f5589146b05ee88e911bb58120e8/optional-skills/research/domain-intel"
  upstream-commit: 1f91fb386a60f5589146b05ee88e911bb58120e8
  upstream-license: "MIT (Copyright (c) 2025 Nous Research) — see THIRD_PARTY_LICENSES.md"
  modified: "LULUX ETA: tool names adapted to LULUX (workspace_read/workspace_write/fetch_url/run_skill_script/search_emails/create_email_draft), Hermes-only infrastructure references removed"
  requires:
    python: true
---

# Domain Intelligence — Passive OSINT

> 本技能导入自 Hermes Agent（MIT，作者：FurkanL0, Hermes Agent；上游：https://github.com/NousResearch/hermes-agent，提交 1f91fb386a60，路径 `optional-skills/research/domain-intel`）。LULUX 改动：工具名改为 LULUX 工具，去掉 Hermes 专属基础设施的引用。

Passive domain reconnaissance using only Python stdlib.
**Zero dependencies. Zero API keys. Works on Linux, macOS, and Windows.**

## Helper script

This skill includes `scripts/domain_intel.py` — a complete CLI tool for all domain intelligence operations.

```bash
# Subdomain discovery via Certificate Transparency logs
domain_intel.py subdomains example.com

# SSL certificate inspection (expiry, cipher, SANs, issuer)
domain_intel.py ssl example.com

# WHOIS lookup (registrar, dates, name servers — 100+ TLDs)
domain_intel.py whois example.com

# DNS records (A, AAAA, MX, NS, TXT, CNAME)
domain_intel.py dns example.com

# Domain availability check (passive: DNS + WHOIS + SSL signals)
domain_intel.py available coolstartup.io

# Bulk analysis — multiple domains, multiple checks in parallel
domain_intel.py bulk example.com github.com google.com
domain_intel.py bulk example.com github.com --checks ssl,dns
```

In LULUX run it with `run_skill_script` (`skill: "domain-intel"`, `script: "domain_intel.py"`, `args: ["whois", "example.com"]`); each run needs user approval and Python 3 on the machine. All output is structured JSON.

## Available commands

| Command | What it does | Data source |
|---------|-------------|-------------|
| `subdomains` | Find subdomains from certificate logs | crt.sh (HTTPS) |
| `ssl` | Inspect TLS certificate details | Direct TCP:443 to target |
| `whois` | Registration info, registrar, dates | WHOIS servers (TCP:43) |
| `dns` | A, AAAA, MX, NS, TXT, CNAME records | System DNS + Google DoH |
| `available` | Check if domain is registered | DNS + WHOIS + SSL signals |
| `bulk` | Run multiple checks on multiple domains | All of the above |

## When to use this vs built-in tools

- **Use this skill** for infrastructure questions: subdomains, SSL certs, WHOIS, DNS records, availability
- **Use `web_search`** for general research about what a domain/company does
- **Use `fetch_url`** to get the actual content of a webpage
- **Use `fetch_url`** for a simple "is this URL reachable" check

| Task | Better tool | Why |
|------|-------------|-----|
| "What does example.com do?" | `fetch_url` | Gets page content, not DNS/WHOIS data |
| "Find info about a company" | `web_search` | General research, not domain-specific |
| "Is this website safe?" | `web_search` | Reputation checks need web context |
| "Check if a URL is reachable" | `fetch_url` | Simple HTTP check |
| "Find subdomains of X" | **This skill** | Only passive source for this |
| "When does the SSL cert expire?" | **This skill** | Built-in tools can't inspect TLS |
| "Who registered this domain?" | **This skill** | WHOIS data not in web search |
| "Is coolstartup.io available?" | **This skill** | Passive availability via DNS+WHOIS+SSL |

## Platform compatibility

Pure Python stdlib (`socket`, `ssl`, `urllib`, `json`, `concurrent.futures`).
Works identically on Linux, macOS, and Windows with no dependencies.

- **crt.sh queries** use HTTPS (port 443) — works behind most firewalls
- **WHOIS queries** use TCP port 43 — may be blocked on restrictive networks
- **DNS queries** use Google DoH (HTTPS) for MX/NS/TXT — firewall-friendly
- **SSL checks** connect to the target on port 443 — the only "active" operation

## Data sources

All queries are **passive** — no port scanning, no vulnerability testing:

- **crt.sh** — Certificate Transparency logs (subdomain discovery, HTTPS only)
- **WHOIS servers** — Direct TCP to 100+ authoritative TLD registrars
- **Google DNS-over-HTTPS** — MX, NS, TXT, CNAME resolution (firewall-friendly)
- **System DNS** — A/AAAA record resolution
- **SSL check** is the only "active" operation (TCP connection to target:443)

## Notes

- WHOIS queries use TCP port 43 — may be blocked on restrictive networks
- Some WHOIS servers redact registrant info (GDPR) — mention this to the user
- crt.sh can be slow for very popular domains (thousands of certs) — set reasonable expectations
- The availability check is heuristic-based (3 passive signals) — not authoritative like a registrar API

---

*Contributed by [@FurkanL0](https://github.com/FurkanL0)*
