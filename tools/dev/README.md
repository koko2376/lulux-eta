# 开发辅助脚本

这些脚本只在开发与测试时使用，不参与打包。

## Mock Provider（`mock-openai.js`）

```bash
node tools/dev/mock-openai.js 51999
```

模拟一个 OpenAI 兼容上游。在设置里新增一个 OpenAI 兼容 Provider，Base URL 填 `http://127.0.0.1:51999/v1`，模型填 `mock-mini`，即可在没有真实 API Key 的情况下验证 SSE 流式输出、代码块产物与工具审批界面。服务端集成测试与客户端 Playwright 测试也用它做上游（`POST /__mock/script` 编排回复，见 `docs/BUILTIN-KERNEL.md` 第 2 节）。

## 连接团队服务器（远程模式）检查（`remote-mode-check.js`）

先启动带调试端口的桌面端：

```bash
npm run build
env -u ELECTRON_RUN_AS_NODE \
  LULUX_ETA_HOME="<临时目录>/lulux-eta-home" \
  npx electron packages/desktop \
  --remote-debugging-port=9335 \
  --user-data-dir="<临时目录>/lulux-eta-userdata"
```

- `<临时目录>` 换成任意可写的临时目录（如 Windows 的 `%TEMP%`、macOS / Linux 的 `/tmp`）。
- `LULUX_ETA_HOME` 指定数据目录，避免把测试数据写进用户目录。
- 如果当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`，必须用 `env -u` 去掉，否则窗口不会出现。

然后：

```bash
# 1. 起一个本机团队服务器（http 只允许 127.0.0.1 / localhost）
LULUX_MODE=server LULUX_PUBLIC_ORIGIN=http://127.0.0.1:52900 LULUX_ETA_PORT=52900 \
  LULUX_ETA_HOME="<临时目录>/lulux-team" node packages/server/dist/index.js
# 2. 用日志里的 SETUP TOKEN 调 POST /api/auth/setup 建 owner（或 node packages/server/dist/cli.js create-owner …）
# 3. 检查
node tools/dev/remote-mode-check.js 9335 http://127.0.0.1:52900 <owner邮箱> <密码>
```

脚本在渲染进程里调用 `window.luluxAgent.api`，依次验证：本地 → 远程切换、本机 token 不暴露、CSP 放行团队服务器、跨源登录（CORS）、`setSession/getSession`、其他 origin 仍被拦截、切回本地、再切回远程免登录。Linux 无桌面环境可用 `Xvfb :99 &` 并设 `DISPLAY=:99`，容器里加 `--no-sandbox`。

## 导入 Hermes Agent 技能（`import-hermes-skills.py`）

```bash
python3 tools/dev/import-hermes-skills.py <hermes-agent 仓库路径>
```

来源、许可与筛选规则见 `docs/SKILLS.md`。
