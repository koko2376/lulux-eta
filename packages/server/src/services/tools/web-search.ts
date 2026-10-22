import { fetchWithProxy } from '../http-client.js'
import { searchConfigService } from './search-config.js'
import { ToolError } from './tool-error.js'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

async function json(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) throw new ToolError(`搜索服务返回 HTTP ${response.status}：${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new ToolError('搜索服务返回的不是 JSON')
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 调用用户配置的搜索服务 */
export async function webSearch(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
  const config = searchConfigService.get()
  if (!searchConfigService.enabled()) throw new ToolError('未配置联网搜索服务')
  const limit = Math.max(1, Math.min(10, count || config.maxResults || 5))
  const combined = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  let response: Response
  try {
    if (config.provider === 'tavily') {
      response = await fetchWithProxy(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
        signal: combined,
      })
      const data = (await json(response)) as { results?: Array<Record<string, unknown>> }
      return (data.results ?? []).slice(0, limit).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }))
    }
    if (config.provider === 'brave') {
      const url = new URL(config.endpoint)
      url.searchParams.set('q', query)
      url.searchParams.set('count', String(limit))
      response = await fetchWithProxy(url.toString(), {
        headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey },
        signal: combined,
      })
      const data = (await json(response)) as { web?: { results?: Array<Record<string, unknown>> } }
      return (data.web?.results ?? []).slice(0, limit).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.description) }))
    }
    if (config.provider === 'searxng') {
      const url = new URL(config.endpoint.replace(/\/+$/, '') + '/search')
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      response = await fetchWithProxy(url.toString(), { headers: { Accept: 'application/json' }, signal: combined })
      const data = (await json(response)) as { results?: Array<Record<string, unknown>> }
      return (data.results ?? []).slice(0, limit).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }))
    }
    // bing 兼容
    const url = new URL(config.endpoint)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(limit))
    response = await fetchWithProxy(url.toString(), {
      headers: { 'Ocp-Apim-Subscription-Key': config.apiKey },
      signal: combined,
    })
    const data = (await json(response)) as { webPages?: { value?: Array<Record<string, unknown>> } }
    return (data.webPages?.value ?? []).slice(0, limit).map((r) => ({ title: str(r.name), url: str(r.url), snippet: str(r.snippet) }))
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (signal.aborted) throw new ToolError('已取消')
    throw new ToolError(`搜索失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
