import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { config } from '../../config.js'
import { ToolError } from './tool-error.js'

/**
 * 会话工作区沙箱：<dataDir>/workspace/<sessionId>/。
 * 所有路径都是相对沙箱根的路径；拒绝绝对路径、盘符、`..` 逃逸、NUL 与指向沙箱外的符号链接。
 */
export const WORKSPACE_FILE_LIMIT = 2 * 1024 * 1024
export const WORKSPACE_QUOTA = 50 * 1024 * 1024
export const WORKSPACE_READ_LIMIT = 1024 * 1024

export function workspaceRoot(): string {
  return join(config.home, 'workspace')
}

export function sessionWorkspace(sessionId: string, create = true): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw new ToolError('会话 id 不合法')
  const dir = join(workspaceRoot(), sessionId)
  if (create) mkdirSync(dir, { recursive: true })
  return dir
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
}

/** 解析沙箱内路径；不合法抛 ToolError（文案给模型看） */
export function resolveInWorkspace(sessionId: string, input: string): { base: string; path: string; rel: string } {
  if (typeof input !== 'string') throw new ToolError('path 必须是字符串')
  if (input.includes('\0')) throw new ToolError('路径包含非法字符')
  const normalized = input.replace(/\\/g, '/').trim() || '.'
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('~')) {
    throw new ToolError('只能使用工作区内的相对路径，不能用绝对路径')
  }
  if (normalized.split('/').includes('..')) throw new ToolError('路径不能包含 ..（不能访问工作区以外的文件）')
  if (normalized.length > 400) throw new ToolError('路径过长')
  const base = sessionWorkspace(sessionId)
  const target = resolve(base, normalized)
  if (!inside(base, target)) throw new ToolError('路径超出工作区')

  // 符号链接逃逸：最深的已存在祖先的真实路径必须仍在沙箱真实路径之内
  const realBase = realpathSync(base)
  let probe = target
  while (!existsSync(probe) && probe !== base) probe = dirname(probe)
  const realProbe = realpathSync(probe)
  if (!inside(realBase, realProbe)) throw new ToolError('路径通过符号链接指向了工作区以外')
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    const realTarget = realpathSync(target)
    if (!inside(realBase, realTarget)) throw new ToolError('路径通过符号链接指向了工作区以外')
  }
  return { base, path: target, rel: relative(base, target).split(sep).join('/') || '.' }
}

function dirSize(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

export interface WorkspaceEntry {
  path: string
  type: 'file' | 'dir'
  size: number
  modifiedAt: string
}

export function listWorkspace(sessionId: string, path = '.', recursive = false, max = 500): { entries: WorkspaceEntry[]; truncated: boolean } {
  const { base, path: target } = resolveInWorkspace(sessionId, path)
  if (!existsSync(target)) throw new ToolError(`目录不存在：${path}`)
  if (!statSync(target).isDirectory()) throw new ToolError(`不是目录：${path}`)
  const entries: WorkspaceEntry[] = []
  let truncated = false
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= max) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const stat = statSync(full)
      entries.push({
        path: relative(base, full).split(sep).join('/'),
        type: entry.isDirectory() ? 'dir' : 'file',
        size: entry.isDirectory() ? 0 : stat.size,
        modifiedAt: stat.mtime.toISOString(),
      })
      if (recursive && entry.isDirectory() && depth < 8) walk(full, depth + 1)
    }
  }
  walk(target, 0)
  return { entries, truncated }
}

export async function readWorkspaceFile(sessionId: string, path: string, offset = 0, limit = 50_000) {
  const { path: target, rel } = resolveInWorkspace(sessionId, path)
  if (!existsSync(target)) throw new ToolError(`文件不存在：${path}`)
  const stat = statSync(target)
  if (!stat.isFile()) throw new ToolError(`不是文件：${path}`)
  if (stat.size > WORKSPACE_READ_LIMIT) throw new ToolError(`文件过大（${stat.size} 字节），最多读取 ${WORKSPACE_READ_LIMIT} 字节`)
  const buffer = await readFile(target)
  if (buffer.subarray(0, 8000).includes(0)) return { path: rel, size: stat.size, binary: true, content: '' }
  const text = buffer.toString('utf8')
  const slice = text.slice(offset, offset + limit)
  return {
    path: rel,
    size: stat.size,
    binary: false,
    totalChars: text.length,
    offset,
    content: slice,
    truncated: offset + limit < text.length,
  }
}

export async function writeWorkspaceFile(sessionId: string, path: string, content: string, append = false) {
  const { base, path: target, rel } = resolveInWorkspace(sessionId, path)
  if (rel === '.') throw new ToolError('需要文件路径')
  const bytes = Buffer.byteLength(content, 'utf8')
  const existing = existsSync(target) ? statSync(target) : null
  if (existing?.isDirectory()) throw new ToolError(`是目录：${path}`)
  const finalSize = append ? (existing?.size ?? 0) + bytes : bytes
  if (finalSize > WORKSPACE_FILE_LIMIT) throw new ToolError(`单个文件不能超过 ${WORKSPACE_FILE_LIMIT / 1024 / 1024} MB`)
  const used = dirSize(base) - (existing?.size ?? 0)
  if (used + finalSize > WORKSPACE_QUOTA) throw new ToolError(`工作区已满（上限 ${WORKSPACE_QUOTA / 1024 / 1024} MB）`)
  await mkdir(dirname(target), { recursive: true })
  // 父目录创建后再校验一次，防止竞争中被替换成符号链接
  resolveInWorkspace(sessionId, rel)
  if (append) await appendFile(target, content, 'utf8')
  else await writeFile(target, content, 'utf8')
  return { path: rel, bytes: finalSize, created: !existing }
}

/** 写入二进制文件（PDF 等），同样受路径、单文件与总量限制 */
export async function writeWorkspaceBinary(sessionId: string, path: string, content: Buffer) {
  const { base, path: target, rel } = resolveInWorkspace(sessionId, path)
  if (rel === '.') throw new ToolError('需要文件路径')
  const existing = existsSync(target) ? statSync(target) : null
  if (existing?.isDirectory()) throw new ToolError(`是目录：${path}`)
  if (content.length > WORKSPACE_FILE_LIMIT) throw new ToolError(`单个文件不能超过 ${WORKSPACE_FILE_LIMIT / 1024 / 1024} MB`)
  const used = dirSize(base) - (existing?.size ?? 0)
  if (used + content.length > WORKSPACE_QUOTA) throw new ToolError(`工作区已满（上限 ${WORKSPACE_QUOTA / 1024 / 1024} MB）`)
  await mkdir(dirname(target), { recursive: true })
  resolveInWorkspace(sessionId, rel)
  await writeFile(target, content)
  return { path: rel, bytes: content.length, created: !existing }
}
