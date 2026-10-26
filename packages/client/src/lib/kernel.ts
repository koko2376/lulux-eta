import type { Agent, Runtime } from '../api'
import { t } from '../i18n'

/** 契约 §6.1：scoped 下没有可用 Provider 时的不可用原因 */
/** 服务端返回的不可用原因（中文原文，用于匹配，不翻译） */
export const REASON_NEED_MODEL = '请先在模型与密钥中配置模型'

/** 服务端返回的不可用原因（中文原文）→ 当前界面语言；未知原因原样返回 */
export function kernelReasonText(reason: string | null | undefined): string {
  if (!reason) return ''
  if (reason === REASON_NEED_MODEL) return t('kernel.reasonNeedModel')
  if (reason === '未安装') return t('kernel.reasonNotInstalled')
  if (reason === '需要登录') return t('kernel.reasonNeedLogin')
  if (reason === '服务器已禁用内核') return t('kernel.reasonServerDisabled')
  return reason
}

/** 不可用 Agent 的“去处理”按钮：文字与跳转目标 */
export function unavailableAction(agent: Pick<Agent, 'unavailableReason'>): { text: string; to: string } {
  const reason = agent.unavailableReason ?? ''
  if (reason === REASON_NEED_MODEL || reason.includes('模型与密钥'))
    return { text: t('kernel.k1ae2wxx'), to: '/settings/models' }
  if (reason === '需要登录') return { text: t('kernel.k1i2fhif'), to: '/settings/kernels' }
  if (reason.includes('服务器已禁用')) return { text: t('kernel.kdjhr4c'), to: '/settings/kernels' }
  return { text: t('kernel.k1gzpp3c'), to: '/settings/kernels' }
}

/** 消息头运行者：kernel runtime 有 label 时直接显示（§6.4-3），否则回退旧格式 */
export function runtimeLabel(runtime: Runtime | null | undefined, agents: Agent[] = []): string {
  if (!runtime) return ''
  if (runtime.kind === 'provider') return `${runtime.providerName} · ${runtime.model}`
  if (runtime.label) return runtime.label
  const kernel = agents.find((agent) => agent.kernelId === runtime.kernelId)
  const name = kernel?.name ?? runtime.kernelId
  const version = runtime.version ? ` ${runtime.version}` : ''
  if (runtime.mode === 'scoped' && runtime.providerName) {
    return t('kernel.k1dmvs9d', [name, version, runtime.providerName, runtime.model ? `/${runtime.model}` : ''])
  }
  return t('kernel.k17ftwf7', [name, runtime.version ? ` v${runtime.version}` : ''])
}

/**
 * 内核目录（服务端 catalog）里的名称 / 简介 / 体积是中文原文：按 id 在客户端本地化，未知内核原样显示。
 */
const KERNEL_DESC: Record<string, string> = {
  builtin: 'kernelCatalog.builtinDesc',
  hermes: 'kernelCatalog.hermesDesc',
  'claude-code': 'kernelCatalog.claudeDesc',
  codex: 'kernelCatalog.codexDesc',
  pi: 'kernelCatalog.piDesc',
  grok: 'kernelCatalog.grokDesc',
  'gemini-cli': 'kernelCatalog.geminiDesc',
  'qwen-code': 'kernelCatalog.qwenDesc',
}
/** 内核管理页的一行说明，内核选择器里用 */
const KERNEL_TAGLINE: Record<string, string> = {
  builtin: 'kernelCatalog.builtinTagline',
  hermes: 'kernelCatalog.hermesTagline',
  'claude-code': 'kernelCatalog.claudeTagline',
  codex: 'kernelCatalog.codexTagline',
  pi: 'kernelCatalog.piTagline',
  grok: 'kernelCatalog.grokTagline',
  'gemini-cli': 'kernelCatalog.geminiTagline',
  'qwen-code': 'kernelCatalog.qwenTagline',
}
/** 会话 Agent 对应的内核 id：命令行内核取 kernelId，其余（内置 / 旧 persona）都是 builtin */
export function agentKernelId(agent: Pick<Agent, 'kind' | 'kernelId'>): string {
  return agent.kind === 'kernel' && agent.kernelId ? agent.kernelId : 'builtin'
}
export function agentName(agent: Pick<Agent, 'kind' | 'kernelId' | 'name'>): string {
  return agentKernelId(agent) === 'builtin' && agent.kind !== 'persona' ? t('kernelCatalog.builtinName') : agent.name
}
export function agentTagline(agent: Pick<Agent, 'kind' | 'kernelId' | 'description'>): string {
  const key = KERNEL_TAGLINE[agentKernelId(agent)]
  return key && agent.kind !== 'persona' ? t(key) : agent.description
}
export function kernelTagline(k: { id: string; tagline?: string; description?: string }): string {
  const key = KERNEL_TAGLINE[k.id]
  return key ? t(key) : (k.tagline ?? k.description ?? '')
}
export function kernelName(k: { id: string; name: string }): string {
  return k.id === 'builtin' ? t('kernelCatalog.builtinName') : k.name
}
export function kernelDescription(k: { id: string; description?: string }): string {
  const key = KERNEL_DESC[k.id]
  return key ? t(key) : (k.description ?? '')
}
export function kernelSizeHint(hint: string | undefined | null): string {
  if (!hint) return ''
  const mb = /约\s*(\d+)\s*MB/i.exec(hint)
  if (mb) return t('kernelCatalog.sizeAbout', [mb[1]])
  if (hint === '已内置') return t('kernelCatalog.bundled')
  return hint
}
