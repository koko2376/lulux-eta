# WhatsApp 运行时引擎安装

> 范围：`/whatsapp/channels` 的关联设备（Linked Devices）握手需要协议引擎 **Baileys** 与本机二维码渲染库 **qrcode**。
> 这两个包**不随应用发布、不在任何 `package.json` 的依赖或可选依赖里**，也不进桌面端 bundle；由使用者在自己的机器上安装，服务端运行时动态加载。
> 接口、状态机与错误码见 `docs/API-CONTRACT.md` 第 12 节。整台服务只关联一个 WhatsApp 账号；出口代理在「WhatsApp → 渠道」页设置。

## 1. 为什么是运行时安装

- Baileys 通过逆向 WhatsApp Web 协议工作，版本与 WhatsApp 服务端强相关，必须能独立升级，不能锁死主程序的依赖树。
- 其依赖链包含 **GPL-3.0** 组件（`libsignal`），与主项目的 BSL 许可不同。把引擎留在仓库之外、由使用者自行安装，可以避免把 GPL 代码打进发行包。
- 引擎缺失或加载失败时，服务端返回明确的 `ENGINE_NOT_INSTALLED` / `ENGINE_LOAD_FAILED`，界面和日志都能看到原因，**不会静默回退**到假数据或旧协议。

## 2. 目录约定

服务端按以下顺序查找（命中即用）：

1. 环境变量 `LULUX_WHATSAPP_ENGINE_DIR` 指向的目录；
2. 数据目录下的 `<dataDir>/whatsapp/engine/` 及其一级子目录；
3. 仓库根目录的 `.eta-engines/whatsapp/`（已加入 `.gitignore`，请勿提交）。

每个候选目录都必须包含：

```
.eta-engines/whatsapp/
├── package.json
└── node_modules/
    ├── baileys/            # 或 @whiskeysockets/baileys
    │   └── package.json
    └── qrcode/
        └── package.json
```

推荐布局（本仓库默认）：

```bash
cd "/path/to/lulux-eta"
mkdir -p .eta-engines/whatsapp
```

## 3. 安装命令

本次验证使用的版本（2026-11-11）：

```bash
cd "/path/to/lulux-eta"
npm install --prefix .eta-engines/whatsapp --no-audit --no-fund --omit=dev \
  baileys@7.0.0-rc14 qrcode@1.5.4
```

实测输出（Node v26.13.0 / npm 11.20.0）：

```
added 99 packages in 7s
```

npm 11 会提示以下两个包带安装脚本、尚未加入 `allowScripts` 白名单：

```
npm warn install-scripts   baileys@7.0.0-rc14 (preinstall: node ./engine-requirements.js)
npm warn install-scripts   protobufjs@7.6.6 (postinstall: node scripts/postinstall)
```

该提示不影响本项目：`engine-requirements.js` 只检查 Node 版本，`protobufjs` 的 postinstall 只生成提示文件；运行时加载的是已安装的 JS 产物。若你的 npm 配置为硬性阻止脚本，安装仍会完成，但请自行确认 Node 版本 ≥ 20（Baileys 7 的要求）。

安装后自检：

```bash
node -e "console.log(require('./.eta-engines/whatsapp/node_modules/baileys/package.json').version)"
node -e "console.log(require('./.eta-engines/whatsapp/node_modules/qrcode/package.json').version)"
```

应分别输出 `7.0.0-rc14` 与 `1.5.4`。服务端 `GET /api/whatsapp/status` 的 `engine.version` 也会显示实际加载到的版本。

### 离线安装

目标机器不能访问 npm registry 时，在联网机器下载 tarball 后拷贝过去：

```bash
# 联网机器
npm pack baileys@7.0.0-rc14 qrcode@1.5.4

# 目标机器（把两个 .tgz 放在同一目录）
mkdir -p .eta-engines/whatsapp
npm install --prefix .eta-engines/whatsapp --no-audit --no-fund --omit=dev \
  ./baileys-7.0.0-rc14.tgz ./qrcode-1.5.4.tgz
```

`npm pack` 会一并解析并下载依赖；如目标机仍缺传递依赖，请在同一联网环境用 `npm ci --omit=dev` 生成完整 `node_modules` 后整体拷贝（保留目录结构）。

## 4. 指定其他位置

```bash
LULUX_WHATSAPP_ENGINE_DIR=/opt/lulux/whatsapp-engine npm run start -w packages/server
```

目录内同样需要 `node_modules/baileys` 与 `node_modules/qrcode`。显式指定后不再搜索其他位置。

## 5. 许可与合规提示

- `baileys` 本体为 MIT；其依赖 `libsignal` 为 **GPL-3.0**（本次安装版本 6.0.0）。两者都只存在于使用者本机的运行时目录，不进入本仓库、不随安装包分发。
- 若你要二次分发包含该引擎的镜像或安装包，请自行评估 GPL-3.0 的源码提供义务与主项目 BSL 的兼容性；本项目不提供法律意见。
- 该引擎属于非官方接入，风险声明见界面与 `README` 的 WhatsApp 章节。项目不内置、不代购、不推荐任何代理、VPN、中转或防封方案；「出口代理」设置只是让你填写自己的线路。

## 6. 常见错误

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `ENGINE_NOT_INSTALLED` | 搜索路径内找不到 `baileys` | 按第 3 节安装；确认启动用户对目录有读权限 |
| `ENGINE_LOAD_FAILED` | 找到 `baileys` 但加载失败，通常是缺 `qrcode` 或版本不兼容 | 确认 `qrcode` 已安装；重新安装到受支持的版本 |
| `ENGINE_QR_RENDER_FAILED` | 二维码库存在但渲染 data URL 失败 | 检查 `qrcode` 版本；查看服务端日志中的原始错误 |
| `PAIRING_FAILED` | 手机号配对码请求被引擎拒绝 | 确认号码是带国家码的 E.164；确认该号码尚未被其他方式绑定 |

本版不提供图形化安装器；安装/升级由部署者手动完成。引擎安装失败不会影响应用其他功能。
