# LULUX ETA 安装说明（桌面版）

> 适用版本：v0.1.x / v0.2.x 预览版。团队服务器（Docker）部署见 [deploy-server.md](./deploy-server.md)。

## 下载哪个文件

| 系统 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10 / 11（64 位） | `LULUX-ETA-<版本>-win-x64-setup.exe` | 安装向导，可选安装目录，自动建桌面与开始菜单快捷方式 |
| Linux x86-64 | `LULUX-ETA-<版本>-linux-x86_64.AppImage` | 单文件，免安装 |
| Linux ARM64 | `LULUX-ETA-<版本>-linux-arm64.AppImage` | 单文件，免安装（树莓派 5、ARM 服务器桌面等） |
| macOS Apple 芯片（M1 / M2 / M3 / M4） | `LULUX-ETA-<版本>-mac-arm64.dmg` | 打开后把 LULUX ETA 拖进“应用程序”；未签名，首次打开见下文 |
| macOS Intel | `LULUX-ETA-<版本>-mac-x64.dmg` | 同上。不确定是哪种：左上角苹果菜单 → 关于本机，“芯片”写 Apple 的选 arm64，“处理器”写 Intel 的选 x64 |

下载后可以核对校验和（同目录的 `SHA256SUMS.txt`）：

```bash
sha256sum -c SHA256SUMS.txt          # Linux
shasum -a 256 LULUX-ETA-*.dmg        # macOS
```
```powershell
Get-FileHash .\LULUX-ETA-0.1.2-win-x64-setup.exe -Algorithm SHA256   # Windows PowerShell
```

**不需要另外安装 Node.js、npm 或数据库。** 安装包自带运行时：本地服务、内置 SQLite（`node:sqlite`）以及安装第三方内核（Claude Code / Codex / Gemini CLI / Qwen Code）所需的 npm 都随包附带，由程序自己的 Electron 运行时执行。

## 关于“未签名”

预览版安装包**没有代码签名**（Windows 没有 Authenticode 证书，macOS 没有 Apple Developer ID 公证）。这不影响功能，但系统会在第一次打开时提示风险。请只从项目的官方发布页下载，并核对上面的 SHA256。

### Windows：SmartScreen “Windows 已保护你的电脑”

1. 双击 `LULUX-ETA-…-setup.exe`，出现蓝色窗口“Windows 已保护你的电脑”。
2. 点击窗口里的 **“更多信息”**（More info）。
3. 出现发布者“未知发布者”和应用名后，点击 **“仍要运行”**（Run anyway）。
4. 按向导选择“仅为我安装”或“为所有用户安装”（后者需要管理员权限）、选择安装目录，完成后桌面会出现 **LULUX ETA** 快捷方式。

如果浏览器（Edge / Chrome）下载时提示“不常下载”，在下载列表里选择 **保留 → 仍然保留**。
企业电脑如被组策略禁止运行未签名程序，需要管理员放行。

### macOS：“无法打开，因为无法验证开发者” / “已损坏”

- **macOS 14 及更早**：在“应用程序”里 **右键（或按住 Control 点按）LULUX ETA → 打开 → 打开**。只需要做一次。
- **macOS 15（Sequoia）及更新**：先双击一次（会被拦截），然后打开 **系统设置 → 隐私与安全性**，在页面下方找到“已阻止使用 LULUX ETA”，点 **仍要打开**，输入密码确认。
- 如果提示 **“LULUX ETA 已损坏，无法打开。你应该将它移到废纸篓”**（下载的未签名 Apple 芯片程序常见），在“终端”执行一次后再打开：
  ```bash
  xattr -dr com.apple.quarantine "/Applications/LULUX ETA.app"
  ```

### Linux：AppImage

```bash
chmod +x LULUX-ETA-*-linux-*.AppImage
./LULUX-ETA-*-linux-*.AppImage
```

- 需要 FUSE 2：Ubuntu 22.04 `sudo apt install libfuse2`，Ubuntu 24.04 / Debian 13 `sudo apt install libfuse2t64`。不想装可以用 `./LULUX-ETA-….AppImage --appimage-extract-and-run`。
- Ubuntu 24.04 起 AppArmor 限制非特权用户命名空间，若启动报 `The SUID sandbox helper binary was found, but is not configured correctly` 或直接闪退，可临时加 `--no-sandbox` 启动，或为该 AppImage 配置 AppArmor 规则（推荐）。
- **ARM64 版**的 AppImage 启动器需要 `libz.so`：若报 `error while loading shared libraries: libz.so`，执行 `sudo apt install zlib1g-dev`（或 `sudo ln -s /usr/lib/aarch64-linux-gnu/libz.so.1 /usr/lib/aarch64-linux-gnu/libz.so`）。
- 想在应用菜单里出现图标，可用 [Gear Lever](https://github.com/mijorus/gearlever) 或 AppImageLauncher 集成。

## 自动更新

安装后应用会自动检查 GitHub Releases 上的新版本（启动 30 秒后一次、之后每 6 小时一次，可在 设置 → 关于与更新 关闭或切换正式版 / 测试版）：

- **Windows 安装版、Linux AppImage**：新版本在后台下载并校验，完成后提示“重启并安装”；不点也没关系，下次退出应用时自动安装。数据目录不受影响。
- **macOS（当前未签名）**：只能提示有新版本并打开下载页，需要手动下载新的 dmg 覆盖安装（首次打开同样按上文操作一次）。
- Linux 请把 AppImage 放在自己有写权限的目录（如 `~/Applications`），否则无法替换。
- 公司网络访问 GitHub 慢时，管理员可以搭镜像并设置环境变量 `LULUX_UPDATE_URL`。详见 [AUTO-UPDATE.md](./AUTO-UPDATE.md)。
- 更新日志：Windows `%APPDATA%\LULUX ETA\logs\updater.log`，macOS `~/Library/Logs/LULUX ETA/updater.log`，Linux `~/.config/LULUX ETA/logs/updater.log`。

## 数据保存在哪里

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%APPDATA%\LULUX ETA\data`（例如 `C:\Users\你的用户名\AppData\Roaming\LULUX ETA\data`） |
| macOS | `~/Library/Application Support/LULUX ETA/data` |
| Linux | `~/.config/LULUX ETA/data` |

- 里面有数据库 `lulux-eta.db*`、加密主密钥（`master.key.safe`：由系统钥匙串 / DPAPI 保护；Linux 没有钥匙串时为 `master.key`）、自动备份、邮件附件缓存，以及第三方内核目录 `kernels/`。
- 想把数据放到别的盘：设置环境变量 `LULUX_ETA_HOME` 指向新目录后再启动（Windows：系统属性 → 环境变量）。
- **迁移 / 备份**：退出程序后整体复制数据目录即可。目录里有加密后的 API Key 和邮箱凭据；换电脑后如果主密钥无法解密，界面会提示重新填写 Key。不要把数据目录发给别人。

## 第三方内核（可选）

在“设置 → 内核”里一键安装，程序用自带的 npm 安装到数据目录的 `kernels/<内核>/`，不会改动系统全局环境。

- 默认安装源是 `https://registry.npmmirror.com`（国内快）；失败时自动改用 `https://registry.npmjs.org`。
- 公司内网有私有源时，可在设置项 `kernelRegistry` 填写自己的地址（留空恢复默认），或启动前设置环境变量 `LULUX_KERNEL_REGISTRY`。需要代理时设置 `LULUX_KERNEL_PROXY`。

## 卸载

### Windows
**设置 → 应用 → 已安装的应用 → LULUX ETA → 卸载**（或开始菜单里的“卸载 LULUX ETA”）。
卸载**不会删除数据目录**，避免误删客户资料；确定不再需要时手动删除 `%APPDATA%\LULUX ETA`。

### macOS
退出程序，把“应用程序”里的 LULUX ETA 拖到废纸篓；需要清除数据时删除 `~/Library/Application Support/LULUX ETA`。

### Linux
删除 AppImage 文件；需要清除数据时删除 `~/.config/LULUX ETA`（如果用过 Gear Lever / AppImageLauncher，也从中移除）。

## 常见问题

- **启动后提示“本地服务启动失败”**：多半是数据目录没有写权限或磁盘已满；把提示里的错误信息附在反馈中。
- **安全软件误报**：未签名的 Electron 程序偶尔会被启发式引擎误报，可提交样本给厂商并核对 SHA256。
- **离线使用**：除模型调用、联网搜索、邮件收发、内核安装需要网络外，其余功能离线可用。
