import { subscribeEvents, type ServerEvent } from '../api'

/**
 * 全局实时事件（契约 §4.8）。AppLayout 挂载时 start()，各页面 on() 订阅需要的事件。
 * 只维持一条 /api/events 连接。
 */
type Handler = (data: unknown) => void
const handlers = new Map<string, Set<Handler>>()
let stop: (() => void) | null = null

function dispatch(event: ServerEvent): void {
  for (const handler of handlers.get(event.event) ?? []) handler(event.data)
  for (const handler of handlers.get('*') ?? []) handler(event)
}

export function startEvents(): void {
  if (stop) return
  stop = subscribeEvents(dispatch)
}

export function stopEvents(): void {
  stop?.()
  stop = null
}

/** 订阅某个事件，返回取消函数 */
export function onServerEvent(event: string, handler: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set())
  handlers.get(event)!.add(handler)
  return () => handlers.get(event)?.delete(handler)
}

/** 测试用：模拟一条服务端事件 */
export function emitServerEvent(event: string, data: unknown): void {
  dispatch({ event, data })
}
