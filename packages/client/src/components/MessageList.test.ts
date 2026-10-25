/**
 * 回归：往上翻看历史时自己发出的消息要滚到底；别人 / 助手的新消息不打断翻看。
 */
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import type { Message } from '../api'

const msg = (id: string, role: 'user' | 'assistant', createdAt = 1): Message =>
  ({ id, sessionId: 's1', role, content: id, senderAgentId: null, toolTrace: [], createdAt }) as Message

async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.sessions = [{ id: 's1', title: 't', agentIds: ['builtin'], kind: 'single' } as never]
  store.currentSessionId = 's1'
  store.messages = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user'))
  const MessageList = (await import('./MessageList.vue')).default
  const w = shallowMount(MessageList, { global: { plugins: [pinia] } })
  await flushPromises()
  const el = w.find('.message-list').element as HTMLElement
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 5000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) })
  // 用户往上翻到顶部
  top = 0
  el.dispatchEvent(new Event('scroll'))
  return { w, store, el, scrollTop: () => top }
}

describe('MessageList 滚动', () => {
  it('翻看历史时自己发消息：强制滚到底', async () => {
    const { store, scrollTop } = await setup()
    store.messages.push(msg(`tmp_${Date.now()}`, 'user', 2))
    await flushPromises()
    expect(scrollTop()).toBe(5000)
  })

  it('翻看历史时收到助手 / 别人的消息：不打断', async () => {
    const { store, scrollTop } = await setup()
    store.messages.push(msg('remote1', 'assistant', 2))
    await flushPromises()
    expect(scrollTop()).toBe(0)
  })
})
