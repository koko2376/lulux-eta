import { FrontmatterError, parseYaml, splitFrontmatter, stringifyYaml, type YamlValue } from './frontmatter.js'

/**
 * Skill 元数据（开放 Agent Skills 格式 + LULUX 扩展）。
 * 必填：name（小写字母/数字/连字符，≤64，与目录名一致）、description（≤1024）。
 * 可选：license、compatibility、allowed-tools，以及 metadata 下的
 *   keywords / version / author / category / requires{tools,mcp,npm,python} / source / upstream-commit。
 * 这些扩展键也接受写在顶层（兼容其他实现）。
 */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
export const DESCRIPTION_LIMIT = 1024

export interface SkillRequires {
  tools: string[]
  mcp: string[]
  /** 运行 scripts/ 下 Node 脚本需要的 npm 包（首次运行时装到 <dataDir>/skill-runtime） */
  npm: string[]
  python: boolean
}

export interface SkillMeta {
  name: string
  description: string
  license: string | null
  compatibility: string | null
  keywords: string[]
  version: string | null
  author: string | null
  category: string | null
  requires: SkillRequires
  /** 第三方来源（导入的 skill）：上游仓库与提交 */
  upstream: { source: string; commit: string | null } | null
  allowedTools: string[]
  /** 原始 frontmatter（只读展示用） */
  raw: Record<string, YamlValue>
}

export interface ParsedSkill {
  meta: SkillMeta
  body: string
}

export class SkillFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillFormatError'
  }
}

function str(value: YamlValue | undefined): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'object') return null
  const text = String(value).trim()
  return text || null
}

function list(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.filter((v) => v !== null && typeof v !== 'object').map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'object') return []
  // 逗号分隔的字符串
  return String(value)
    .split(/[,，、]/)
    .map((v) => v.trim())
    .filter(Boolean)
}

function pick(raw: Record<string, YamlValue>, meta: Record<string, YamlValue>, key: string): YamlValue | undefined {
  return meta[key] !== undefined ? meta[key] : raw[key]
}

export function parseSkillMarkdown(markdown: string, expectedName?: string): ParsedSkill {
  let split
  let raw: Record<string, YamlValue>
  try {
    split = splitFrontmatter(markdown)
    raw = parseYaml(split.frontmatter)
  } catch (error) {
    if (error instanceof FrontmatterError) throw new SkillFormatError(`SKILL.md frontmatter 不合法：${error.message}`)
    throw error
  }
  const name = str(raw.name)
  if (!name) throw new SkillFormatError('SKILL.md 缺少 name')
  if (!SKILL_NAME_RE.test(name)) throw new SkillFormatError(`name「${name}」不合法：只能用小写字母、数字和连字符（不能以连字符开头或结尾），最长 64 个字符`)
  if (expectedName && expectedName !== name) throw new SkillFormatError(`name「${name}」必须与目录名「${expectedName}」一致`)
  const description = str(raw.description)
  if (!description) throw new SkillFormatError('SKILL.md 缺少 description')
  if (description.length > DESCRIPTION_LIMIT) throw new SkillFormatError(`description 过长（${description.length} > ${DESCRIPTION_LIMIT}）`)

  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? (raw.metadata as Record<string, YamlValue>) : {}
  const reqRaw = pick(raw, metadata, 'requires')
  const req = reqRaw && typeof reqRaw === 'object' && !Array.isArray(reqRaw) ? (reqRaw as Record<string, YamlValue>) : {}
  const keywords = [...list(pick(raw, metadata, 'keywords')), ...list(pick(raw, metadata, 'tags'))]
  const hermes = metadata.hermes && typeof metadata.hermes === 'object' && !Array.isArray(metadata.hermes) ? (metadata.hermes as Record<string, YamlValue>) : null
  if (hermes) keywords.push(...list(hermes.tags))
  const source = str(pick(raw, metadata, 'source'))
  const commit = str(pick(raw, metadata, 'upstream-commit')) ?? str(pick(raw, metadata, 'upstream_commit'))

  return {
    meta: {
      name,
      description,
      license: str(raw.license) ?? str(metadata.license),
      compatibility: str(raw.compatibility),
      keywords: [...new Set(keywords)].slice(0, 40),
      version: str(pick(raw, metadata, 'version')),
      author: str(pick(raw, metadata, 'author')),
      category: str(pick(raw, metadata, 'category')),
      requires: {
        tools: list(req.tools),
        mcp: list(req.mcp),
        npm: list(req.npm),
        python: req.python === true || String(req.python ?? '').toLowerCase() === 'true',
      },
      upstream: source ? { source, commit } : null,
      allowedTools: list(raw['allowed-tools']),
      raw,
    },
    body: split.body.replace(/^(\r?\n)+/, ''),
  }
}

export interface ComposeInput {
  name: string
  description: string
  body: string
  keywords?: string[]
  version?: string
  author?: string
  category?: string
  license?: string
  requires?: Partial<SkillRequires>
  extra?: Record<string, YamlValue>
}

/** 生成 SKILL.md（Agent 自写 skill 用） */
export function composeSkillMarkdown(input: ComposeInput): string {
  const metadata: Record<string, YamlValue> = {}
  if (input.keywords?.length) metadata.keywords = input.keywords
  if (input.version) metadata.version = input.version
  if (input.author) metadata.author = input.author
  if (input.category) metadata.category = input.category
  const requires: Record<string, YamlValue> = {}
  if (input.requires?.tools?.length) requires.tools = input.requires.tools
  if (input.requires?.mcp?.length) requires.mcp = input.requires.mcp
  if (input.requires?.npm?.length) requires.npm = input.requires.npm
  if (input.requires?.python) requires.python = true
  if (Object.keys(requires).length) metadata.requires = requires
  Object.assign(metadata, input.extra ?? {})
  const front: Record<string, YamlValue> = { name: input.name, description: input.description }
  if (input.license) front.license = input.license
  if (Object.keys(metadata).length) front.metadata = metadata
  const body = input.body.replace(/^\s+/, '')
  return `---\n${stringifyYaml(front)}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`
}
