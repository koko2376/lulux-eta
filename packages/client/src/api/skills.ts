/**
 * Skill（技能）与会话工作区文件接口。契约 §8 尚未落文，按服务端实际实现接线：
 *   packages/server/src/routes/skills.ts、services/skills/**、services/tools/workspace.ts
 */
import { apiUrl, authHeaders, parseErrorBody, request } from './http'
import { localized, t } from '../i18n'

export type SkillSource = 'builtin' | 'user' | 'agent' | 'imported'

export interface SkillRequires {
  tools: string[]
  mcp: string[]
  npm: string[]
  python: boolean
}

export interface Skill {
  name: string
  description: string
  source: SkillSource
  enabled: boolean
  category: string | null
  keywords: string[]
  version: string | null
  author: string | null
  license: string | null
  upstream: { source: string; commit: string | null } | null
  requires: SkillRequires
  hasScripts: boolean
  readOnly: boolean
  modified: boolean
  updateAvailable: boolean
  origin: string
  installedBy: 'user' | 'agent' | 'system'
  useCount: number
  lastUsedAt: number | null
  installedAt: number
  updatedAt: number
  error: string | null
}

export interface SkillFileInfo {
  path: string
  size: number
}

export interface SkillDetail extends Skill {
  files: SkillFileInfo[]
  content: string
  body: string
  frontmatter: Record<string, unknown>
}

export interface SkillCategory {
  id: string
  label: string
  count: number
}

export interface SkillFile {
  path: string
  size: number
  binary: boolean
  content: string
  truncated: boolean
}

export interface SkillInstallResult {
  skill: Skill
  replaced: boolean
}

export const SKILL_SOURCE_LABEL: Record<SkillSource, string> = localized(() => ({
  builtin: t('apiSkills.k2pyzqu'),
  user: t('apiSkills.k12n6ei3'),
  agent: t('apiSkills.k1i2xed5'),
  imported: t('apiSkills.k1tcp0lz'),
}))

export async function listSkills(
  params: { query?: string; category?: string; source?: SkillSource; enabled?: boolean } = {},
): Promise<{ skills: Skill[]; categories: SkillCategory[] }> {
  const res = await request<{ skills?: Skill[]; categories?: SkillCategory[] }>('/api/skills', {
    query: {
      query: params.query,
      category: params.category,
      source: params.source,
      enabled: params.enabled === undefined ? undefined : params.enabled ? '1' : '0',
    },
  })
  return { skills: res?.skills ?? [], categories: res?.categories ?? [] }
}

export function getSkill(name: string): Promise<SkillDetail> {
  return request(`/api/skills/${encodeURIComponent(name)}`)
}

export function getSkillFile(name: string, path: string): Promise<SkillFile> {
  return request(`/api/skills/${encodeURIComponent(name)}/file`, { query: { path } })
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<Skill> {
  const res = await request<{ skill: Skill }>(`/api/skills/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: { enabled },
  })
  return res.skill
}

export function deleteSkill(name: string): Promise<void> {
  return request(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function resetSkill(name: string): Promise<Skill> {
  const res = await request<{ skill: Skill }>(`/api/skills/${encodeURIComponent(name)}/reset`, { method: 'POST' })
  return res.skill
}

export function exportSkill(name: string): Promise<Blob> {
  return request(`/api/skills/${encodeURIComponent(name)}/export`, { blob: true })
}

export interface InstallCommon {
  overwrite?: boolean
  subpath?: string
}

export function installSkillZip(
  input: { filename?: string; dataBase64: string } & InstallCommon,
): Promise<SkillInstallResult> {
  return request('/api/skills/install/zip', { method: 'POST', body: input, silent: true })
}

export function installSkillUrl(input: { url: string } & InstallCommon): Promise<SkillInstallResult> {
  return request('/api/skills/install/url', { method: 'POST', body: input, silent: true })
}

export function installSkillFolder(input: { path: string; overwrite?: boolean }): Promise<SkillInstallResult> {
  return request('/api/skills/install/folder', { method: 'POST', body: input, silent: true })
}

/* ── 按 Agent 配置可用 skill ── */
export type AgentSkillMode = 'all' | 'selected' | 'none'

export interface AgentSkillConfig {
  agentId: string
  mode: AgentSkillMode
  skills: string[]
  /** 该 Agent 当前实际可用的 skill（已启用且在配置内） */
  available: string[]
}

export function getAgentSkills(agentId: string): Promise<AgentSkillConfig> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/skills`)
}

export function putAgentSkills(agentId: string, mode: AgentSkillMode, skills: string[]): Promise<AgentSkillConfig> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/skills`, { method: 'PUT', body: { mode, skills } })
}

/* ── 会话工作区文件 ── */
export interface WorkspaceEntry {
  path: string
  type: 'file' | 'dir'
  size: number
  modifiedAt: string
}

export async function listSessionFiles(sessionId: string): Promise<WorkspaceEntry[]> {
  const res = await request<{ entries?: WorkspaceEntry[] }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/files/list`,
    { silent: true },
  )
  return res?.entries ?? []
}

export function uploadSessionFile(
  sessionId: string,
  input: { path: string; dataBase64: string; overwrite?: boolean },
): Promise<{ path: string; size: number }> {
  return request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/files`, {
    method: 'POST',
    body: input,
    silent: true,
  })
}

export function sessionFileUrl(sessionId: string, path: string): string {
  return `/api/chat/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`
}

/** 下载服务端给出的 downloadUrl（带鉴权头，返回 Blob） */
export async function fetchDownload(downloadUrl: string): Promise<Blob> {
  const res = await fetch(apiUrl(downloadUrl), { headers: authHeaders() })
  if (!res.ok) throw parseErrorBody(res.status, await res.text().catch(() => ''), res.statusText)
  return res.blob()
}

/** File → base64（不含 data: 前缀） */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(t('apiSkills.k13z3g8b')))
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const comma = text.indexOf(',')
      resolve(comma >= 0 ? text.slice(comma + 1) : text)
    }
    reader.readAsDataURL(file)
  })
}

/** 安装来源的人话描述：zip:xxx.zip / github:owner/repo / https://… / folder:… */
export function originLabel(skill: Pick<Skill, 'source' | 'origin' | 'upstream'>): string {
  if (skill.upstream?.source) {
    const commit = skill.upstream.commit ? ` @ ${skill.upstream.commit.slice(0, 7)}` : ''
    return `${skill.upstream.source}${commit}`
  }
  const origin = skill.origin || ''
  if (skill.source === 'builtin') return t('apiSkills.k17kzjs6')
  if (skill.source === 'agent' || origin === 'agent') return t('apiSkills.kxpuyo5')
  if (origin.startsWith('zip:')) return t('apiSkills.kfvbui7', [origin.slice(4)])
  if (origin.startsWith('folder:')) return t('apiSkills.khwwqh2', [origin.slice(7)])
  return origin || '—'
}

/** 输入框里的安装地址：GitHub（owner/repo、github.com 链接）或任意 https URL */
export function normalizeInstallUrl(raw: string): string {
  const text = raw.trim()
  if (/^[\w.-]+\/[\w.-]+(\/.*)?$/.test(text) && !text.includes('://')) return `https://github.com/${text}`
  return text
}

/** 技能页的分类筛选：服务端分类 + “导入”（非内置） */
export function matchesFilter(skill: Skill, filter: string): boolean {
  if (!filter) return true
  if (filter === 'imported') return skill.source !== 'builtin'
  if (filter === 'disabled') return !skill.enabled
  if (filter === 'update') return skill.updateAvailable
  return (skill.category ?? 'other') === filter
}

export function searchSkills(skills: Skill[], query: string): Skill[] {
  const q = query.trim().toLowerCase()
  if (!q) return skills
  return skills.filter((s) => `${s.name} ${s.description} ${s.keywords.join(' ')}`.toLowerCase().includes(q))
}
