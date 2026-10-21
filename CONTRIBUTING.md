# Contributing to LULUX ETA / 贡献指南

感谢你愿意参与！提交任何贡献前，请先阅读本文件、[行为准则](./CODE_OF_CONDUCT.md) 与 [许可证](./LICENSE)。

Thanks for your interest! Please read this guide, the [Code of Conduct](./CODE_OF_CONDUCT.md) and the [LICENSE](./LICENSE) before contributing. An English summary is at the end.

## 许可与签署（DCO）

- LULUX ETA 采用 **Business Source License 1.1**（源码可用，非 OSI 开源），到 Change Date 后转为 Apache-2.0。
- **你提交的贡献按与本项目相同的许可条款授权**（inbound = outbound：BSL 1.1，参数同仓库根目录 `LICENSE`，并随之在 Change Date 转为 Apache License 2.0）。
- 本项目使用 [Developer Certificate of Origin 1.1](https://developercertificate.org/)（DCO），**不使用 CLA**。每个提交都必须带 `Signed-off-by`，表示你确认拥有提交该代码的权利：

```bash
git commit -s -m "feat(client): 客户列表支持按阶段筛选"
# 会自动追加：Signed-off-by: Your Name <you@example.com>
```

忘了签署？`git commit --amend -s`（最后一个提交）或 `git rebase --signoff main`（整个分支）后强推。签署用的姓名与邮箱必须真实可联系。

<details>
<summary>Developer Certificate of Origin 1.1 全文</summary>

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

</details>

## 开发环境

- Node.js **≥ 22.13**（使用内置 `node:sqlite`；CI 使用 Node 22）
- npm 10+（仓库使用 npm workspaces，请勿提交 yarn / pnpm 锁文件）
- Git；Windows / macOS / Linux 均可

```bash
git clone <repo-url> && cd LuLux-Agent
npm ci                 # 如果你的 npm 全局配置了 omit=dev，用 npm ci --include=dev
npm run dev            # API（51789）+ Web 界面（51790）
npm run dev:desktop    # 构建后启动 Electron 桌面端
```

浏览器开发态下，服务端会把 API token 写到 `<数据目录>/api-token`，Vite 代理自动带上，无需手动处理。建议用 `LULUX_ETA_HOME=/tmp/lulux-dev` 指向一个测试数据目录。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时启动 server 与 client 开发模式 |
| `npm run dev:desktop` | 构建 server + client 后启动桌面端 |
| `npm run build` | 构建三个包 |
| `npm run dist` | 生成桌面安装包（输出到 `packages/desktop/release/`） |
| `npm run -ws --if-present lint` | 各包 ESLint |
| `npm run -ws --if-present typecheck` | 各包类型检查 |
| `npm run -ws --if-present test` | 各包测试（Vitest；客户端可能含 Playwright 冒烟） |

各包的具体脚本以 `packages/*/package.json` 为准；CI（`.github/workflows/ci.yml`）执行的就是上面这几条。

## 分支与提交规范

- 从 `main` 拉分支：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`<type>(<scope>): <subject>`
  - type：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `security`
  - scope：`server` / `client` / `desktop` / `docs` / `ci` / `deps`
  - 破坏性变更在 footer 写 `BREAKING CHANGE: ...`
- 一个 PR 只做一件事；改动 API 时，**先改 [`docs/API-CONTRACT.md`](./docs/API-CONTRACT.md) 并在其“变更记录”写一行**。
- 用户可见的变更，请在 [`CHANGELOG.md`](./CHANGELOG.md) 的 `Unreleased` 下追加一行。

## PR 检查清单

- [ ] 所有提交都有 `Signed-off-by`（DCO）
- [ ] `lint`、`typecheck`、`test`、`build` 本地通过
- [ ] 新功能 / 修复带测试；安全相关改动带回归测试
- [ ] 没有提交密钥、个人路径、个人或客户数据（截图请使用示例数据）
- [ ] 没有引入第三方 logo、商标或从其他项目复制的代码 / 文案 / 界面资源
- [ ] 新增依赖的许可证与 BSL 兼容（MIT / BSD / ISC / Apache-2.0 等宽松许可证；GPL / AGPL 类不接受），并更新 `THIRD_PARTY_LICENSES.md`

## 安全问题

请勿通过 Issue 报告漏洞，按 [SECURITY.md](./SECURITY.md) 私密报告。

## 代码风格

- TypeScript strict；Vue 3 `<script setup>`；缩进 2 空格、LF 换行、UTF-8（见 `.editorconfig`）。
- 服务端：路由层只做校验与状态码，业务逻辑在 service 层；错误统一返回 `{ error: { code, message } }`。
- 界面文案目前以简体中文为主；规划中的功能显示“即将推出”，不要做可点击的假功能。

---

## English summary

- **License & DCO.** Contributions are accepted under the same license as the project (BSL 1.1 with the parameters in `LICENSE`, converting to Apache-2.0 on the Change Date). We use the [DCO](https://developercertificate.org/), not a CLA: sign off every commit with `git commit -s`.
- **Setup.** Node.js ≥ 22.13, npm workspaces. `npm ci`, then `npm run dev` (server + web) or `npm run dev:desktop`.
- **Checks.** `npm run -ws --if-present lint | typecheck | test` and `npm run build` must pass; CI runs them on Ubuntu, Windows, and macOS.
- **Commits.** Conventional Commits (`feat(client): ...`). API changes start in `docs/API-CONTRACT.md`. Add user-visible changes to `CHANGELOG.md`.
- **Do not** commit secrets, personal data, third-party logos, or code copied from other projects. Only permissively licensed dependencies.
- **Security issues** go through [SECURITY.md](./SECURITY.md), never public issues.
