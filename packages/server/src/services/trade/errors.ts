import { AppError } from '../../errors.js'

/**
 * 开发客户数据源的统一错误。
 *
 * 数据源（HMRC / UN Comtrade）自己不抛 AppError：Provider 层抛 ProviderError，
 * 路由层用 toAppError() 转成对外的 400 / 429 / 502。中文文案登记在
 * i18n/error-catalog.ts，错误中间件按请求语言翻译。
 */
export type ProviderErrorCode = 'BAD_ARGS' | 'RATE_LIMITED' | 'UPSTREAM' | 'NETWORK'

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    /** 数据源名称，用于拼给用户看的文案，如「英国 HMRC」 */
    readonly provider = '外部数据源',
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Provider 层错误 → HTTP 错误。参数错误 400，限流 429，其余（上游 / 网络）502。 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof ProviderError) {
    if (error.code === 'BAD_ARGS') return new AppError(400, 'BAD_ARGS', error.message)
    if (error.code === 'RATE_LIMITED') {
      return new AppError(429, 'PROVIDER_RATE_LIMITED', `数据源「${error.provider}」请求过于频繁，请稍后再试`)
    }
    return new AppError(502, 'PROVIDER_UPSTREAM', `数据源「${error.provider}」暂时不可用，请稍后再试`)
  }
  return new AppError(502, 'PROVIDER_UPSTREAM', '数据源暂时不可用，请稍后再试')
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
