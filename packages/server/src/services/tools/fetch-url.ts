import { fetchWithProxy, normalizeProxyUrl } from '../http-client.js'
import { settingsService } from '../settings-service.js'
import { htmlTitle, htmlToText } from './html-text.js'
import { assertPublicHttpUrl, publicOnlyDispatcher } from './net-guard.js'
import { ToolError } from './tool-error.js'

export const FETCH_MAX_BYTES = 2 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5

function proxyConfigured(): boolean {
  try {
    return Boolean(normalizeProxyUrl(settingsService.get('proxyUrl') ?? ''))
  } catch {
    return false
  }
}

async function readLimited(response: Response, limit: number, signal: AbortSignal): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      if (signal.aborted) throw new ToolError('已取消')
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      if (size + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - size))
        size = limit
        truncated = true
        break
      }
      chunks.push(chunk)
      size += chunk.length
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined)
    else reader.releaseLock()
  }
  return { buffer: Buffer.concat(chunks), truncated }
}

function charsetOf(contentType: string): string {
  const match = /charset=([^;]+)/i.exec(contentType)
  return (match?.[1] ?? 'utf-8').trim().replace(/^["']|["']$/g, '').toLowerCase()
}

function decode(buffer: Buffer, contentType: string): string {
  let charset = charsetOf(contentType)
  if (!/charset=/i.test(contentType)) {
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buffer.subarray(0, 4096).toString('latin1'))
    if (meta) charset = meta[1]!.toLowerCase()
  }
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

export interface FetchUrlResult {
  url: string
  finalUrl: string
  status: number
  contentType: string
  title: string
  bytes: number
  truncated: boolean
  text: string
}

/** 抓取网页并转成文本（只 http/https、拒绝内网、手动跟随重定向并逐跳校验、2 MB / 20 秒上限） */
export async function fetchUrl(raw: string, signal: AbortSignal, maxChars = 20_000): Promise<FetchUrlResult> {
  const viaProxy = proxyConfigured()
  let current = await assertPublicHttpUrl(raw, { viaProxy })
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  let response: Response | null = null

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      response = await fetchWithProxy(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: combined,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LULUX-ETA/0.1; +https://github.com/)',
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      }, publicOnlyDispatcher())
    } catch (error) {
      if (signal.aborted) throw new ToolError('已取消')
      if (timeout.aborted) throw new ToolError(`抓取超时（${FETCH_TIMEOUT_MS / 1000} 秒）`)
      const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined
      const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error)
      throw new ToolError(`抓取失败：${detail}`)
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (hop === MAX_REDIRECTS) throw new ToolError(`重定向次数过多（>${MAX_REDIRECTS}）`)
      await response.body?.cancel().catch(() => undefined)
      current = await assertPublicHttpUrl(new URL(response.headers.get('location')!, current).toString(), { viaProxy })
      continue
    }
    break
  }
  if (!response) throw new ToolError('抓取失败')

  const contentType = response.headers.get('content-type') ?? ''
  const textual = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript))/i.test(contentType) || !contentType
  if (!textual) {
    await response.body?.cancel().catch(() => undefined)
    return {
      url: raw,
      finalUrl: current.toString(),
      status: response.status,
      contentType,
      title: '',
      bytes: Number(response.headers.get('content-length') ?? 0),
      truncated: false,
      text: `（非文本内容：${contentType}，未读取）`,
    }
  }

  let body: { buffer: Buffer; truncated: boolean }
  try {
    body = await readLimited(response, FETCH_MAX_BYTES, combined)
  } catch (error) {
    if (signal.aborted) throw new ToolError('已取消')
    if (timeout.aborted) throw new ToolError(`抓取超时（${FETCH_TIMEOUT_MS / 1000} 秒）`)
    throw error
  }
  const decoded = decode(body.buffer, contentType)
  const isHtml = /html/i.test(contentType) || (!contentType && /<html|<!doctype html/i.test(decoded.slice(0, 1000)))
  const title = isHtml ? htmlTitle(decoded) : ''
  let text = isHtml ? htmlToText(decoded, current.toString()) : decoded
  let truncated = body.truncated
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  return { url: raw, finalUrl: current.toString(), status: response.status, contentType, title, bytes: body.buffer.length, truncated, text }
}
