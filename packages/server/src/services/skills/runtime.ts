import { settingsService } from '../settings-service.js'
import { agentSkills } from './agent-skills.js'
import { parseSkillMarkdown } from './format.js'
import { skillService, type Skill } from './skill-service.js'

/**
 * 对话运行时接入：
 * - 系统提示只注入已启用 skill 的 name + description 索引（控制 token：描述截断、总长上限）；
 * - 完整说明由模型调用 skill_view 按需读取；
 * - 用户消息命中某 skill 的 keywords 时预加载其 SKILL.md 正文（最多 2 个，各 ≤ 12000 字符）。
 */
export const INDEX_MAX_CHARS = 7000
const DESCRIPTION_MAX = 220
const PRELOAD_MAX_SKILLS = 2
const PRELOAD_MAX_CHARS = 12_000

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function skillIndexText(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const header =
    '## 可用技能（Skill）\n' +
    '以下是已安装的技能，每个技能是一份针对某类任务的专业做法（步骤、模板、检查清单，可能附带脚本）。' +
    '当用户的任务与某个技能相关时，先调用 skill_view 读取它的 SKILL.md，再按其中的说明执行；' +
    '说明里提到的附属文件（references/、templates/ 等）也用 skill_view 读取，scripts/ 下的脚本用 run_skill_script 运行。' +
    '不相关时不必读取。\n'
  const lines: string[] = []
  let used = header.length
  let omitted = 0
  for (const skill of skills) {
    const line = `- ${skill.name}：${oneLine(skill.description, DESCRIPTION_MAX)}${skill.hasScripts ? '（含脚本）' : ''}`
    if (used + line.length + 1 > INDEX_MAX_CHARS) {
      omitted += 1
      continue
    }
    lines.push(line)
    used += line.length + 1
  }
  if (omitted > 0) lines.push(`- ……另有 ${omitted} 个技能未列出，可用 skill_list 按关键词查找。`)
  return `${header}${lines.join('\n')}`
}

export function skillIndexFor(agentId: string): string {
  try {
    return skillIndexText(agentSkills.allowed(agentId))
  } catch (error) {
    console.warn('[lulux-eta] skill index unavailable:', error instanceof Error ? error.message : String(error))
    return ''
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ')
}

/** 关键词匹配：中文按子串；纯 ASCII 关键词按词边界（避免 “pi” 命中 “api”） */
export function keywordHit(message: string, keyword: string): boolean {
  const kw = normalize(keyword.trim())
  if (kw.length < 2) return false
  const text = normalize(message)
  if (/^[\x20-\x7e]+$/.test(kw)) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text)
  }
  return text.includes(kw)
}

export interface PreloadResult {
  names: string[]
  text: string
}

export function preloadSkills(agentId: string, message: string, sessionId?: string): PreloadResult {
  if (settingsService.get('skillAutoPreload') === '0' || !message.trim()) return { names: [], text: '' }
  let candidates: Array<{ skill: Skill; score: number }>
  try {
    candidates = agentSkills
      .allowed(agentId)
      .map((skill) => ({ skill, score: skill.keywords.filter((kw) => keywordHit(message, kw)).length }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.skill.useCount - a.skill.useCount)
      .slice(0, PRELOAD_MAX_SKILLS)
  } catch {
    return { names: [], text: '' }
  }
  const parts: string[] = []
  const names: string[] = []
  for (const { skill } of candidates) {
    try {
      const file = skillService.readFile(skill.name, 'SKILL.md', 200_000)
      const body = parseSkillMarkdown(file.content, skill.name).body
      const clipped = body.length > PRELOAD_MAX_CHARS ? `${body.slice(0, PRELOAD_MAX_CHARS)}\n…（已截断，完整内容用 skill_view 读取）` : body
      parts.push(`### 技能 ${skill.name}（已根据用户消息自动加载）\n${clipped}`)
      names.push(skill.name)
      skillService.recordUse(skill.name, 'preload', sessionId, agentId)
    } catch {
      // 读不到就跳过
    }
  }
  if (parts.length === 0) return { names: [], text: '' }
  return {
    names,
    text: `## 已预加载的技能说明（来自本机已安装的 skill，按其中的步骤执行；无需再 skill_view 这些 SKILL.md）\n${parts.join('\n\n')}`,
  }
}
