import { db } from '../../db.js'
import { AppError } from '../../errors.js'
import { settingsService } from '../settings-service.js'
import { skillService, type Skill } from './skill-service.js'

/**
 * 按 Agent（persona 或 kernel-<id>）配置可用的 skill：
 * - all（默认）：全部已启用的 skill；
 * - selected：只用 skills 列表里的（且已启用）；
 * - none：不用 skill（也不提供 skill 工具）。
 */
export type AgentSkillMode = 'all' | 'selected' | 'none'

export interface AgentSkillConfig {
  agentId: string
  mode: AgentSkillMode
  skills: string[]
}

interface Row {
  agent_id: string
  mode: AgentSkillMode
  skills: string
}

export function skillsFeatureEnabled(): boolean {
  return settingsService.get('skillsEnabled') !== '0'
}

export const agentSkills = {
  get(agentId: string): AgentSkillConfig {
    const row = db.prepare('SELECT * FROM agent_skills WHERE agent_id = ?').get(agentId) as unknown as Row | undefined
    if (!row) return { agentId, mode: 'all', skills: [] }
    let skills: string[] = []
    try {
      const parsed = JSON.parse(row.skills) as unknown
      if (Array.isArray(parsed)) skills = parsed.filter((v): v is string => typeof v === 'string')
    } catch {
      skills = []
    }
    return { agentId, mode: row.mode === 'selected' || row.mode === 'none' ? row.mode : 'all', skills }
  },

  set(agentId: string, mode: AgentSkillMode, skills: string[]): AgentSkillConfig {
    const unknown = skills.filter((name) => !skillService.get(name))
    if (unknown.length > 0) throw new AppError(400, 'SKILL_NOT_FOUND', `找不到 skill：${unknown.slice(0, 5).join('、')}`)
    const unique = [...new Set(skills)]
    db.prepare(
      `INSERT INTO agent_skills (agent_id, mode, skills, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET mode = excluded.mode, skills = excluded.skills, updated_at = excluded.updated_at`,
    ).run(agentId, mode, JSON.stringify(unique), Date.now())
    return agentSkills.get(agentId)
  },

  /** 该 Agent 在对话中可见的 skill（已启用、可解析、按配置过滤） */
  allowed(agentId: string): Skill[] {
    if (!skillsFeatureEnabled()) return []
    const config = agentSkills.get(agentId)
    if (config.mode === 'none') return []
    const enabled = skillService.list({ enabled: true }).filter((skill) => !skill.error)
    if (config.mode === 'all') return enabled
    const set = new Set(config.skills)
    return enabled.filter((skill) => set.has(skill.name))
  },

  isAllowed(agentId: string, name: string): boolean {
    return agentSkills.allowed(agentId).some((skill) => skill.name === name)
  },
}
