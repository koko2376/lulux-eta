import type { ProviderKind } from '../api'
import { localized, t } from '../i18n'

/** Provider 预设：只预填名称、协议与 Base URL，不附带任何品牌 logo */
export interface ProviderPreset {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  needsKey: boolean
  hint?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = localized(() => [
  {
    id: 'custom',
    label: t('providerPresets.kcw8on9'),
    kind: 'openai',
    baseUrl: '',
    needsKey: true,
    hint: t('providerPresets.k14ia0zl'),
  },
  { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  {
    id: 'dashscope',
    label: t('providerPresets.kbr87c3'),
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
  },
  {
    id: 'moonshot',
    label: t('providerPresets.k435zxq'),
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    needsKey: true,
  },
  {
    id: 'zhipu',
    label: t('providerPresets.kq5yjc9'),
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    needsKey: true,
  },
  {
    id: 'siliconflow',
    label: t('providerPresets.k1rnmbc3'),
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    needsKey: true,
  },
  {
    id: 'ark',
    label: t('providerPresets.khnojdf'),
    kind: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    needsKey: true,
  },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  {
    id: 'ollama',
    label: t('providerPresets.knf1m28'),
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    hint: t('providerPresets.kb1w20c'),
  },
])

export function parseModelList(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  )
}
