# WhatsApp 输入翻译引擎（运行时安装）

在会话页打开翻译后，小框里用母语输入，译文自动填入主输入框，发出的始终是主输入框里的内容；对方发来的消息也可在气泡内显示译文（不改原文）。

WhatsApp 的输入翻译与 WhatsApp 通道本身采用同一策略：**不随应用打包、不写入任何 `package.json`**。服务端在运行时从本地目录动态加载翻译引擎；没有安装时明确返回 `TRANSLATOR_NOT_INSTALLED`，界面展示原因与安装指引，绝不把原文当作译文。

## 查找顺序

1. `LULUX_WHATSAPP_TRANSLATOR_DIR`（显式目录，优先级最高）
2. `<LULUX_ETA_HOME>/whatsapp/translator`
3. 从当前工作目录向上最多 4 层的 `.eta-engines/translator`

目录内必须有 `package.json`，入口由 `exports` / `module` / `main` / `index.js` 解析。`.eta-engines/` 已在 `.gitignore` 中。

## 运行时包契约

```js
// .eta-engines/translator/index.js（ESM）
export function createTranslator() {
  return {
    id: 'argos-offline',
    kind: 'local',        // 'local' | 'cloud' | 'llm'
    enabled: true,        // 付费云/LLM provider 必须默认 false
    async translate({ text, sourceLang, targetLang }) {
      return { text: '...', sourceLang, targetLang }
    },
  }
}
```

`createTranslator()` 也可以作为默认导出返回。缺少该函数或 `translate()` 会得到 `TRANSLATOR_LOAD_FAILED`；provider 的 `enabled` 为 `false` 时得到 `TRANSLATOR_DISABLED`。

## 语言

- 默认目标语言：`en`。
- 可选：`en`、`zh-Hans`、`zh-Hant`、`ja`、`ko`、`ru`、`es`、`pt`、`fr`、`de`、`ar`、`th`、`vi`、`id`、`auto`。
- `auto` 只在用户显式选择时生效：服务端按会话最近一条入站消息判断；判断不出时回退 `en`。

## 内置的 fake 引擎

仅用于单测与浏览器验收：

```bash
LULUX_WHATSAPP_TRANSLATOR=fake
```

它提供固定短语译文，其他文本返回 `[fake:<lang>] <原文>`，用于验证「小框输入 → 译文填入主输入框 → 发送主输入框内容」的交互。它**不是**真实离线翻译。

## 付费云 / LLM

`src/services/whatsapp/translator.ts` 只保留 `ReservedPaidTranslatorConfig` 接口（`cloud-reserved` / `llm-reserved`），默认 `enabled: false`，不读取 `LULUX_TRANSLATOR_CLOUD_KEY` / `LULUX_TRANSLATOR_LLM_KEY`，也不发起网络请求。后续接入时必须显式启用并单独做隐私与计费说明。

## 故障排查

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `TRANSLATOR_NOT_INSTALLED` | 上述目录都没有 `package.json` | 按本文安装运行时包，或设置 `LULUX_WHATSAPP_TRANSLATOR=fake` 做界面验收 |
| `TRANSLATOR_LOAD_FAILED` | 清单解析失败、入口缺失、未导出 `createTranslator()` | 检查包入口与导出 |
| `TRANSLATOR_DISABLED` | provider 的 `enabled` 为 `false` | 付费 provider 默认关闭；改用本地 provider |
| `TRANSLATION_FAILED` | `translate()` 抛错 | 查看服务端日志中的原始错误 |
