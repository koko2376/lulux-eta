import { lookup as dnsCallbackLookup } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { AppError } from '../../errors.js'
import { isPrivateAddress } from '../tools/net-guard.js'
import { DEFAULT_MAX_IMAGE_BYTES, IMAGE_MIME, kindMatchesMime, normalizeImageMime, sniffImage } from './image-type.js'

/**
 * 邮件远程图片代理（SSRF 防护）：
 * - 只允许 http/https；拒绝带用户名/密码的地址与 localhost / .local / .internal 等主机名
 * - 每个请求前解析 DNS，任一地址落在本机、内网、链路本地、组播网段即拒绝
 * - 连接时用 strictLookup 再校验一次实际解析结果，防 DNS rebinding
 * - 重定向逐跳校验（最多 3 跳），任何一跳不合规立即停止
 * - 只接受 PNG / JPEG / GIF / WebP，声明 MIME 必须与文件魔数一致
 * - 单图 4 MB、8 秒超时、全局 4 并发、最多 200 条 / 24 MB 缓存
 * - 不使用用户在设置里配置的出站代理：代理会改变 DNS 解析位置，绕过这里的地址校验
 */

const MAX_BYTES = DEFAULT_MAX_IMAGE_BYTES
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 8_000
const MAX_CONCURRENCY = 4
const QUEUE_WAIT_MS = 3_000
const CACHE_TTL_MS = 10 * 60_000
const NEGATIVE_TTL_MS = 30_000
const CACHE_MAX_ENTRIES = 200
const CACHE_MAX_BYTES = 24 * 1024 * 1024

const ALLOWED_MIME = new Set(Object.values(IMAGE_MIME))

interface CachedImage {
  buffer: Buffer
  contentType: string
  dataUrl: string
  expiresAt: number
}

const cache = new Map<string, CachedImage>()
const negative = new Map<string, { error: AppError; expiresAt: number }>()
let cachedBytes = 0

function cacheGet(url: string): CachedImage | undefined {
  const hit = cache.get(url)
  if (!hit) return undefined
  if (hit.expiresAt <= Date.now()) {
    cache.delete(url)
    cachedBytes -= hit.buffer.length
    return undefined
  }
  // LRU：命中后移到末尾
  cache.delete(url)
  cache.set(url, hit)
  return hit
}

function cacheSet(url: string, image: CachedImage): void {
  const existing = cache.get(url)
  if (existing) {
    cachedBytes -= existing.buffer.length
    cache.delete(url)
  }
  cache.set(url, image)
  cachedBytes += image.buffer.length
  while (cache.size > CACHE_MAX_ENTRIES || cachedBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    const removed = cache.get(oldest)
    cache.delete(oldest)
    if (removed) cachedBytes -= removed.buffer.length
  }
}

/** 单测用：避免缓存影响超时 / 重定向时序 */
export function clearRemoteImageCache(): void {
  cache.clear()
  negative.clear()
  cachedBytes = 0
}

function blocked(message = '该地址指向本机或内网，已拒绝加载'): AppError {
  return new AppError(400, 'IMAGE_URL_BLOCKED', message)
}

/** 校验并返回 URL；只做字面与协议检查，DNS 在请求前单独检查 */
function validateTarget(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError(400, 'IMAGE_URL_INVALID', '远程图片地址格式不正确')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'IMAGE_URL_INVALID', '远程图片只支持 http:// 或 https:// 地址')
  }
  if (url.username || url.password) throw new AppError(400, 'IMAGE_URL_INVALID', '远程图片地址不能包含用户名或密码')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new AppError(400, 'IMAGE_URL_INVALID', '远程图片地址缺少主机名')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host === 'metadata.google.internal'
  ) {
    throw blocked()
  }
  if (isIP(host) && isPrivateAddress(host)) throw blocked()
  return url
}

async function assertPublicDns(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return
  let addresses: Array<{ address: string }>
  try {
    addresses = await dnsLookup(host, { all: true, verbatim: true })
  } catch (error) {
    throw new AppError(502, 'IMAGE_FETCH_FAILED', `无法解析图片域名：${error instanceof Error ? error.message : String(error)}`)
  }
  if (addresses.length === 0) throw new AppError(502, 'IMAGE_FETCH_FAILED', '图片域名没有可用地址')
  if (addresses.some((entry) => isPrivateAddress(entry.address))) throw blocked()
}

/** 连接时再校验，防止校验后 DNS 改指向内网（DNS rebinding） */
const strictLookup: LookupFunction = (hostname, options, callback) => {
  dnsCallbackLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const list = addresses as unknown as Array<{ address: string; family: number }>
    if (list.length === 0) {
      return callback(Object.assign(new Error(`无法解析域名 ${hostname}`), { code: 'ENOTFOUND' }), '', 0)
    }
    if (list.some((entry) => isPrivateAddress(entry.address))) {
      return callback(Object.assign(new Error(`域名 ${hostname} 指向本机或内网地址，已拒绝`), { code: 'EPRIVATEADDR' }), '', 0)
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
    }
    const first = list[0]!
    callback(null, first.address, first.family)
  })
}

const dispatcher = new Agent({ connect: { lookup: strictLookup } })

let active = 0
const waiting: Array<() => void> = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiting.indexOf(grant)
        if (index >= 0) waiting.splice(index, 1)
        reject(new AppError(503, 'IMAGE_PROXY_BUSY', '远程图片加载排队超时，请稍后再试'))
      }, QUEUE_WAIT_MS)
      const grant = (): void => {
        clearTimeout(timer)
        resolve()
      }
      waiting.push(grant)
    })
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

function remaining(deadline: number): number {
  const left = deadline - Date.now()
  if (left <= 0) throw new AppError(504, 'IMAGE_PROXY_TIMEOUT', '远程图片加载超时')
  return left
}

async function readBody(response: Awaited<ReturnType<typeof undiciFetch>>): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new AppError(413, 'IMAGE_TOO_LARGE', '远程图片超过单张大小上限')
  }
  if (!response.body) throw new AppError(502, 'IMAGE_FETCH_FAILED', '远程图片响应为空')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_BYTES) {
        throw new AppError(413, 'IMAGE_TOO_LARGE', '远程图片超过单张大小上限')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

type FetchResult = { redirect: string } | { buffer: Buffer; contentType: string }

async function fetchOnce(url: URL, deadline: number): Promise<FetchResult> {
  await assertPublicDns(url)
  const signal = AbortSignal.timeout(remaining(deadline))
  let response: Awaited<ReturnType<typeof undiciFetch>>
  try {
    response = await undiciFetch(url, {
      dispatcher,
      redirect: 'manual',
      signal,
      headers: {
        accept: 'image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1',
        'user-agent': 'LULUX-ETA/0.1.9 remote-image-proxy',
      },
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
      throw new AppError(504, 'IMAGE_PROXY_TIMEOUT', '远程图片加载超时')
    }
    if ((error as { code?: string })?.code === 'EPRIVATEADDR') throw blocked()
    throw new AppError(502, 'IMAGE_FETCH_FAILED', '远程图片下载失败')
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    return { redirect: location ?? '' }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new AppError(502, 'IMAGE_FETCH_FAILED', `远程图片返回 HTTP ${response.status}`)
  }

  const contentType = normalizeImageMime(response.headers.get('content-type') ?? '')
  if (!ALLOWED_MIME.has(contentType)) {
    await response.body?.cancel().catch(() => undefined)
    throw new AppError(415, 'IMAGE_BAD_TYPE', '远程图片类型不受支持（仅 PNG / JPEG / GIF / WebP）')
  }
  const buffer = await readBody(response)
  if (!buffer.length) throw new AppError(502, 'IMAGE_FETCH_FAILED', '远程图片内容为空')
  const kind = sniffImage(buffer)
  if (!kind || !kindMatchesMime(kind, contentType)) {
    throw new AppError(415, 'IMAGE_BAD_TYPE', '远程图片内容与声明类型不一致，已拒绝')
  }
  return { buffer, contentType: IMAGE_MIME[kind] }
}

async function download(rawUrl: string): Promise<CachedImage> {
  const deadline = Date.now() + TIMEOUT_MS
  let url = validateTarget(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await fetchOnce(url, deadline)
    if (!('redirect' in result)) {
      return {
        buffer: result.buffer,
        contentType: result.contentType,
        dataUrl: `data:${result.contentType};base64,${result.buffer.toString('base64')}`,
        expiresAt: Date.now() + CACHE_TTL_MS,
      }
    }
    const location = result.redirect
    if (!location) throw new AppError(502, 'IMAGE_FETCH_FAILED', '远程图片重定向缺少目标地址')
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw blocked('远程图片重定向地址无效，已拒绝')
    }
    url = validateTarget(next.toString())
    if (hop === MAX_REDIRECTS) break
  }
  throw new AppError(502, 'IMAGE_FETCH_FAILED', '远程图片重定向次数过多')
}

/** 拉取并校验一张远程图片；命中缓存时不重新下载 */
export async function fetchRemoteImage(rawUrl: string): Promise<CachedImage> {
  const key = validateTarget(rawUrl).toString()
  const hit = cacheGet(key)
  if (hit) return hit
  const failed = negative.get(key)
  if (failed && failed.expiresAt > Date.now()) throw failed.error
  try {
    const image = await withSlot(() => download(key))
    cacheSet(key, image)
    negative.delete(key)
    return image
  } catch (error) {
    const appError =
      error instanceof AppError ? error : new AppError(502, 'IMAGE_FETCH_FAILED', '远程图片下载失败')
    // 只缓存可重复的失败（阻塞 / 类型 / 大小 / 超时），不缓存排队繁忙
    if (appError.code !== 'IMAGE_PROXY_BUSY') {
      negative.set(key, { error: appError, expiresAt: Date.now() + NEGATIVE_TTL_MS })
      if (negative.size > CACHE_MAX_ENTRIES) {
        const oldest = negative.keys().next().value as string | undefined
        if (oldest) negative.delete(oldest)
      }
    }
    throw appError
  }
}

/** HTML 渲染用：成功返回 data URL，失败返回 null（保持默认拦截，不破坏正文） */
export async function fetchRemoteImageDataUrl(url: string): Promise<string | null> {
  try {
    return (await fetchRemoteImage(url)).dataUrl
  } catch {
    return null
  }
}

export const remoteImageProxy = {
  fetch: fetchRemoteImage,
  fetchDataUrl: fetchRemoteImageDataUrl,
  clear: clearRemoteImageCache,
  limits: { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, maxRedirects: MAX_REDIRECTS, maxConcurrency: MAX_CONCURRENCY },
}
