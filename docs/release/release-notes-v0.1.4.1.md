# LULUX ETA v0.1.4.1 — WhatsApp 修复版 / WhatsApp fix release

> **源码可用（Source-available）· Business Source License 1.1**，许可条款与 v0.1.4 相同，详见 [LICENSE](https://github.com/koko2376/lulux-eta/blob/main/LICENSE)。

## 中文

修复两个 WhatsApp 问题：手机上的聊天记录不同步、翻译用不了。

- **绑定后自动同步近 3 个月聊天记录**：扫码或配对码绑定成功后，手机会把聊天记录分批推送过来，LULUX 导入最近 90 天的一对一聊天（群聊、广播、频道、状态不导入）。会话列表上方和渠道页显示“正在同步近 3 个月聊天记录… N 条”，完成后显示总条数。按消息 id 去重，重复推送不会重复写入；方向（我方 / 对方）、时间、联系人名、未读数与归档状态跟手机一致；图片、语音、文件等显示为占位标签（如“[图片] 说明”），媒体本身不下载。
- **手机上发出的消息也会同步**：绑定后在手机或其他设备上发出的消息出现在会话里（显示为我方消息），本机发出的消息不会因为回显再出现一次。
- **已经在 v0.1.4 绑定过的号码**：历史只在新绑定时由手机推送。请在手机 WhatsApp →「已关联的设备」里移除这台设备，再在 LULUX 里重新扫码，才会导入之前的聊天记录。
- **翻译可以用了**：v0.1.4 只接受一个需要另外安装的本地翻译包，没装时一律提示“翻译引擎未安装”。现在没有本地翻译包时，会使用 设置 → 模型 里选好的默认模型翻译（输入翻译与收到消息的翻译都一样），结果会缓存；连模型也没配置时，提示去设置里添加并选择模型。注意：用模型翻译时，消息原文会发给该模型的服务商，并计入用量。
- 数据库迁移 41（WhatsApp 消息按引擎消息 id 建索引）在启动时自动执行。

**版本号说明**：自动更新只认三段式版本号，所以安装包内部版本是 `0.1.5-0`（排在 0.1.4 之后、0.1.5 之前），界面、文件名和关于页显示 0.1.4.1。已安装 v0.1.4 的 Windows / Linux 客户端会自动收到这次更新，更新提示里可能显示“0.1.5-0”并带“预发布”标记，那就是本版本。未签名的 macOS 版请从下方附件手动下载 dmg 覆盖安装。

## English

Fixes two WhatsApp problems: chat history from the phone did not sync, and translation did not work.

- **Chats from the last 3 months sync after linking**: once you link by QR code or pairing code, the phone pushes its chat history in batches and LULUX imports one-to-one chats from the last 90 days (groups, broadcasts, channels and status updates are skipped). The chat list and the channel page show “Syncing chats from the last 3 months… N messages”, then the total when done. Messages are de-duplicated by message id; direction (you / them), time, contact names, unread counts and archive state follow the phone; images, voice notes, documents and other media appear as labels (e.g. “[Image] caption”) and the media itself is not downloaded.
- **Messages you send from the phone sync too**: messages sent from the phone or another device after linking appear in the chat as yours, and messages sent from LULUX do not appear twice when WhatsApp echoes them back.
- **Accounts already linked on v0.1.4**: the phone only pushes history when a device is newly linked. On the phone, remove this device under WhatsApp → Linked devices, then scan again in LULUX to import earlier chats.
- **Translation works**: v0.1.4 only accepted a separately installed local translator and otherwise always said “translation engine not installed”. Without a local translator, LULUX now translates with the default model chosen in Settings → Models (for both input translation and incoming messages) and caches the results; if no model is set up either, it asks you to add and select one. Note that model translation sends the message text to that model's provider and counts toward usage.
- Database migration 41 (an index on WhatsApp engine message ids) runs automatically on start-up.

**About the version number**: auto-update only understands three-part versions, so the package's internal version is `0.1.5-0` (after 0.1.4, before 0.1.5), while the interface, file names and About page show 0.1.4.1. Windows and Linux clients on v0.1.4 receive this update automatically; their update prompt may show “0.1.5-0” with a “pre-release” tag — that is this release. On unsigned macOS builds, download the dmg below and install it over the old version.

## 📦 下载 / Downloads

| 平台 / Platform | 文件 / File |
| --- | --- |
| Windows x64 | `LULUX-ETA-0.1.4.1-win-x64-setup.exe` |
| macOS Apple Silicon | `LULUX-ETA-0.1.4.1-mac-arm64.dmg` |
| macOS Intel | `LULUX-ETA-0.1.4.1-mac-x64.dmg` |
| Linux x64 / arm64 | `LULUX-ETA-0.1.4.1-linux-x86_64.AppImage` / `LULUX-ETA-0.1.4.1-linux-arm64.AppImage` |
| 团队服务器 / Team server | `lulux-eta-server-v0.1.4.1.tar.gz`，Docker：`ghcr.io/koko2376/lulux-eta:0.1.4.1` |

用 `SHA256SUMS.txt` 校验下载。/ Verify downloads with `SHA256SUMS.txt`.
