import { ZodError } from 'zod'

/**
 * 业务错误：携带 HTTP 状态码与稳定的错误码，错误中间件统一转换为
 * `{ error: { code, message } }`。
 * message 用中文书写；错误中间件按请求语言用 i18n/error-catalog.ts 翻译，
 * params 可显式提供文案里的动态部分（默认从中文原文中提取）；
 * details 是附加给客户端的结构化信息，不参与翻译。
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly params?: Record<string, string | number>,
    /** 附加给客户端的结构化信息（可选），原样放进 error.details */
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what}不存在`)
}

export function badRequest(message: string, code = 'BAD_REQUEST'): AppError {
  return new AppError(400, code, message)
}

export function conflict(message: string, code = 'CONFLICT'): AppError {
  return new AppError(409, code, message)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把 zod 的错误列表压成一句中文提示 */
export function formatZodError(error: ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '请求体'
    return `${path}：${issue.message}`
  })
  return `参数校验失败（${parts.join('；')}）`
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } }
}
