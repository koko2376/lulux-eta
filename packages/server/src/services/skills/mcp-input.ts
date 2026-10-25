import { z } from 'zod'

/** 远程 MCP 地址：只允许 http/https，不允许内嵌账号密码 */
export const mcpUrlInput = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    } catch {
      return false
    }
  }, '远程 MCP 地址必须是 http(s) 地址，且不能包含账号密码')

/** 远程 MCP 请求头（如 Authorization）；禁止覆盖协议相关头 */
export const headersInput = z
  .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, '请求头名称不合法'), z.string().max(4000))
  .refine((headers) => Object.keys(headers).length <= 20, '请求头过多')
  .refine(
    (headers) => !Object.keys(headers).some((key) => ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'host', 'content-length'].includes(key.toLowerCase())),
    '不能设置协议保留的请求头',
  )
