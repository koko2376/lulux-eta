import type { ServerResponse } from 'node:http'
import { errorLangFrom, translateErrorMessage } from '../i18n/error-messages.js'

export function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
}

/** id 给出时写 `id:` 行（会话运行事件的 seq，断线后用 ?after=<seq> 续接） */
export function sendSse(
  res: ServerResponse,
  event: string,
  payload: unknown,
  id?: number,
): void {
  if (res.writableEnded || res.destroyed) return
  if (event === 'error') payload = localizeErrorEvent(res, payload)
  const head = id === undefined ? '' : `id: ${id}\n`
  res.write(`${head}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

/** error 事件的 message 按请求语言翻译（与错误中间件一致） */
function localizeErrorEvent(res: ServerResponse, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const data = payload as { code?: unknown; message?: unknown }
  if (typeof data.message !== 'string' || !res.req) return payload
  const lang = errorLangFrom(res.req.headers)
  if (lang === 'zh') return payload
  const code = typeof data.code === 'string' ? data.code : ''
  const message = translateErrorMessage(code, data.message, lang)
  return message === data.message ? payload : { ...data, message }
}

/** SSE 注释行心跳，防止代理在长时间无输出（等审批 / 内核思考）时断开 */
export function sendSseComment(res: ServerResponse, text = 'ping'): void {
  if (res.writableEnded || res.destroyed) return
  res.write(`: ${text}\n\n`)
}
