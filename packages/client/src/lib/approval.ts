import { localized, t } from '../i18n'
/**
 * 审批卡片（tool_request.approvalKind + detail，服务端 services/skills/tools.ts 的 approvalDetail）
 * 转成界面要展示的标题、字段和提醒。密钥类字段服务端只给键名（headerKeys / envKeys）。
 */
export type ApprovalKind =
  'tool' | 'skill_script' | 'skill_install' | 'skill_write' | 'mcp_add' | 'mcp_update' | 'mcp_remove'

export interface ApprovalView {
  title: string
  rows: Array<{ label: string; value: string; code?: boolean }>
  warnings: string[]
  errors: string[]
}

const TITLES: Record<string, string> = localized(() => ({
  skill_script: t('approval.k1yrf19j'),
  skill_install: t('approval.kxwmlqp'),
  skill_write: t('approval.k2dhpcd'),
  mcp_add: t('approval.kfozjzh'),
  mcp_update: t('approval.kc4wdmp'),
  mcp_remove: t('approval.kgz0jwp'),
}))

type Detail = Record<string, unknown>

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

export function approvalTitle(kind: string | undefined, toolName: string): string {
  return (kind && TITLES[kind]) || toolName
}

export function approvalView(kind: string | undefined, detail: unknown, toolName = ''): ApprovalView | null {
  if (!kind || kind === 'tool' || !detail || typeof detail !== 'object') return null
  const d = detail as Detail
  const view: ApprovalView = { title: approvalTitle(kind, toolName), rows: [], warnings: [], errors: [] }
  const row = (label: string, value: unknown, code = false): void => {
    const v = text(value)
    if (v) view.rows.push({ label, value: v, code })
  }

  if (d.invalid) {
    view.errors = list(d.errors)
    const args = (d.arguments && typeof d.arguments === 'object' ? d.arguments : {}) as Detail
    for (const [key, value] of Object.entries(args)) row(key, value, true)
    view.warnings.push(t('approval.kquvshr'))
    return view
  }

  switch (kind) {
    case 'skill_script': {
      row(t('approval.kn9kmfv'), d.skill, true)
      row(t('approval.kzfxmnf'), d.script, true)
      row(t('approval.kwcu2xe'), list(d.args).join(' '), true)
      row(
        t('approval.k9l679i'),
        d.interpreter === 'python' ? 'Python' : d.interpreter === 'node' ? 'Node.js' : d.interpreter,
      )
      row(t('approval.kijzjfj'), d.cwd)
      row(t('approval.k1yrdydf'), d.timeoutSeconds ? t('approval.k16jrnnd', [text(d.timeoutSeconds)]) : '')
      const npm = list(d.npmToInstall)
      if (npm.length) view.warnings.push(t('approval.kvodn2h', [npm.join(t('fmt.listSep'))]))
      if (d.skillSource && d.skillSource !== 'builtin') view.warnings.push(t('approval.k18zxw1n'))
      break
    }
    case 'skill_install': {
      row(t('approval.kst2c9j'), d.url, true)
      row(t('approval.kmbc7lo'), d.path, true)
      row(t('approval.k1j0zjy6'), d.subpath, true)
      if (d.overwrite) view.warnings.push(t('approval.k5udo0a'))
      break
    }
    case 'skill_write': {
      row(t('approval.kn9kmfv'), d.name, true)
      row(t('approval.ki343bw'), d.description)
      const changes = list(d.changes).map(
        (c) =>
          ({ description: t('approval.ki343bw'), body: t('approval.k18moclf'), keywords: t('approval.k1kmra3s') })[c] ??
          c,
      )
      row(t('approval.k1jzik2f'), changes.join(t('fmt.listSep')))
      row(t('approval.k1ruoy8b'), list(d.files).join(t('fmt.listSep')), true)
      row(t('approval.k14vypn2'), list(d.deleteFiles).join(t('fmt.listSep')), true)
      if (d.hasScripts) view.warnings.push(t('approval.k1uygbd0'))
      break
    }
    case 'mcp_add':
    case 'mcp_update': {
      row(t('approval.k7qqgy7'), d.name)
      if (kind === 'mcp_update') row('ID', d.id, true)
      row(
        t('approval.k5qwihu'),
        d.transport === 'http'
          ? t('approval.k1lpyzf4')
          : d.transport === 'stdio'
            ? t('approval.k18t4oi4')
            : d.transport,
      )
      row(t('approval.kst2c9j'), d.url, true)
      if (d.command) row(t('approval.k1d4t8np'), [d.command, ...list(d.args)].join(' '), true)
      row(t('approval.kylb6jm'), list(d.headerKeys).join(t('fmt.listSep')), true)
      row(t('approval.k13ao5c5'), list(d.envKeys).join(t('fmt.listSep')), true)
      if (typeof d.enabled === 'boolean')
        row(t('approval.k1n2qbel'), d.enabled ? t('approval.kdcbgv5') : t('approval.k12u0rgq'))
      if (d.nativeConfirm) view.warnings.push(t('approval.k17dblhn'))
      break
    }
    case 'mcp_remove': {
      row(t('approval.k7qqgy7'), d.name)
      row('ID', d.id, true)
      row(
        t('approval.k5qwihu'),
        d.transport === 'http'
          ? t('approval.k1lpyzf4')
          : d.transport === 'stdio'
            ? t('approval.k18t4oi4')
            : d.transport,
      )
      view.warnings.push(t('approval.k1rniasv'))
      break
    }
    default:
      for (const [key, value] of Object.entries(d)) row(key, value, true)
  }
  return view
}
