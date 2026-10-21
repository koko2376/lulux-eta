# LULUX ETA 自动更新（GitHub Releases）

> 适用：桌面端 `packages/desktop`（Electron 44.9.1 + electron-updater 6.x）。发布流程见 `.github/workflows/release.yml`，本地打包见 `scripts/build-release.sh`。
> 作者：koko（kokozenshii0308@gmail.com）。仓库：`koko2376/lulux-eta`（见第 1 节）。

## 1. 更新源（只在一处配置）

更新源**只在一处配置**：`packages/desktop/electron-builder.yml` 顶部的 `publish` 段。

```yaml
publish:
  provider: github
  owner: koko2376
  repo: lulux-eta
  releaseType: release
```

- 打包时据此生成 `<resources>/app-update.yml` 与 `latest*.yml`（Windows NSIS → `latest.yml`）。`releaseType: release`：客户端只检测已发布（非 draft）的 Release。
- 仓库地址也出现在 `CHANGELOG.md`、`docs/release/*`、`.github/ISSUE_TEMPLATE/config.yml`、`.github/CODEOWNERS`、`packages/desktop/package.json` 的 `homepage`、关于页（`packages/client/src/lib/about.ts`）；换仓库时一并修改。
- 若构建时 owner 被改回占位 `OWNER`，应用视为**“未配置更新源”**：状态 `disabled`、`limitation: 'unconfigured'`，不会发出任何网络请求。
- **不改文件也能出正确的包**：
  - GitHub Actions 发布工作流默认把**当前仓库**（`github.repository`）写进安装包，也可以在仓库 Settings → Variables 里设 `LULUX_UPDATE_REPO=owner/lulux-eta` 覆盖。
  - 本地打包：`LULUX_UPDATE_REPO=owner/lulux-eta scripts/build-release.sh`（传给 electron-builder 的 `-c.publish.owner/-c.publish.repo`）。`BUILDINFO.txt` 的 `update source:` 行会写明本次写入的源；仍是占位时会注明 “auto-update disabled in this build”。
- **运行时覆盖**（优先级从高到低）：
  1. 环境变量 `LULUX_UPDATE_URL=https://mirror.example.com/lulux/` — generic 源：目录里放与 GitHub Release 相同的 `latest*.yml` 和安装包。也是本地冒烟测试用的方式。可配 `LULUX_UPDATE_PAGE` 作为“前往下载页”的地址。
  2. **设置 → 关于 → “更新源地址”**（保存在 `<userData>/updater.json` 的 `feedUrl`）— 同样是 generic 源，适合公司镜像、国内 CDN、内网分发；用户或 IT 在界面里填一次即可，不需要改安装包。填了它就**替代** GitHub 源（主进程调用 `autoUpdater.setFeedURL({ provider: 'generic', url })`），清空即恢复默认。未配置 GitHub 源的安装包也能通过它检查更新。搭建方法见第 8 节。
  3. 环境变量 `LULUX_UPDATE_REPO=owner/repo` — 换一个 GitHub 仓库。
  4. 安装包内 `<resources>/app-update.yml`（打包时由上面的 `publish` 段生成）。

GitHub provider 读取的是 `https://github.com/<owner>/<repo>/releases.atom` 与 Release 附件（公开仓库无需 token、不占 API 限额）。**私有仓库不支持**（需要在客户端放 token，不要这样做）。

## 2. 发布物

每个 tag 由 Release 工作流在三种 runner 上构建，上传到 **draft** Release：

| 平台 | 安装包 | 更新元数据 | 差分数据 |
| --- | --- | --- | --- |
| Windows x64 | `LULUX-ETA-<v>-win-x64-setup.exe`（NSIS） | `latest.yml` | `…-setup.exe.blockmap` |
| macOS Apple 芯片 | `LULUX-ETA-<v>-mac-arm64.dmg` / `.zip` | `latest-mac.yml`（arm64 与 x64 两个 zip 在同一个文件里） | `….dmg.blockmap` / `….zip.blockmap` |
| macOS Intel | `LULUX-ETA-<v>-mac-x64.dmg` / `.zip` | 同上 | 同上 |
| Linux x64 | `LULUX-ETA-<v>-linux-x86_64.AppImage` | `latest-linux.yml` | 内嵌在 AppImage 末尾（yml 里的 `blockMapSize`） |
| Linux arm64 | `LULUX-ETA-<v>-linux-arm64.AppImage` | `latest-linux-arm64.yml` | 同上 |

另附 `SHA256SUMS.txt`（全部附件）。macOS 两种架构在**同一个** macOS job 里构建，这样 electron-builder 写出一个同时包含两个 zip 的 `latest-mac.yml`；分成两个 job 会各写一个同名文件互相覆盖。

**发布步骤**

1. 统一改版本号（根与各包 `package.json`）。**更新比较的是 `latest*.yml` 里的 `version`**，它来自 `packages/desktop/package.json`；工作流会在版本与 tag 不一致时告警。
2. 写 `docs/release/release-notes-v<版本>.md`（没有时工作流生成一段占位说明）。
3. 打 tag 推送：正式版 `v0.1.1`；测试版 `v0.1.2-beta.1`（tag 带 `-` 的自动标为 prerelease）。
4. 工作流完成后在 GitHub 上检查 draft（附件齐全、说明无误），点 **Publish release**。**draft 对用户不可见，发布之后客户端才会检测到。**
5. 已发布的 Release 不要删除旧版本的附件：Windows 差分下载需要旧版本的 `.blockmap`。

## 3. 客户端行为（主进程 `packages/desktop/src/updater.ts`）

- 启动 30 秒后检查一次，之后每 6 小时一次（“自动检查”关闭时不定时检查，手动检查仍可用）。
- 发现新版本：“自动下载”开启且平台支持时后台下载；否则状态停在 `available` 等用户点“下载”。
- 下载完成并通过 **sha512 校验**（electron-updater 用 `latest*.yml` 里的 `sha512` 校验整个文件，差分下载也校验最终文件）后状态为 `downloaded`，界面显示“重启并安装”。**不强制重启**；用户不点时，下次正常退出应用时安装（`autoInstallOnAppQuit`）。
- “重启并安装”：主进程先停止本地服务（释放 SQLite 与端口）、释放单实例锁，再 `quitAndInstall(isSilent=true, isForceRunAfter=true)`：Windows 静默运行 NSIS 升级后重新打开；Linux 用新 AppImage 替换旧文件后启动新文件。
- **失败不打扰**：后台检查/下载失败只写日志，状态回到 `idle`/`available`，`lastError` 记录原因（`interactive: false`）；只有用户手动操作失败时状态才是 `error`。
- **失败原因归类**：`lastError.kind` 为 `network`（DNS / 连接 / 超时 / 证书）、`not-found`（源里没有 `latest*.yml`）、`forbidden`（401/403、频率限制）、`bad-feed`（yml 无法解析、sha512 校验失败）或 `other`。界面按类别给出可操作的说明（例如网络错误提示检查代理或改用镜像；自定义源 404 提示地址要指向放 yml 的目录），原始错误信息以灰字附在下面。
- 界面没有订阅 `onState` 时（旧版界面），主进程用原生对话框兜底：下载完成提示“重启并安装 / 稍后”；不能自动安装的平台提示“前往下载页 / 跳过此版本 / 稍后”。每个版本每次运行最多一次。界面订阅后不再弹原生框。
- 日志：`<userData>/logs/updater.log`（1 MB 轮转一份 `.1`）。Windows `%APPDATA%\LULUX ETA\logs\`，macOS `~/Library/Logs/LULUX ETA/`，Linux `~/.config/LULUX ETA/logs/`。
- 设置保存在 `<userData>/updater.json`：`{ autoCheck: true, autoDownload: true, channel: 'stable'|'beta', skippedVersion: null }`。当前版本本身是预发布版（版本号带 `-`）时默认通道为 `beta`。

### 3.1 通道（stable / beta）

| 通道 | electron-updater | 能收到 |
| --- | --- | --- |
| `stable` | `allowPrerelease = false`，读 `releases/latest` | 只有正式 Release（GitHub 的 “Latest” 永远不是 prerelease） |
| `beta` | `allowPrerelease = true`，读 releases.atom 第一条 | 最新的 Release，无论是否 prerelease |

- 两个通道都用同一套 `latest*.yml`（GitHub provider 只生成 `latest` 通道文件，是否测试版由 Release 的 prerelease 标记区分）。
- 不允许降级：从 beta 切回 stable 后，要等正式版版本号超过当前测试版才会更新。
- 切换通道后，之前查到但未下载的结果作废；已下载的更新仍可安装。

### 3.2 平台支持

| 平台 / 运行方式 | 检查 | 应用内下载与安装 | 说明 |
| --- | --- | --- | --- |
| Windows NSIS 安装版 | ✅ | ✅ | 见 3.3 |
| Windows 免安装版（portable） | ✅ | ❌ → 下载页 | `limitation: 'portable'`；正式发布不再附带 portable |
| Linux AppImage | ✅ | ✅ | 新文件按新版本名放在旧文件同目录，旧文件删除；文件名不含版本号时原地覆盖。AppImage 所在目录需可写 |
| Linux 解包运行 / 其他打包 | ✅ | ❌ → 下载页 | `limitation: 'not-appimage'` |
| macOS 未签名（当前） | ✅ | ❌ → 下载页 | `limitation: 'mac-unsigned'`，见 3.4 |
| macOS Developer ID 签名 + 公证 | ✅ | ✅ | 运行时用 `codesign -dv` 检测到 `Authority=Developer ID Application` 后自动启用 |
| 开发模式（未打包） | ❌ | ❌ | `limitation: 'dev'`；设 `LULUX_UPDATE_URL` 可强制启用（测试用） |

### 3.3 Windows：未签名包、差分更新与 SmartScreen

- **签名校验**：electron-updater 只在 `app-update.yml` 里有 `publisherName` 时校验新安装包的 Authenticode 签名。未签名构建没有 `publisherName`，因此**未签名 → 未签名**、**未签名 → 已签名**都能更新。
  一旦开始签名（`WIN_CSC_LINK` 生效，electron-builder 会把证书主体写进 `publisherName`），之后每个版本都必须用同一发布者签名，否则已签名的旧版本会拒绝安装（`ERR_UPDATER_INVALID_SIGNATURE`）。换证书时在 `electron-builder.yml` 的 `win.publisherName` 同时列出新旧主体。
- **差分更新**：NSIS 安装时会在 `%LOCALAPPDATA%\@luluxdesktop-updater\` 缓存一份安装包；更新时下载新旧两个 `.blockmap`，只按块下载变化的部分（HTTP Range），拼好后用 sha512 校验完整文件；任何一步失败自动退回全量下载。前提是旧版本的 `.blockmap` 仍在旧 Release 的附件里、命名不变。签名与否不影响差分。
- **SmartScreen**：SmartScreen 主要拦截带“来自互联网”标记（Mark-of-the-Web）的文件。用户**第一次**从浏览器下载安装时仍会看到“Windows 已保护你的电脑”（绕过方法见 [INSTALL.md](./INSTALL.md)）；应用内更新由 electron-updater 直接下载，文件不带该标记，静默升级通常不再弹 SmartScreen。杀毒软件仍可能扫描或拦截未签名安装包。签名（尤其 EV 或 Azure Trusted Signing）后信誉积累才会消除首次提示。
- **UAC**：“仅为我安装”（默认）升级不需要管理员权限；“为所有用户安装”到 Program Files 的，升级时会弹 UAC。

### 3.4 macOS 未签名时的降级

Squirrel.Mac 只接受与当前应用同一 Developer ID 签名的更新包，未签名（或 ad-hoc 签名）构建无法在应用内替换。此时：

- 仍按计划检查 GitHub（`latest-mac.yml`），发现新版本时 `state.canAutoInstall = false`、`state.downloadPage` 指向该版本的 Release 页；
- 界面把“下载”按钮换成“前往下载页”（调用 `download()` 即会用系统浏览器打开下载页）；
- 用户下载新的 dmg，拖进“应用程序”覆盖旧版本即可，数据目录不受影响；首次打开同样需要按 [INSTALL.md](./INSTALL.md) 绕过 Gatekeeper（右键 → 打开 / 隐私与安全性 → 仍要打开 / `xattr -dr com.apple.quarantine`）。

签名与公证就绪后（在仓库 Secrets 配 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，见 `.github/workflows/release.yml`），无需改代码：新版本运行时检测到 Developer ID 签名即启用应用内更新。**过渡**：已安装的未签名旧版本仍只能手动下载一次签名版，之后才能自动更新。

## 4. preload 接口 `window.lulux.updater`（与 `window.luluxAgent.updater` 相同）

```ts
type UpdateChannel = 'stable' | 'beta'
type UpdaterStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
type UpdaterLimitation = 'dev' | 'unconfigured' | 'mac-unsigned' | 'portable' | 'not-appimage' | 'unsupported-platform'

interface UpdaterState {
  status: UpdaterStatus
  currentVersion: string               // app.getVersion()
  platform: 'win32' | 'darwin' | 'linux' | string
  arch: string
  canCheck: boolean                    // false：隐藏“检查更新”或置灰，显示原因
  canAutoInstall: boolean              // false：“下载”按钮改为“前往下载页”
  limitation: UpdaterLimitation | null
  channel: UpdateChannel
  source: { provider: 'github'; repo: string } | { provider: 'generic'; url: string; custom?: boolean } | null   // custom：来自“更新源地址”设置
  downloadPage: string | null          // Release 页（有新版本时指向该版本 tag）
  available: {
    version: string
    releaseName: string | null
    releaseDate: string | null         // ISO
    notes: string                      // 纯文本发布说明（主进程已去掉 HTML）；按纯文本渲染，不要 v-html
    prerelease: boolean
  } | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  lastCheckedAt: string | null         // ISO
  lastError: { message: string; at: string; interactive: boolean; kind: 'network' | 'not-found' | 'forbidden' | 'bad-feed' | 'other' } | null
}

interface UpdaterSettings {
  autoCheck: boolean
  autoDownload: boolean
  channel: UpdateChannel
  skippedVersion: string | null
  feedUrl: string | null   // 自定义 generic 更新源；只收 http(s)，不能带用户名密码，末尾自动补 /；null / '' 表示默认源
}

window.lulux.updater = {
  check(): Promise<UpdaterState>       // 手动检查；返回检查结束后的状态（检查中/下载中/已下载时直接返回当前状态）
  download(): Promise<UpdaterState>    // 开始下载；canAutoInstall=false 时打开 downloadPage
  install(): Promise<boolean>          // 仅 status='downloaded' 时有效：停止本地服务并重启安装（应用随即退出）
  getState(): Promise<UpdaterState>
  onState(listener: (state: UpdaterState) => void): () => void   // 订阅后主进程不再弹原生提示；返回取消订阅
  getSettings(): Promise<UpdaterSettings>
  setSettings(patch: Partial<UpdaterSettings>): Promise<UpdaterSettings>   // 未知键或类型错误会 reject
}
```

所有 `updater:*` IPC 只接受**主窗口里本应用页面**（与连接类 IPC 同一校验 `fromAppPage`）；内置浏览器标签页、其他 origin 调用会被拒绝。浏览器（非桌面）环境没有 `window.lulux`，界面应隐藏整块更新 UI。

## 5. 客户端需要的“关于 / 更新” UI（`packages/client` 配合点）

放在 设置 → 关于（或“关于与更新”）：

1. **版本信息**：`LULUX ETA v{currentVersion}`，下方小字 Electron / Chrome / Node 版本（`window.luluxAgent.versions`）、平台与架构、更新源（`source.repo` 或镜像 URL）。
2. **检查更新按钮**：调用 `check()`；`checking` 时转圈并禁用；`canCheck=false` 时置灰并按 `limitation` 显示原因：
   - `unconfigured`：“此版本未配置更新源”；`dev`：“开发模式不检查更新”。
   - 显示“上次检查：{lastCheckedAt 相对时间}”。
3. **状态区**（按 `status`）：
   - `not-available`：“已是最新版本”。
   - `available`：“发现新版本 v{version}”＋发布日期＋“下载”按钮（`canAutoInstall=false` 时为“前往下载页”，并附一句原因：`mac-unsigned` → “当前 macOS 版本未签名，无法自动更新”，`portable` → “免安装版请手动下载”，`not-appimage` → “请下载新的 AppImage”）。
   - `downloading`：进度条 `progress.percent`、`transferred/total`（MB）与速度（`bytesPerSecond`）。
   - `downloaded`：主按钮“重启并安装”（`install()`），次按钮“稍后”（只关闭提示；退出应用时会自动安装，文案写明）。
   - `error`（仅手动操作）：显示 `lastError.message`＋“重试”。后台失败（`lastError.interactive=false`）不弹提示，最多在关于页灰字显示。
4. **发布说明**：`available.notes` 纯文本（保留换行，可折叠），链接“在 GitHub 查看”打开 `downloadPage`（`window.luluxAgent.browser.openExternal`）。
5. **设置开关**：自动检查更新（`autoCheck`）、自动下载更新（`autoDownload`，`canAutoInstall=false` 时置灰并注明）、更新通道（单选：正式版 stable / 测试版 beta，beta 旁注“可能不稳定”）。用 `getSettings()` 初始化，修改即 `setSettings({ … })`。
6. **全局提示**：`status` 变为 `downloaded` 时在侧栏底部或顶部显示一个不打断的小条/徽标“新版本已就绪 · 重启并安装”，可关闭；不要模态弹窗。
7. 页面挂载时 `onState` 订阅、卸载时取消；全局提示组件也订阅一份（订阅存在即表示界面接管提示）。

## 6. 本地冒烟测试

`scripts/update-smoke/smoke-update-appimage.sh <旧.AppImage> <新版本目录>`：

1. `serve-updates.mjs` 在 127.0.0.1 起一个支持 Range / multipart byteranges 的静态服务，模拟 GitHub Release 附件；
2. Xvfb 里以 `LULUX_UPDATE_URL=<本地源>` 启动旧版本（独立的 `XDG_CONFIG_HOME` 与数据目录）；
3. 经 Chrome DevTools Protocol 在页面里调用 `window.lulux.updater.*`（走真实 preload + IPC 校验）：读取设置、验证非法设置被拒绝、订阅 `onState`、等待 `downloaded`；
4. 调 `install()`，确认旧进程退出、旧文件被新版本 AppImage 替换且 sha256 与发布源一致、新版本自动启动（`updater.log` 记录 `init version=<新版本>`）。

造一个“新版本”不必改仓库版本号：

```bash
scripts/build-release.sh --targets linux --linux-archs arm64 --out /tmp/v0.1.1          # 旧版本
cd packages/desktop && npx electron-builder --config electron-builder.yml --publish never \
  --linux AppImage --arm64 -c.extraMetadata.version=0.1.2 -c.directories.output=/tmp/v0.1.2   # 新版本
scripts/update-smoke/smoke-update-appimage.sh /tmp/v0.1.1/LULUX-ETA-0.1.1-linux-arm64.AppImage /tmp/v0.1.2
```

开发模式也可以用 `packages/desktop/dev-app-update.yml`（`provider: generic` + `url:`）配合 `LULUX_UPDATE_URL` 调试（未打包时 AppImage 安装步骤不可用）。

## 7. 常见问题

- **“Unable to find latest version on GitHub … please ensure a production release exists”**：stable 通道下仓库没有已发布（非 draft、非 prerelease）的 Release。发布 draft 或切到 beta。
- **“Cannot find latest-linux-arm64.yml in the latest release artifacts”**：该 Release 缺少对应平台的元数据（例如手工上传时漏了），补传附件即可。
- **国内下载 GitHub 慢**：配置镜像目录 + `LULUX_UPDATE_URL`；镜像目录结构与 Release 附件一致（`latest*.yml` 与安装包同目录）。
- **Linux AppImage 目录不可写**（如放在 `/opt` 由 root 拥有）：安装步骤会失败并记日志；把 AppImage 放到用户目录（如 `~/Applications`）。

## 8. 自建更新源（公司镜像 / 国内 CDN / 内网）

electron-updater 的 generic provider 只需要一个能用 HTTP(S) 访问的静态目录，任何 Web 服务器或对象存储（Nginx、IIS、阿里云 OSS、腾讯云 COS、七牛等）都可以。

**目录内容**：与 GitHub Release 附件相同，放在同一个目录（不要分子目录）：

```
https://mirror.example.com/lulux/
├── latest.yml                              # Windows
├── LULUX-ETA-0.1.2-win-x64-setup.exe
├── LULUX-ETA-0.1.2-win-x64-setup.exe.blockmap
├── latest-mac.yml                          # macOS（arm64 与 x64 在同一个文件）
├── LULUX-ETA-0.1.2-mac-arm64.zip
├── LULUX-ETA-0.1.2-mac-x64.zip
├── latest-linux.yml                        # Linux x64
├── LULUX-ETA-0.1.2-linux-x86_64.AppImage
├── latest-linux-arm64.yml                  # Linux arm64
└── LULUX-ETA-0.1.2-linux-arm64.AppImage
```

- `latest*.yml` 由打包生成（`--publish never` 也会生成，在 `packages/desktop/release/` 里），**原样上传，不要改文件名**：yml 里的 `path` / `url` 是相对文件名，客户端会拼在源地址后面下载，并用其中的 `sha512` 校验。
- 测试版通道（beta）读取 `beta.yml` / `beta-mac.yml` / `beta-linux.yml`；electron-builder 为带 `-beta.N` 的版本生成这些文件，一并上传即可。只发正式版时不需要。
- 保留上一版本的 `.blockmap`，Windows 才能做差分下载；没有时自动退回整包下载。
- 发布顺序：**先上传安装包，最后上传/覆盖 `latest*.yml`**，避免客户端读到新 yml 时安装包还没传完。

**服务器设置**

- 支持 HTTP Range 请求（Nginx、主流对象存储默认支持），差分下载与断点续传依赖它。
- `latest*.yml` 不要被长期缓存：CDN 上给 `*.yml` 设 `Cache-Control: no-cache`（或很短的 TTL），否则客户端会一直看到旧版本；安装包可以长缓存（文件名带版本号）。
- 内容类型：`.yml` 用 `text/yaml` 或 `text/plain`，安装包 `application/octet-stream`。
- 优先用 HTTPS。内网 HTTP 也能用（安装包有 sha512 校验，但不防中间人替换 yml）。
- 目录不需要列表权限；不支持鉴权（客户端不会带用户名密码或 token），需要限制访问时用内网或 IP 白名单。

Nginx 示例：

```nginx
location /lulux/ {
    alias /srv/lulux-updates/;
    location ~* \.yml$ { add_header Cache-Control "no-cache"; }
}
```

**客户端配置**：设置 → 关于 → 软件更新 → “更新源地址”，填 `https://mirror.example.com/lulux/` 保存。保存后立即切换（之前查到的结果作废），之后的自动 / 手动检查都走这个源；清空即恢复 GitHub。批量部署时也可以给用户环境设置 `LULUX_UPDATE_URL`（优先级更高）。

**验证**：浏览器打开 `https://mirror.example.com/lulux/latest.yml` 能看到 `version:` 与 `files:`；再在关于页点“检查更新”。连不上时界面提示检查地址或 VPN；提示“没有找到 latest.yml”时，通常是地址没有指向放 yml 的那一层目录。
