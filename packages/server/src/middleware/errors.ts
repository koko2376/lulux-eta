import type Koa from 'koa'
import { AppError, errorBody as rawErrorBody, formatZodError } from '../errors.js'
import { errorLangFrom, translateErrorMessage, translateValidationMessage, type ErrorLang } from '../i18n/error-messages.js'
import { MasterKeyLockedError, SecretUnavailableError } from '../security/secrets.js'
import { isZodError } from '../validation.js'
import { isApiPath } from './auth.js'

interface HttpLikeError {
  status?: number
  statusCode?: number
  expose?: boolean
  type?: string
  message?: string
}

const STATUS_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: '请求格式不正确' },
  404: { code: 'NOT_FOUND', message: '接口不存在' },
  405: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请求体只接受 application/json' },
  501: { code: 'NOT_IMPLEMENTED', message: '未实现' },
}

/**
 * 统一错误格式：`{ error: { code, message, details? } }`。
 * 500 不回传内部异常信息，只记录日志。
 */
export function errorMiddleware(): Koa.Middleware {
  return async (ctx, next) => {
    let lang: ErrorLang | null = null
    /** 按请求语言（X-Lulux-Lang / Accept-Language）翻译错误文案 */
    const errorBody = (code: string, message: string, params?: Record<string, string | number>, details?: unknown) => {
      lang ??= errorLangFrom(ctx.headers)
      const translated =
        (code === 'VALIDATION_ERROR' ? translateValidationMessage(message, lang) : null) ??
        translateErrorMessage(code, message, lang, params)
      return rawErrorBody(code, translated, details)
    }
    try {
      await next()
      // 路由未命中 / 方法不允许时 Koa 只设状态码，这里补上统一错误体
      if (isApiPath(ctx.path) && ctx.respond !== false && ctx.body === undefined && ctx.status >= 400) {
        const status = ctx.status
        const known = STATUS_CODES[status] ?? { code: 'ERROR', message: '请求失败' }
        ctx.body = errorBody(known.code, known.message)
        // Koa 在设置 body 时会把未显式设置的状态改成 200，这里恢复
        ctx.status = status
      }
    } catch (error) {
      if (ctx.headerSent || ctx.respond === false) {
        console.error('[lulux-eta] error after response started', error)
        return
      }
      if (error instanceof AppError) {
        const retryAfter = (error as AppError & { retryAfter?: number }).retryAfter
        if (retryAfter) ctx.set('Retry-After', String(retryAfter))
        ctx.status = error.status
        ctx.body = errorBody(error.code, error.message, error.params, error.details)
        return
      }
      if (isZodError(error)) {
        ctx.status = 400
        ctx.body = errorBody('VALIDATION_ERROR', formatZodError(error))
        return
      }
      if (error instanceof MasterKeyLockedError) {
        ctx.status = 409
        ctx.body = errorBody('MASTER_KEY_LOCKED', error.message)
        return
      }
      if (error instanceof SecretUnavailableError) {
        ctx.status = 409
        ctx.body = errorBody('API_KEY_UNAVAILABLE', error.message)
        return
      }
      const httpError = error as HttpLikeError
      const status = httpError.status ?? httpError.statusCode
      if (status && status >= 400 && status < 500) {
        const known = STATUS_CODES[status] ?? { code: 'BAD_REQUEST', message: '请求格式不正确' }
        ctx.status = status
        const invalidJson =
          status === 400 &&
          (httpError.type === 'entity.parse.failed' || error instanceof SyntaxError || /json/i.test(httpError.message ?? ''))
        ctx.body = invalidJson
          ? errorBody('INVALID_JSON', '请求体不是合法的 JSON')
          : errorBody(known.code, known.message)
        return
      }
      // index.ts 的 captureConsole 会把这条（含脱敏 stack 与 requestId）写进结构化日志
      console.error('[lulux-eta] request failed', error)
      ctx.status = 500
      ctx.body = errorBody('INTERNAL_ERROR', '服务器内部错误')
    }
  }
}
