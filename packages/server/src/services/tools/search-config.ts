import { db } from '../../db.js'
import { decryptSecret, encryptSecret, previewSecret } from '../../security/secrets.js'

/** 联网搜索服务配置（存 kernel_config，Key 加密，接口不回传明文） */
export type SearchProvider = 'none' | 'tavily' | 'brave' | 'searxng' | 'bing'
export const SEARCH_PROVIDERS: SearchProvider[] = ['none', 'tavily', 'brave', 'searxng', 'bing']

export const SEARCH_DEFAULT_ENDPOINTS: Record<Exclude<SearchProvider, 'none'>, string> = {
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  searxng: '',
  bing: 'https://api.bing.microsoft.com/v7.0/search',
}

export interface SearchConfig {
  provider: SearchProvider
  endpoint: string
  apiKey: string
  maxResults: number
}

export interface PublicSearchConfig {
  provider: SearchProvider
  endpoint: string
  maxResults: number
  hasApiKey: boolean
  apiKeyPreview: string
  apiKeyError: string | null
  /** 是否已可用（web_search 是否会出现在工具列表里） */
  enabled: boolean
  providers: Array<{ id: SearchProvider; name: string; needsKey: boolean; needsEndpoint: boolean; defaultEndpoint: string }>
}

interface Stored {
  provider: SearchProvider
  endpoint: string
  apiKey: string
  maxResults: number
}

const KEY = 'search'

function readStored(): Stored {
  const row = db.prepare('SELECT value FROM kernel_config WHERE key = ?').get(KEY) as unknown as { value: string } | undefined
  if (!row) return { provider: 'none', endpoint: '', apiKey: '', maxResults: 5 }
  try {
    const parsed = JSON.parse(row.value) as Partial<Stored>
    return {
      provider: SEARCH_PROVIDERS.includes(parsed.provider as SearchProvider) ? (parsed.provider as SearchProvider) : 'none',
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      maxResults: typeof parsed.maxResults === 'number' ? parsed.maxResults : 5,
    }
  } catch {
    return { provider: 'none', endpoint: '', apiKey: '', maxResults: 5 }
  }
}

function needsKey(provider: SearchProvider): boolean {
  return provider === 'tavily' || provider === 'brave' || provider === 'bing'
}

export const searchConfigService = {
  get(): SearchConfig & { apiKeyError: string | null } {
    const stored = readStored()
    let apiKey = ''
    let apiKeyError: string | null = null
    if (stored.apiKey) {
      try {
        apiKey = decryptSecret(stored.apiKey)
      } catch {
        apiKeyError = '搜索服务 Key 无法解密（主密钥已变化），请重新填写'
      }
    }
    const endpoint = stored.endpoint || (stored.provider !== 'none' ? SEARCH_DEFAULT_ENDPOINTS[stored.provider] : '')
    return { provider: stored.provider, endpoint, apiKey, maxResults: stored.maxResults, apiKeyError }
  },

  enabled(): boolean {
    const config = searchConfigService.get()
    if (config.provider === 'none' || !config.endpoint) return false
    return !needsKey(config.provider) || Boolean(config.apiKey)
  },

  toPublic(): PublicSearchConfig {
    const config = searchConfigService.get()
    return {
      provider: config.provider,
      endpoint: config.endpoint,
      maxResults: config.maxResults,
      hasApiKey: Boolean(readStored().apiKey),
      apiKeyPreview: config.apiKey ? previewSecret(config.apiKey) : '',
      apiKeyError: config.apiKeyError,
      enabled: searchConfigService.enabled(),
      providers: [
        { id: 'none', name: '不使用联网搜索', needsKey: false, needsEndpoint: false, defaultEndpoint: '' },
        { id: 'tavily', name: 'Tavily', needsKey: true, needsEndpoint: false, defaultEndpoint: SEARCH_DEFAULT_ENDPOINTS.tavily },
        { id: 'brave', name: 'Brave Search', needsKey: true, needsEndpoint: false, defaultEndpoint: SEARCH_DEFAULT_ENDPOINTS.brave },
        { id: 'searxng', name: 'SearXNG（自建）', needsKey: false, needsEndpoint: true, defaultEndpoint: '' },
        { id: 'bing', name: 'Bing Web Search 兼容接口', needsKey: true, needsEndpoint: false, defaultEndpoint: SEARCH_DEFAULT_ENDPOINTS.bing },
      ],
    }
  },

  /** apiKey：undefined 保持原值，'' 清除 */
  update(input: { provider: SearchProvider; endpoint?: string; apiKey?: string; maxResults?: number }): PublicSearchConfig {
    const stored = readStored()
    const next: Stored = {
      provider: input.provider,
      endpoint: input.endpoint !== undefined ? input.endpoint.trim() : input.provider === stored.provider ? stored.endpoint : '',
      apiKey: input.apiKey === undefined ? stored.apiKey : input.apiKey ? encryptSecret(input.apiKey.trim()) : '',
      maxResults: input.maxResults ?? stored.maxResults,
    }
    db.prepare('INSERT INTO kernel_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      KEY,
      JSON.stringify(next),
    )
    return searchConfigService.toPublic()
  },
}
