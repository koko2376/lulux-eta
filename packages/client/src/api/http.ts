import { i18n, locale, localized, t } from '../i18n'
/**
 * 统一的 fetch 封装（契约 §1）：
 * - 桌面端带 `Authorization: Bearer window.luluxAgent.apiToken`
 * - 浏览器开发态不加头，由 vite dev proxy 读取 <dataDir>/api-token 注入
 * - 错误统一解析为 ApiError（`{ error: { code, message } }`），默认推送全局 toast
 */

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  /** 服务端响应头 X-Request-Id（契约 §10.9），报错时展示给用户便于排查；跨源且服务端未暴露该头时为空 */
  requestId: string
  /** 服务端 error.details（结构化附加信息，如查重命中列表） */
  details?: unknown

  constructor(code: string, message: string, status: number, requestId = '', details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
    if (details !== undefined) this.details = details
  }
}

type ErrorListener = (error: ApiError) => void
const listeners = new Set<ErrorListener>()

/** 订阅未被调用方静默的 API 错误（全局 toast 用） */
export function onApiError(listener: ErrorListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function apiToken(): string | null {
  if (typeof window === 'undefined') return null
  const token = window.luluxAgent?.apiToken
  return typeof token === 'string' && token ? token : null
}

/**
 * 传输层状态（契约 §5.10）：
 * - baseUrl：本地模式 ''（同源）；远程团队服务器如 'https://lulux.example.com'
 * - sessionToken：server 模式登录后的会话 token；优先于桌面端 apiToken
 */
export const transport = {
  baseUrl: '',
  sessionToken: null as string | null,
  /** 本机账户会话（desktop 模式），走 X-Lulux-Session 头；固定 API token 照常放在 Authorization */
  localSession: null as string | null,
}

export function setTransport(next: {
  baseUrl?: string
  sessionToken?: string | null
  localSession?: string | null
}): void {
  if (next.baseUrl !== undefined) transport.baseUrl = next.baseUrl.replace(/\/+$/, '')
  if (next.sessionToken !== undefined) transport.sessionToken = next.sessionToken || null
  if (next.localSession !== undefined) transport.localSession = next.localSession || null
}

/** 把 /api/... 路径拼到当前服务器地址上 */
export function apiUrl(path: string): string {
  return transport.baseUrl && path.startsWith('/') ? transport.baseUrl + path : path
}

/**
 * 界面语言：服务端据此翻译错误文案。Accept-Language 是 CORS 安全头，远程服务器也照发；
 * X-Lulux-Lang 只发给本机服务（旧版团队服务器的预检不放行自定义头）。
 */
export function languageHeaders(): Record<string, string> {
  const lang = locale.value === 'en' ? 'en' : 'zh-CN'
  const headers: Record<string, string> = { 'Accept-Language': lang }
  if (!transport.baseUrl) headers['X-Lulux-Lang'] = lang
  return headers
}

export function authHeaders(): Record<string, string> {
  const token = transport.sessionToken || apiToken()
  const headers: Record<string, string> = { ...languageHeaders() }
  if (token) headers.Authorization = `Bearer ${token}`
  // 本机会话只发给本机服务，绝不带到远程服务器
  if (transport.localSession && !transport.baseUrl) headers['X-Lulux-Session'] = transport.localSession
  return headers
}

type UnauthorizedListener = (error: ApiError) => void
const unauthorizedListeners = new Set<UnauthorizedListener>()
/** 会话失效（401 UNAUTHORIZED / SESSION_EXPIRED）时回调，用于回到登录页 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}
export function notifyUnauthorized(error: ApiError): void {
  for (const listener of unauthorizedListeners) listener(error)
}

type PasswordChangeListener = (error: ApiError) => void
const passwordChangeListeners = new Set<PasswordChangeListener>()
/** 服务端要求先修改密码（403 PASSWORD_CHANGE_REQUIRED）时回调，用于跳到改密页 */
export function onPasswordChangeRequired(listener: PasswordChangeListener): () => void {
  passwordChangeListeners.add(listener)
  return () => passwordChangeListeners.delete(listener)
}

const STATUS_TEXT: Record<number, string> = localized(() => ({
  400: t('apiHttp.k1dxbcaq'),
  401: t('apiHttp.k1p35bg5'),
  403: t('apiHttp.ko4ia1v'),
  404: t('apiHttp.k1u907zs'),
  409: t('apiHttp.k1p38h8h'),
  415: t('apiHttp.k1gtbxdr'),
  500: t('apiHttp.kxe9foz'),
  502: t('apiHttp.k12071u7'),
}))

const CJK = /[\u3400-\u9fff]/

/**
 * 服务端按请求语言返回文案；旧版服务端只会返回中文，英文界面下按错误码换成本地文案，
 * 没有对应文案时保留服务端原文。
 */
export function localizeErrorMessage(code: string, message: string): string {
  if (locale.value !== 'en' || !CJK.test(message)) return message
  const key = `apiErrors.${code}`
  const messages = i18n.global as unknown as { te: (key: string, locale?: string) => boolean }
  return messages.te(key, 'en') ? t(key) : message
}

/** 把任意错误响应体解析成 ApiError；兼容旧服务端的 `{ error: "string" }` */
export function parseErrorBody(status: number, text: string, statusText = ''): ApiError {
  const fallback = STATUS_TEXT[status] || statusText || `HTTP ${status}`
  if (!text) return new ApiError(`HTTP_${status}`, fallback, status)
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    const err = parsed.error
    if (err && typeof err === 'object') {
      const { code, message, details } = err as { code?: unknown; message?: unknown; details?: unknown }
      const errorCode = typeof code === 'string' && code ? code : `HTTP_${status}`
      return new ApiError(
        errorCode,
        typeof message === 'string' && message ? localizeErrorMessage(errorCode, message) : fallback,
        status,
        '',
        details,
      )
    }
    if (typeof err === 'string' && err) return new ApiError(`HTTP_${status}`, err, status)
    if (typeof parsed.message === 'string') return new ApiError(`HTTP_${status}`, parsed.message, status)
  } catch {
    // 非 JSON：HTML 错误页之类，不直接展示原文
  }
  return new ApiError(`HTTP_${status}`, text.length < 200 && !text.includes('<') ? text : fallback, status)
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  signal?: AbortSignal
  /** 为 true 时出错不弹全局 toast，由调用方自己展示 */
  silent?: boolean
  /** 期望返回纯文本（如报价 HTML） */
  text?: boolean
  /** 期望返回二进制（附件、PDF） */
  blob?: boolean
  /** 401 时不触发全局“回到登录页”（登录接口自身） */
  noAuthRedirect?: boolean
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path
}

/** 调用方用 silent 拿到错误后，决定仍按常规展示时调用 */
export function reportApiError(error: ApiError): void {
  for (const listener of listeners) listener(error)
}

function emit(error: ApiError, silent?: boolean): ApiError {
  if (!silent) for (const listener of listeners) listener(error)
  return error
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  let response: Response
  try {
    response = await fetch(apiUrl(buildUrl(path, options.query)), {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: options.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw emit(
      new ApiError(
        'NETWORK',
        transport.baseUrl ? t('apiHttp.k13pk9sx', [transport.baseUrl]) : t('apiHttp.k1mpayr0'),
        0,
      ),
      options.silent,
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = parseErrorBody(response.status, text, response.statusText)
    error.requestId = response.headers?.get?.('X-Request-Id') ?? ''
    if (
      response.status === 401 &&
      !options.noAuthRedirect &&
      (error.code === 'LOCAL_LOGIN_REQUIRED' ||
        ((error.code === 'UNAUTHORIZED' || error.code === 'SESSION_EXPIRED') &&
          (transport.sessionToken || transport.localSession)))
    ) {
      notifyUnauthorized(error)
    }
    if (response.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED') {
      for (const listener of passwordChangeListeners) listener(error)
      // 跳转改密页即可，不再弹“没有权限”之类的提示
      throw error
    }
    throw emit(error, options.silent)
  }
  if (response.status === 204) return undefined as T
  if (options.text) return (await response.text()) as T
  if (options.blob) return (await response.blob()) as T
  const raw = await response.text()
  if (!raw) return undefined as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw emit(new ApiError('BAD_RESPONSE', t('apiHttp.k1s9yyj7'), response.status), options.silent)
  }
}

/**
 * 旧接口返回 `{ providers: [...] }`，契约新接口直接返回数组；两种都接受。
 */
export function unwrapList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

/** `{ provider: {...} }` 或直接返回对象 */
export function unwrapOne<T>(value: unknown, key: string): T {
  if (value && typeof value === 'object' && key in (value as object)) {
    return (value as Record<string, unknown>)[key] as T
  }
  return value as T
}
