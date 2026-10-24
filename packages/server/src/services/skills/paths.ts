import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../../config.js'
import { normalizeEntryPath, SkillPackageError } from './package.js'
import { SKILL_NAME_RE } from './format.js'

/** 用户/Agent/导入的 skill 与内置副本都在 <dataDir>/skills/<name>/ */
export function skillsRoot(): string {
  return process.env.LULUX_SKILLS_DIR || join(config.home, 'skills')
}

export function backupsRoot(): string {
  return join(skillsRoot(), '.backups')
}

/** Node 脚本依赖安装目录 */
export function skillRuntimeDir(): string {
  return join(config.home, 'skill-runtime')
}

function moduleDir(): string | null {
  try {
    // 打包后的单文件 CJS 没有 import.meta.url
    if (typeof __filename === 'string') return dirname(__filename)
  } catch {
    // ESM
  }
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
}

/**
 * 内置 skill 只读目录（随安装包分发）：
 * LULUX_BUILTIN_SKILLS_DIR > <resources>/skills（打包：resources/server/index.cjs 的上一级）> 仓库 packages/server/skills。
 */
export function builtinSkillsDir(): string | null {
  const explicit = process.env.LULUX_BUILTIN_SKILLS_DIR?.trim()
  if (explicit) return existsSync(explicit) ? explicit : null
  const candidates: string[] = []
  const here = moduleDir()
  if (here) {
    // 打包：resources/server/index.cjs → resources/skills
    candidates.push(join(here, '..', 'skills'))
    // 开发：src/services/skills 或 dist/services/skills → packages/server/skills
    candidates.push(join(here, '..', '..', '..', 'skills'))
  }
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources) candidates.push(join(resources, 'skills'))
  for (const dir of candidates) {
    if (existsSync(join(dir, 'MANIFEST.md')) || existsSync(join(dir, 'skill-creator', 'SKILL.md'))) return resolve(dir)
  }
  return null
}

export function assertSkillName(name: string): void {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new SkillPackageError(`skill 名称不合法：${String(name).slice(0, 80)}`, 'SKILL_NAME_INVALID')
}

export function skillDir(name: string): string {
  assertSkillName(name)
  return join(skillsRoot(), name)
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
}

/**
 * skill 目录内的文件路径（skill_view / run_skill_script / 文件预览共用）：
 * 只接受相对路径；拒绝 ..、绝对路径、NUL；文件本身与其祖先都不能是指向目录外的符号链接。
 */
export function resolveSkillFile(name: string, input: string): { abs: string; rel: string } {
  const base = skillDir(name)
  const rel = normalizeEntryPath(input || 'SKILL.md')
  if (!rel) throw new SkillPackageError('路径不能为空', 'SKILL_PATH_INVALID')
  const abs = resolve(base, rel)
  if (!inside(base, abs)) throw new SkillPackageError('路径超出 skill 目录', 'SKILL_PATH_INVALID')
  // 先 lstat（不跟随链接）：悬空的、或指向不存在目标的符号链接也按符号链接拒绝，而不是报“文件不存在”
  let linkStat
  try {
    linkStat = lstatSync(abs)
  } catch {
    throw new SkillPackageError(`文件不存在：${rel}`, 'SKILL_FILE_NOT_FOUND')
  }
  if (linkStat.isSymbolicLink()) throw new SkillPackageError('不允许读取符号链接', 'SKILL_SYMLINK')
  if (!existsSync(abs)) throw new SkillPackageError(`文件不存在：${rel}`, 'SKILL_FILE_NOT_FOUND')
  const realBase = realpathSync(base)
  const realAbs = realpathSync(abs)
  if (!inside(realBase, realAbs)) throw new SkillPackageError('路径通过符号链接指向了 skill 目录以外', 'SKILL_SYMLINK')
  return { abs: realAbs, rel }
}
