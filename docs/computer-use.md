# Computer-use：Agent 操作桌面应用（v0.1.2，实验性）

Agent 通过一组 `computer_*` 工具看屏幕（截图）并用鼠标键盘操作本机桌面应用（没有 API 的客户端、Excel、本地 ERP、单证软件等）。

**默认关闭。** 需要同时满足：设置里打开「电脑操作（实验性）」+ 当前会话里由用户手动开启 + 本地桌面模式 + 当前模型支持看图。

## 架构

```
Agent 工具 (server: services/computer/*)  ──process IPC──▶  桌面主进程 (desktop/src/computer-agent.ts)
                                                              ├─ desktopCapturer / screen（截屏、显示器信息）
                                                              ├─ robotjs 0.9.1（MIT，N-API 预编译 win/mac/linux × x64/arm64，鼠标键盘）
                                                              └─ 边框提示窗（置顶、点击穿透、不进截图）
```

- 只在本地桌面模式可用（服务进程由主进程 fork，复用 browser-use 那条 IPC）。团队服务器 / 纯网页端：工具不出现。
- robotjs 是 desktop 包的 optionalDependency，**懒加载**；加载失败（缺预编译、Linux 无 X11/Wayland 下）→ 错误码 `NATIVE_UNAVAILABLE`，不影响应用启动。

## IPC 协议

服务进程 → 主进程：`{ "type": "lulux:computer-cmd", "id": "<uuid>", "cmd": { "action": "click", "x": 640, "y": 360 } }`

主进程 → 服务进程：`{ "type": "lulux:computer-result", "id": "<uuid>", "ok": true, "result": { } }` 或 `ok:false, error: { code, message }`

另有主进程主动通知（无 id）：`{ "type": "lulux:computer-event", "event": "stop" | "pause", "reason": "hotkey" | "user-moved-mouse" | "overlay" }`。

错误码：`NATIVE_UNAVAILABLE`、`NO_DISPLAY`、`BAD_ARGS`（坐标越界、按键名非法）、`STOPPED`（急停后，直到服务端重新 `begin`）、`USER_INTERRUPT`（检测到用户动了鼠标，自动暂停）、`PERMISSION`（macOS 未授权屏幕录制/辅助功能）、`TIMEOUT`、`FAILED`。

### 坐标系

**模型只用截图像素坐标。** 每次 `screenshot` 返回 `{ image, width, height, displayId, scale }`，截图宽度最多 1280（等比缩放）。之后的 `click/move/drag/scroll` 坐标都相对**最近一次截图的那块显示器、那张图**，主进程负责换算：

```
dipX = display.bounds.x + x * display.bounds.width  / imageWidth
dipY = display.bounds.y + y * display.bounds.height / imageHeight
robotjs 坐标：win32 → screen.dipToScreenPoint({x,y})（物理像素）；darwin → DIP（CoreGraphics 用 point）；linux → dip * scaleFactor（X11 物理像素）
```

没有截过图就操作 → `BAD_ARGS`（"请先 computer_screenshot"）。坐标越出图片范围 → `BAD_ARGS`。

### 动作（cmd.action）

| action | 参数 | result |
| --- | --- | --- |
| `status` | — | `{ native: boolean, permission: { screen, accessibility }（darwin，其余 'granted'）, displays: [{ id, primary, bounds, scaleFactor }], stopped: boolean }` |
| `begin` | `sessionId` | 清除 stopped，显示边框提示窗，注册急停快捷键。`{}` |
| `end` | — | 隐藏边框提示窗、注销快捷键。`{}` |
| `screenshot` | `displayId?`（默认主屏，或上次用的屏） | `{ image: 'data:image/jpeg;base64,…'（质量 70）, width, height, displayId, scale }` |
| `click` | `x, y, button?: 'left'\|'right'\|'middle', double?: boolean` | `{ x, y }` |
| `move` | `x, y` | `{ x, y }` |
| `drag` | `x, y, toX, toY` | `{}` |
| `scroll` | `x, y, dx?, dy?`（滚轮格数，正=向下/向右，各最多 ±30；主进程换成 robotjs 约定：方向取反，win32 一格=120、macOS 一格=40px、X11 一格=一次按键） | `{}` |
| `type` | `text`（最多 2000 字；非 ASCII 走剪贴板粘贴并恢复原剪贴板） | `{}` |
| `key` | `keys`：如 `"enter"`、`"ctrl+c"`、`"cmd+shift+t"`（`mod` = mac 上 cmd、其他 ctrl） | `{}` |
| `cursor` | — | `{ x, y }`（截图坐标；不在该屏上时为 null） |

### 安全（主进程侧）

- **急停快捷键 `Ctrl+Alt+Shift+K`**（mac 为 `Cmd+Option+Shift+K`）：`begin` 时注册、`end` 时注销。按下 → stopped=true、发 `computer-event stop`；之后所有动作返回 `STOPPED`。（不用 Esc 组合：mac 的 Cmd+Option+Esc 是强制退出，Win 的 Ctrl+Shift+Esc 是任务管理器。）
- **用户一动鼠标就暂停**：每次动作后记下光标位置；下次动作前若光标离开记录点超过 8 像素 → 返回 `USER_INTERRUPT`，发 `computer-event pause`（服务端转成“用户接管”，等待恢复）。
- **边框提示窗**：每块显示器四条 4px 实色橙边 + 顶部居中实色小条（都是不透明小窗口：Linux 无合成器时整屏透明窗会黑屏），置顶、`setIgnoreMouseEvents(true)`、`setContentProtection(true)`（Win/mac 不进截图），小条文字“LULUX 正在操作电脑 · Ctrl+Alt+Shift+K 停止”（mac 为 ⌘⌥⇧K）。小条只做提示，不接收点击（窗口整体点击穿透）；停止用急停快捷键或应用内状态条。
- macOS：`status` 用 `systemPreferences.getMediaAccessStatus('screen')` 与 `isTrustedAccessibilityClient(false)` 报告权限；缺权限时动作返回 `PERMISSION`，渲染进程引导打开系统设置（`x-apple.systempreferences:` 链接）。
- 每次动作向渲染进程发 `computer:agent-activity { action, x?, y? }`。

## 服务端（工具层）

- 工具：`computer_screenshot`、`computer_click`、`computer_move`、`computer_drag`、`computer_scroll`、`computer_type`、`computer_key`、`computer_cursor`；group `computer`。
- 出现条件（`available()`）：设置 `computerUse === '1'` 且 IPC 通道可用；**且**本会话已开启（`computerSession.enabled(sessionId)`）——未开启时工具调用返回“用户尚未在本会话开启电脑操作”，不弹卡。模型不支持看图时编排层不提供这组工具。
- risk：screenshot/cursor 为 read（但也需本会话已开启）；其余全部 write，且 **`approval: 'always'`**：即使“完全权限”也逐步审批，审批卡（approvalKind `computer-action`）显示动作、坐标、带红点标注的截图缩略图；可选“本会话始终允许此类动作”（rememberKey = `computer:<action>`）。
- 截图进模型：工具结果文字为 `已截图 1280×800（显示器 1）。坐标以这张图为准。`，图片通过 `ToolContext.attachImage` 交给编排层，在本轮全部工具结果之后追加一条 user 轮 `images:[…]`（OpenAI 的 tool 消息不能带图，Anthropic 也兼容这种写法）。同一回复内只保留**最近 2 张**截图的 data，更早的替换为“（较早的截图已省略）”。截图同时作为工作区文件 `computer/shot-<时间>.jpg` 发给用户（不进历史正文）。
- 停止 / 接管：复用 browser-use 的会话控制（`control.ts`）语义：主进程 `stop` 事件 → 本次运行内后续 computer 工具返回已停止；`pause` → 等待用户在状态条点“继续”（最长 30 分钟）。
- 设置：`computerUse`（'0' 默认关 / '1' 开）、`computerMaxSteps`（默认 30，单次运行内）。

## 已知限制（v0.1.2）

- 没有应用白名单 / 敏感窗口自动识别（需要额外的窗口枚举原生库）；靠逐步审批 + 急停 + 用户动鼠标即暂停兜底。
- 未接 Anthropic / OpenAI 原生 computer-use 协议；所有视觉模型统一用“截图 + 像素坐标”通用工具。
- Linux Wayland 下 robotjs 无法注入输入 → `NATIVE_UNAVAILABLE`。
