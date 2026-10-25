import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMarkdown, SkillFormatError, type ParsedSkill } from './format.js'
import type { ZipEntry } from './zip.js'

/**
 * 待安装的 skill 包（内存中的文件集合）与安装校验：
 * 大小/文件数上限、禁止符号链接与路径穿越、SKILL.md 必须存在且合法。
 */
export const SKILL_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxDepth: 8,
  maxPathLength: 240,
  /** 上传的 zip 本身 */
  maxArchiveBytes: 15 * 1024 * 1024,
}

export interface SkillFile {
  path: string
  data: Buffer
}

export interface SkillPackage {
  name: string
  parsed: ParsedSkill
  files: SkillFile[]
  hasScripts: boolean
  hash: string
  totalBytes: number
}

export class SkillPackageError extends Error {
  constructor(
    message: string,
    readonly code: string = 'SKILL_INVALID',
  ) {
    super(message)
    this.name = 'SkillPackageError'
  }
}

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.[^.]*)*$/i

/** 包内相对路径校验；返回规范化的 posix 路径 */
export function normalizeEntryPath(input: string): string {
  if (input.includes('\0')) throw new SkillPackageError(`路径包含非法字符：${JSON.stringify(input)}`, 'SKILL_PATH_INVALID')
  const raw = input.replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('~')) {
    throw new SkillPackageError(`不允许绝对路径：${input}`, 'SKILL_PATH_INVALID')
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) throw new SkillPackageError(`不允许路径穿越（..）：${input}`, 'SKILL_PATH_INVALID')
  // Windows 会悄悄改写的名字：末尾的点 / 空格被去掉（「.. 」变成上级目录、「SKILL.md.」覆盖 SKILL.md），
  // 只由点组成的名字，以及 CON / NUL / COM1 这类设备名（带扩展名也是设备）。一律拒绝，各平台行为一致
  for (const part of parts) {
    if (/^\.+$/.test(part) || /[. ]$/.test(part)) throw new SkillPackageError(`文件名不能以点或空格结尾：${input}`, 'SKILL_PATH_INVALID')
    if (WINDOWS_DEVICE_NAME.test(part)) throw new SkillPackageError(`文件名是系统保留的设备名：${input}`, 'SKILL_PATH_INVALID')
  }
  if (parts.length > SKILL_LIMITS.maxDepth) throw new SkillPackageError(`目录层级过深：${input}`, 'SKILL_PATH_INVALID')
  const path = parts.join('/')
  if (path.length > SKILL_LIMITS.maxPathLength) throw new SkillPackageError(`路径过长：${input.slice(0, 80)}…`, 'SKILL_PATH_INVALID')
  if (/[<>:"|?*\x00-\x1f]/.test(path)) throw new SkillPackageError(`文件名包含 Windows 不允许的字符：${input}`, 'SKILL_PATH_INVALID')
  return path
}

/** 打包/同步时忽略的文件（系统垃圾、VCS、备份） */
export function ignoredEntry(path: string): boolean {
  const parts = path.split('/')
  return parts.some((part) => part === '.git' || part === '__MACOSX' || part === '.DS_Store' || part === 'Thumbs.db' || part === '.backups' || part === 'node_modules' || part === '__pycache__')
}

export function hashFiles(files: SkillFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(createHash('sha256').update(file.data).digest())
  }
  return hash.digest('hex')
}

/**
 * 从原始条目（zip / 目录 / 下载）构造并校验 skill 包。
 * - 根目录有 SKILL.md；或者只有一个顶层目录且其中有 SKILL.md（自动去掉这一层）；
 * - 任何符号链接条目都拒绝；
 * - expectedName：要求 name 与它一致（例如目录导入时用目录名）。
 */
export function buildPackage(
  entries: Array<{ path: string; data: Buffer; isSymlink?: boolean; isDirectory?: boolean }>,
  options: { expectedName?: string } = {},
): SkillPackage {
  const files: SkillFile[] = []
  for (const entry of entries) {
    if (entry.isSymlink) throw new SkillPackageError(`不允许符号链接：${entry.path}`, 'SKILL_SYMLINK')
    const path = normalizeEntryPath(entry.path)
    if (!path || entry.isDirectory) continue
    if (ignoredEntry(path)) continue
    files.push({ path, data: entry.data })
  }
  // 去掉唯一的顶层目录
  let stripped = files
  if (!files.some((file) => file.path === 'SKILL.md')) {
    const tops = new Set(files.map((file) => file.path.split('/')[0]!))
    if (tops.size === 1) {
      const top = [...tops][0]!
      if (files.some((file) => file.path === `${top}/SKILL.md`)) {
        stripped = files.map((file) => ({ path: file.path.slice(top.length + 1), data: file.data }))
      }
    }
  }
  const skillMd = stripped.find((file) => file.path === 'SKILL.md')
  if (!skillMd) throw new SkillPackageError('包里没有 SKILL.md（应位于根目录或唯一的顶层目录下）', 'SKILL_MD_MISSING')
  if (stripped.length > SKILL_LIMITS.maxFiles) throw new SkillPackageError(`文件过多（${stripped.length} > ${SKILL_LIMITS.maxFiles}）`, 'SKILL_TOO_LARGE')
  let total = 0
  const seen = new Set<string>()
  for (const file of stripped) {
    const lower = file.path.toLowerCase()
    if (seen.has(lower)) throw new SkillPackageError(`文件名重复（不区分大小写）：${file.path}`, 'SKILL_PATH_INVALID')
    seen.add(lower)
    if (file.data.length > SKILL_LIMITS.maxFileBytes) throw new SkillPackageError(`文件过大：${file.path}`, 'SKILL_TOO_LARGE')
    total += file.data.length
  }
  if (total > SKILL_LIMITS.maxTotalBytes) throw new SkillPackageError(`总大小超过上限（${Math.round(SKILL_LIMITS.maxTotalBytes / 1024 / 1024)} MB）`, 'SKILL_TOO_LARGE')
  // 文件与目录同名冲突（a 与 a/b）
  for (const file of stripped) {
    if (seen.has(`${file.path.toLowerCase()}/`) || stripped.some((other) => other.path.toLowerCase().startsWith(`${file.path.toLowerCase()}/`))) {
      throw new SkillPackageError(`文件与目录同名：${file.path}`, 'SKILL_PATH_INVALID')
    }
  }
  let parsed: ParsedSkill
  try {
    parsed = parseSkillMarkdown(skillMd.data.toString('utf8'), options.expectedName)
  } catch (error) {
    if (error instanceof SkillFormatError) throw new SkillPackageError(error.message, 'SKILL_MD_INVALID')
    throw error
  }
  return {
    name: parsed.meta.name,
    parsed,
    files: stripped,
    hasScripts: stripped.some((file) => file.path.startsWith('scripts/')),
    hash: hashFiles(stripped),
    totalBytes: total,
  }
}

export function entriesFromZip(entries: ZipEntry[]): Array<{ path: string; data: Buffer; isSymlink: boolean; isDirectory: boolean }> {
  return entries.map((entry) => ({ path: entry.path, data: entry.data, isSymlink: entry.isSymlink, isDirectory: entry.isDirectory }))
}

/**
 * 读取本地目录（lstat，不跟随符号链接；遇到符号链接直接拒绝）。
 * 读取过程中就检查数量与大小，避免把巨大目录读进内存。
 */
export function readSkillDirectory(dir: string, options: { allowIgnored?: boolean } = {}): Array<{ path: string; data: Buffer; isSymlink: boolean }> {
  const out: Array<{ path: string; data: Buffer; isSymlink: boolean }> = []
  let total = 0
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > SKILL_LIMITS.maxDepth) throw new SkillPackageError(`目录层级过深：${rel}`, 'SKILL_PATH_INVALID')
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (!options.allowIgnored && ignoredEntry(childRel)) continue
      const childAbs = join(abs, entry.name)
      const stat = lstatSync(childAbs)
      if (stat.isSymbolicLink()) {
        out.push({ path: childRel, data: Buffer.alloc(0), isSymlink: true })
        continue
      }
      if (stat.isDirectory()) {
        walk(childAbs, childRel, depth + 1)
        continue
      }
      if (!stat.isFile()) continue
      if (out.length >= SKILL_LIMITS.maxFiles) throw new SkillPackageError(`文件过多（> ${SKILL_LIMITS.maxFiles}）`, 'SKILL_TOO_LARGE')
      if (stat.size > SKILL_LIMITS.maxFileBytes) throw new SkillPackageError(`文件过大：${childRel}`, 'SKILL_TOO_LARGE')
      total += stat.size
      if (total > SKILL_LIMITS.maxTotalBytes) throw new SkillPackageError('总大小超过上限', 'SKILL_TOO_LARGE')
      out.push({ path: childRel, data: readFileSync(childAbs), isSymlink: false })
    }
  }
  walk(dir, '', 0)
  return out
}
