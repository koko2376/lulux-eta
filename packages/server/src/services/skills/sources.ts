import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { AppError } from '../../errors.js'
import { fetchWithProxy } from '../http-client.js'
import { assertPublicHttpUrl, publicOnlyDispatcher } from '../tools/net-guard.js'
import { settingsService } from '../settings-service.js'
import { buildPackage, entriesFromZip, readSkillDirectory, SKILL_LIMITS, SkillPackageError, type SkillPackage } from './package.js'
import { readZip, ZipError } from './zip.js'

/**
 * skill 安装来源：zip（上传/URL）、GitHub 仓库目录、raw 目录（单个 SKILL.md）、本地文件夹。
 * 下载都只走 http/https，拒绝内网地址（与 fetch_url 同一套校验），并限制大小与超时。
 */
const DOWNLOAD_TIMEOUT_MS = 60_000
const GITHUB_API = process.env.LULUX_GITHUB_API || 'https://api.github.com'
const GITHUB_RAW = process.env.LULUX_GITHUB_RAW || 'https://raw.githubusercontent.com'

function zipLimits() {
  return { maxEntries: SKILL_LIMITS.maxFiles * 4, maxTotalBytes: SKILL_LIMITS.maxTotalBytes, maxFileBytes: SKILL_LIMITS.maxFileBytes }
}

export function packageFromZip(buffer: Buffer, options: { subpath?: string } = {}): SkillPackage {
  if (buffer.length > SKILL_LIMITS.maxArchiveBytes) {
    throw new SkillPackageError(`压缩包过大（> ${Math.round(SKILL_LIMITS.maxArchiveBytes / 1024 / 1024)} MB）`, 'SKILL_TOO_LARGE')
  }
  let entries
  try {
    entries = entriesFromZip(readZip(buffer, zipLimits()))
  } catch (error) {
    if (error instanceof ZipError) throw new SkillPackageError(error.message, error.message.includes('过') ? 'SKILL_TOO_LARGE' : 'SKILL_ZIP_INVALID')
    throw error
  }
  if (options.subpath) {
    const sub = options.subpath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    // 支持 “仓库名-分支/子路径” 或 “子路径” 两种写法
    const filtered = entries.filter((entry) => {
      const path = entry.path.replace(/\\/g, '/')
      return path.startsWith(`${sub}/`) || path.split('/').slice(1).join('/').startsWith(`${sub}/`)
    })
    entries = filtered.map((entry) => {
      const path = entry.path.replace(/\\/g, '/')
      const rel = path.startsWith(`${sub}/`) ? path.slice(sub.length + 1) : path.split('/').slice(1).join('/').slice(sub.length + 1)
      return { ...entry, path: rel }
    })
  }
  return buildPackage(entries)
}

async function download(url: string, maxBytes: number, accept = '*/*'): Promise<{ data: Buffer; contentType: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AppError(400, 'INVALID_URL', '地址格式不正确')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new AppError(400, 'INVALID_URL', '只支持 http/https 地址')
  const guard = process.env.LULUX_SKILLS_ALLOW_PRIVATE_URL !== '1'
  const viaProxy = Boolean(settingsService.get('proxyUrl')?.trim())
  const check = async (target: string): Promise<void> => {
    if (!guard) return
    try {
      await assertPublicHttpUrl(target, { viaProxy })
    } catch (error) {
      throw new AppError(400, 'INVALID_URL', error instanceof Error ? error.message : '不允许访问该地址')
    }
  }
  await check(url)
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  // 手动跟随重定向并逐跳校验（GitHub 的 zipball 会 302 到 codeload）：自动跟随会让公网地址把请求重定向到内网 / 云元数据
  let current = url
  let res: Response | null = null
  for (let hop = 0; ; hop += 1) {
    try {
      res = await fetchWithProxy(
        current,
        { headers: { Accept: accept, 'User-Agent': 'LULUX-ETA-Skills' }, signal, redirect: 'manual' },
        guard ? publicOnlyDispatcher() : undefined,
      )
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(502, 'SKILL_DOWNLOAD_FAILED', `下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) break
    await res.body?.cancel().catch(() => undefined)
    if (hop >= 5) throw new AppError(502, 'SKILL_DOWNLOAD_FAILED', '下载失败：重定向次数过多')
    const next = new URL(location, current)
    if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new AppError(400, 'INVALID_URL', '只支持 http/https 地址')
    current = next.toString()
    await check(current)
  }
  if (!res.ok) throw new AppError(502, 'SKILL_DOWNLOAD_FAILED', `下载失败：HTTP ${res.status}（${url.slice(0, 200)}）`)
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > maxBytes) throw new SkillPackageError('下载内容过大', 'SKILL_TOO_LARGE')
  const reader = res.body?.getReader()
  const chunks: Buffer[] = []
  let total = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new SkillPackageError('下载内容过大', 'SKILL_TOO_LARGE')
      }
      chunks.push(Buffer.from(value))
    }
  }
  return { data: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' }
}

export interface GithubTarget {
  owner: string
  repo: string
  ref: string | null
  path: string
  /** raw.githubusercontent.com/<o>/<r>/<ref>/<path>/SKILL.md 形式 */
  rawFile: boolean
}

/** 识别 GitHub 地址：仓库、tree/blob 目录、raw 文件 */
export function parseGithubUrl(input: string): GithubTarget | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (url.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    return { owner: parts[0]!, repo: parts[1]!, ref: parts[2]!, path: parts.slice(3).join('/'), rawFile: true }
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  if (parts.length < 2) return null
  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/, '')
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    let path = parts.slice(4).join('/')
    if (parts[2] === 'blob' && path.endsWith('SKILL.md')) path = path.slice(0, -'SKILL.md'.length).replace(/\/$/, '')
    return { owner, repo, ref: parts[3]!, path, rawFile: false }
  }
  return { owner, repo, ref: null, path: '', rawFile: false }
}

interface TreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  mode: string
  size?: number
}

/** 用 git trees API 列出目录（一次请求），再从 raw 下载每个文件 */
async function packageFromGithub(target: GithubTarget, subpath?: string): Promise<{ pkg: SkillPackage; origin: string }> {
  const segment = (value: string) => encodeURIComponent(value)
  let ref = target.ref
  if (!ref) {
    const meta = await download(`${GITHUB_API}/repos/${segment(target.owner)}/${segment(target.repo)}`, 1024 * 1024, 'application/vnd.github+json')
    ref = (JSON.parse(meta.data.toString('utf8')) as { default_branch?: string }).default_branch || 'main'
  }
  const dir = [target.path, subpath ?? ''].filter(Boolean).join('/').replace(/^\/+|\/+$/g, '')
  const treeRes = await download(
    `${GITHUB_API}/repos/${segment(target.owner)}/${segment(target.repo)}/git/trees/${segment(ref)}?recursive=1`,
    20 * 1024 * 1024,
    'application/vnd.github+json',
  )
  const tree = JSON.parse(treeRes.data.toString('utf8')) as { tree?: TreeEntry[]; truncated?: boolean }
  const prefix = dir ? `${dir}/` : ''
  const blobs = (tree.tree ?? []).filter((entry) => entry.path.startsWith(prefix) && entry.path !== dir)
  if (blobs.some((entry) => entry.mode === '120000')) {
    const link = blobs.find((entry) => entry.mode === '120000')!
    throw new SkillPackageError(`不允许符号链接：${link.path.slice(prefix.length)}`, 'SKILL_SYMLINK')
  }
  const files = blobs.filter((entry) => entry.type === 'blob')
  if (!files.some((entry) => entry.path === `${prefix}SKILL.md`)) {
    throw new SkillPackageError(`在 ${target.owner}/${target.repo}${dir ? `/${dir}` : ''} 没有找到 SKILL.md`, 'SKILL_MD_MISSING')
  }
  if (files.length > SKILL_LIMITS.maxFiles) throw new SkillPackageError(`文件过多（${files.length}）`, 'SKILL_TOO_LARGE')
  const total = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  if (total > SKILL_LIMITS.maxTotalBytes) throw new SkillPackageError('总大小超过上限', 'SKILL_TOO_LARGE')
  const entries: Array<{ path: string; data: Buffer }> = []
  for (const entry of files) {
    const rel = entry.path.slice(prefix.length)
    const raw = `${GITHUB_RAW}/${segment(target.owner)}/${segment(target.repo)}/${segment(ref)}/${entry.path.split('/').map(segment).join('/')}`
    entries.push({ path: rel, data: (await download(raw, SKILL_LIMITS.maxFileBytes)).data })
  }
  return { pkg: buildPackage(entries), origin: `https://github.com/${target.owner}/${target.repo}/tree/${ref}/${dir}` }
}

/**
 * 从 URL 安装：
 * - GitHub 仓库 / tree 目录（可配 subpath）→ git trees API + raw 下载；
 * - raw 文件地址（…/SKILL.md）→ 只装这一个文件；
 * - 以 .zip 结尾或返回 zip 的地址 → 解压安装（可配 subpath）；
 * - 其他返回 Markdown 的地址 → 当作单文件 SKILL.md。
 */
export async function packageFromUrl(url: string, options: { subpath?: string } = {}): Promise<{ pkg: SkillPackage; origin: string }> {
  const github = parseGithubUrl(url)
  if (github && !github.rawFile) return packageFromGithub(github, options.subpath)
  if (github?.rawFile && !github.path.endsWith('SKILL.md')) {
    // raw 目录地址：按目录处理
    return packageFromGithub({ ...github, rawFile: false }, options.subpath)
  }
  const { data, contentType } = await download(url, SKILL_LIMITS.maxArchiveBytes)
  const looksZip = data.length > 4 && data.readUInt32LE(0) === 0x04034b50
  if (looksZip || /zip/.test(contentType) || /\.zip(\?|$)/i.test(url)) return { pkg: packageFromZip(data, options), origin: url }
  return { pkg: buildPackage([{ path: 'SKILL.md', data }]), origin: url }
}

/** 从本地文件夹导入（仅桌面模式）：必须是绝对路径、目录里有 SKILL.md、不跟随符号链接 */
export function packageFromFolder(path: string): { pkg: SkillPackage; origin: string } {
  if (!path || !isAbsolute(path)) throw new AppError(400, 'VALIDATION_ERROR', '请提供文件夹的绝对路径')
  const dir = resolve(path)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError(400, 'VALIDATION_ERROR', '文件夹不存在')
  const entries = readSkillDirectory(dir)
  const pkg = buildPackage(entries)
  if (pkg.name !== basename(dir) && existsSync(resolve(dir, 'SKILL.md'))) {
    // 目录名与 name 不同也允许（以 name 为准），只是提示
  }
  return { pkg, origin: `folder:${dir}` }
}
