import type Router from '@koa/router'
import { currentActor } from '../context.js'
import { eventBus } from '../services/events.js'
import { openSse, sendSse } from '../utils/sse.js'

export function eventRoutes(router: Router): void {
  router.get('/api/events', (ctx) => {
    const actor = currentActor()
    ctx.respond = false
    openSse(ctx.res)
    const res = ctx.res
    const send = (event: string, payload: unknown): void => sendSse(res, event, payload)
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      clearInterval(timer)
      unsubscribe()
      if (!res.writableEnded) res.end()
    }
    const unsubscribe = eventBus.subscribe({ actor, send, close })
    send('ping', { at: Date.now() })
    const timer = setInterval(() => send('ping', { at: Date.now() }), 25_000)
    timer.unref()
    res.on('close', close)
  })
}
