# 本地验收脚本

这些脚本只用于开发期验证界面与流式对话，不参与打包。

## 启动带调试端口的桌面端

```bash
# Windows（Git Bash），在仓库根目录执行
npm run build
env -u ELECTRON_RUN_AS_NODE \
  LULUX_ETA_HOME="<临时目录>/lulux-eta-home" \
  ./node_modules/electron/dist/electron.exe packages/desktop \
  --remote-debugging-port=9335 \
  --user-data-dir="<临时目录>/lulux-eta-userdata"
```

- `<临时目录>` 换成任意可写的临时目录（如 Windows 的 `%TEMP%`、macOS / Linux 的 `/tmp`），不要用个人目录。
- `9335` 是 CDP 调试端口。
- `LULUX_ETA_HOME` 指定数据目录，避免把测试数据写进用户目录。
- 如果当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`，必须用 `env -u` 去掉，否则窗口不会出现。

## 截图与取页面信息

```bash
node tools/dev/shot.js 9335 <临时目录>/shot.png          # 截图
node tools/dev/cdp.js 9335 "document.title"          # 在页面里执行表达式
node tools/dev/shot-menu.js 9335 <临时目录>/menu.png     # 打开内核下拉后立即截图
powershell -File tools/dev/cap.ps1 <临时目录>/window.png # 连原生 WebContentsView 一起截窗口
```

`cap.ps1` 用于内置浏览器面板这种由原生视图绘制、CDP 截不到的区域。

## Mock Provider

```bash
node tools/dev/mock-openai.js 51999
```

在设置里新增一个 OpenAI 兼容 Provider，Base URL 填 `http://127.0.0.1:51999/v1`，模型填 `mock-mini`，即可在没有真实 API Key 的情况下验证 SSE 流式输出、代码块产物与工具审批界面。

## 连接团队服务器（远程模式）验收

```bash
# 1. 起一个本机团队服务器（http 只允许 127.0.0.1 / localhost）
LULUX_MODE=server LULUX_PUBLIC_ORIGIN=http://127.0.0.1:52900 LULUX_ETA_PORT=52900 \
  LULUX_ETA_HOME="<临时目录>/lulux-team" node packages/server/dist/index.js
# 2. 用日志里的 SETUP TOKEN 调 POST /api/auth/setup 建 owner（或 node packages/server/dist/cli.js create-owner …）
# 3. 按上文启动带调试端口的桌面端，然后：
node tools/dev/remote-mode-check.js 9335 http://127.0.0.1:52900 <owner邮箱> <密码>
```

脚本在渲染进程里调用 `window.luluxAgent.api`，依次验证：本地 → 远程切换、本机 token 不暴露、CSP 放行团队服务器、跨源登录（CORS）、`setSession/getSession`、其他 origin 仍被拦截、切回本地、再切回远程免登录。Linux 无桌面环境可用 `Xvfb :99 &` 并设 `DISPLAY=:99`，容器里加 `--no-sandbox`。
