import { z, ZodError, type ZodType } from 'zod'
import { AppError, formatZodError } from './errors.js'

/** 校验请求体/查询参数，失败抛 400 VALIDATION_ERROR */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {})
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', formatZodError(result.error))
  }
  return result.data
}

export function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError
}

/** 只允许 http/https 的出站地址，禁止 file:、data:、javascript: 等协议 */
export function assertHttpUrl(raw: string, label = '地址'): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new AppError(400, 'INVALID_URL', `${label}格式不正确`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'INVALID_URL', `${label}只支持 http:// 或 https://`)
  }
  if (!url.hostname) {
    throw new AppError(400, 'INVALID_URL', `${label}缺少主机名`)
  }
  return url.toString()
}

export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
    } catch {
      return false
    }
  }, '只支持 http:// 或 https:// 地址')

export const shortText = (max = 200) => z.string().trim().max(max)
export const optionalText = (max = 2000) => z.string().max(max).optional()
