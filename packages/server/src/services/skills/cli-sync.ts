import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { agentSkills, skillsFeatureEnabled } from './agent-skills.js'
import { readSkillDirectory } from './package.js'
import { skillDir } from './paths.js'

/**
 * scoped 模式下把已启用的 skill 同步到第三方 CLI 隔离配置目录里它们原生识别的“用户级 skills”位置
 * （各 CLI 均原生支持开放 Agent Skills 格式：<dir>/<name>/SKILL.md）。2026-10-20 按各自文档/源码核实：
 *
 * | 内核 | 隔离目录变量 | 同步到 | 依据 |
 * | Claude Code 2.1.x | CLAUDE_CONFIG_DIR=<home> | <home>/skills | 设置 CLAUDE_CONFIG_DIR 时个人 skill 从 $CLAUDE_CONFIG_DIR/skills 读取（anthropics/claude-code#55065，v2.1.122 复现）；默认位置 ~/.claude/skills |
 * | Codex 0.16x | CODEX_HOME=<home> | <home>/skills | codex-rs core-skills loader：$CODEX_HOME/skills 为兼容保留的用户 skill 位置（新位置 ~/.agents/skills 基于真实 HOME，不隔离，故不用） |
 * | Gemini CLI | GEMINI_CLI_HOME=<home> | <home>/.gemini/skills | Storage.getUserSkillsDir() = homedir()/.gemini/skills，homedir() 优先取 GEMINI_CLI_HOME；skills 默认启用 |
 * | Hermes Agent 0.22 | HERMES_HOME=<home> | <home>/skills | hermes_constants.get_skills_dir() = get_hermes_home()/skills |
 * | Pi 1.x | PI_CODING_AGENT_DIR=<home> | <home>/skills | docs/configuration.md：<agent-dir>/skills/ 为用户 skill 目录 |
 * | Grok Build 1.0 | GROK_HOME=<home> | <home>/skills | docs.x.ai/build/features/skills-plugins-marketplaces：~/.grok/skills（GROK_HOME 即 ~/.grok） |
 * | Qwen Code 1.x | QWEN_HOME=<home> | <home>/skills | Storage.getGlobalQwenDir() 取 QWEN_HOME，用户 skill 目录为其下 skills/；1.x 起默认启用（--experimental-skills 已废弃） |
 *
 * 只复制 skill 文件本身（跳过 .backups、.env、*.pem/*.key 等疑似密钥文件），绝不写入任何密钥。
 * 用 .lulux-managed.json 记录由 LULUX 写入的 skill；被禁用/删除的会从目录里移除，CLI 自己生成的其他 skill 不动。
 * global 模式（使用用户自己的 ~/.claude 等）不做同步，避免改动用户的个人配置。
 */
export const CLI_SKILL_DIRS: Record<string, (home: string) => string> = {
  'claude-code': (home) => join(home, 'skills'),
  codex: (home) => join(home, 'skills'),
  'gemini-cli': (home) => join(home, '.gemini', 'skills'),
  'qwen-code': (home) => join(home, 'skills'),
  hermes: (home) => join(home, 'skills'),
  pi: (home) => join(home, 'skills'),
  grok: (home) => join(home, 'skills'),
}

const MANIFEST = '.lulux-managed.json'
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa.*|credentials(\.json)?|\.npmrc|\.netrc)$/i

interface Manifest {
  skills: Record<string, string>
}

function readManifest(dir: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest
    if (parsed && typeof parsed.skills === 'object') return parsed
  } catch {
    // 没有或损坏
  }
  return { skills: {} }
}

/** base 之下到 target 的每一级（含 target 本身）是否有符号链接；不存在的层级跳过 */
function pathHasSymlink(base: string, target: string): boolean {
  const rel = relative(base, target)
  let current = base
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

export interface CliSyncReport {
  dir: string | null
  synced: string[]
  removed: string[]
  unsupported: boolean
}

export function syncSkillsToKernelHome(kernelId: string, home: string): CliSyncReport {
  const target = CLI_SKILL_DIRS[kernelId]
  if (!target) return { dir: null, synced: [], removed: [], unsupported: true }
  const dir = target(home)
  // 内核能改写自己的配置目录：skills 目录（或它的上级）被换成符号链接时不同步，
  // 否则会往链接目标里写文件，并按（同样可被改写的）清单删除目标里的目录
  if (pathHasSymlink(home, dir)) {
    console.warn(`[lulux-eta] 内核 skills 目录含符号链接，跳过同步：${dir}`)
    return { dir, synced: [], removed: [], unsupported: false }
  }
  const manifest = readManifest(dir)
  const skills = skillsFeatureEnabled() ? agentSkills.allowed(`kernel-${kernelId}`) : []
  const next: Manifest = { skills: {} }
  const synced: string[] = []
  const removed: string[] = []
  mkdirSync(dir, { recursive: true })
  for (const skill of skills) {
    let files
    try {
      files = readSkillDirectory(skillDir(skill.name)).filter((f) => !f.isSymlink && !SECRET_FILE.test(f.path))
    } catch {
      continue
    }
    const hash = createHash('sha256')
    for (const file of files) hash.update(file.path).update('\0').update(file.data)
    const digest = hash.digest('hex')
    next.skills[skill.name] = digest
    const out = join(dir, skill.name)
    if (manifest.skills[skill.name] === digest && existsSync(join(out, 'SKILL.md'))) continue
    if (existsSync(out) && !manifest.skills[skill.name]) {
      // 同名目录不是我们写的（CLI 或用户自己放的）：不覆盖
      delete next.skills[skill.name]
      continue
    }
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out)
    for (const file of files) {
      const abs = join(out, ...file.path.split('/'))
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, file.data)
    }
    synced.push(skill.name)
  }
  for (const name of Object.keys(manifest.skills)) {
    if (next.skills[name]) continue
    if (!/^[a-z0-9-]+$/.test(name)) continue
    rmSync(join(dir, name), { recursive: true, force: true })
    removed.push(name)
  }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(next, null, 2)}\n`)
  return { dir, synced, removed, unsupported: false }
}

/** 测试与诊断：哪些 skill 会被同步 */
export function skillsForKernel(kernelId: string): string[] {
  return skillsFeatureEnabled() ? agentSkills.allowed(`kernel-${kernelId}`).map((s) => s.name) : []
}

