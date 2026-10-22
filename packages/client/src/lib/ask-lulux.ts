import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import { useAppStore } from '../stores/app'

/**
 * 「问 LULUX」：打开 Agent。
 * - 带客户（客户页）：用一个空会话（当前会话还没有消息就复用，否则新建）并把会话上下文绑定到这个客户；
 * - 带预填文字：进入 Agent 后放进输入框（不自动发送，用户确认后再发）。
 * 都没有时只是跳到 /agent，接着上次的会话。
 */
export async function askLulux(router: Router, opts: { customerId?: string; prompt?: string } = {}): Promise<void> {
  if (!opts.customerId && !opts.prompt) {
    await router.push('/agent')
    return
  }
  const store = useAppStore()
  try {
    if (!store.ready) await store.bootstrap()
    if (!store.currentSessionId || store.messages.length > 0 || store.runs[store.currentSessionId]) {
      await store.newSession()
    }
    if (opts.customerId) await store.setContext({ customerId: opts.customerId, quoteId: null }).catch(() => undefined)
  } catch {
    // 建会话失败（离线 / 无权限）：仍然打开 Agent，由 Agent 页给出提示
  }
  const session = store.currentSessionId
  await router.push(session ? { path: '/agent', query: { session } } : '/agent')
  if (opts.prompt) {
    await nextTick()
    // 输入框监听 failedDraft：只在输入框为空时填入
    store.failedDraft = opts.prompt
  }
}
