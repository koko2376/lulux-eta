/**
 * 回归：输入框草稿按会话保存、上传中的附件绑定发起会话、发送被拒退回原文和原附件、
 * 文字 + 图片粘贴、露露的完成状态、输入法组合输入回车。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const uploads: Array<{ sessionId: string; path: string }> = []
const gate: { list: Promise<void> | null } = { list: null }
vi.mock('../api/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/skills')>()
  return {
    ...actual,
    listSessionFiles: vi.fn(async () => {
      if (gate.list) await gate.list
      return []
    }),
    uploadSessionFile: vi.fn(async (sessionId: string, input: { path: string; dataBase64: string }) => {
      uploads.push({ sessionId, path: input.path })
      return { path: input.path, size: 68 }
    }),
    fileToBase64: vi.fn(async () => 'AAAA'),
  }
})
vi.mock('../api/builtin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/builtin')>()
  return {
    ...actual,
    getCapabilities: vi.fn(async () => ({ model: 'm', capabilities: { vision: true }, price: null })),
  }
})

const png = (name: string): File => {
  const f = new File([new Uint8Array(4)], name, { type: 'image/png' })
  Object.defineProperty(f, 'size', { value: 68 })
  return f
}
function transfer(files: File[], types = ['Files'], text = ''): DataTransfer {
  return {
    files,
    items: files.map((f) => ({ kind: 'file', getAsFile: () => f })),
    types,
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  } as unknown as DataTransfer
}
function paste(el: Element, data: DataTransfer): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })
  el.dispatchEvent(event)
  return event
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function setup(spySend = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.ready = true
  store.providers = [{ id: 'p1', name: 'P', kind: 'openai', model: 'm', models: ['m'] } as never]
  store.agents = [{ id: 'builtin', name: 'LULUX', kind: 'builtin', available: true } as never]
  store.sessions = [
    { id: 's1', title: 'a', groupName: null, providerId: 'p1', agentIds: ['builtin'] } as never,
    { id: 's2', title: 'b', groupName: null, providerId: 'p1', agentIds: ['builtin'] } as never,
  ]
  store.currentSessionId = 's1'
  const send = spySend ? vi.spyOn(store, 'send').mockResolvedValue(undefined) : null
  const Composer = (await import('./Composer.vue')).default
  const w = mount(Composer, { global: { plugins: [pinia], stubs: { RouterLink: true } }, attachTo: document.body })
  mounted.push(w)
  return { w, store, send, pinia }
}

const value = (w: Awaited<ReturnType<typeof setup>>['w']): string =>
  (w.find('textarea').element as HTMLTextAreaElement).value
const images = (w: Awaited<ReturnType<typeof setup>>['w']) => w.findAll('[data-testid="composer-image"]')

beforeEach(() => {
  uploads.length = 0
  gate.list = null
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:p'), revokeObjectURL: vi.fn() }))
})

describe('草稿按会话保存', () => {
  it('切会话时各自保存文字和附件，互不串；回车只发当前会话自己的草稿', async () => {
    const { w, store, send } = await setup()
    const ta = w.find('textarea')
    await ta.setValue('给 s1 客户的报价说明')
    paste(ta.element, transfer([png('s1.png')]))
    await flushPromises()
    expect(images(w)).toHaveLength(1)

    store.currentSessionId = 's2'
    await flushPromises()
    expect(value(w)).toBe('')
    expect(images(w)).toHaveLength(0)
    await ta.setValue('s2 的话')

    store.currentSessionId = 's1'
    await flushPromises()
    expect(value(w)).toBe('给 s1 客户的报价说明')
    expect(images(w)).toHaveLength(1)

    store.currentSessionId = 's2'
    await flushPromises()
    expect(value(w)).toBe('s2 的话')
    await ta.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send!.mock.calls[0]![0]).toBe('s2 的话')
    expect(send!.mock.calls[0]![1]?.attachments).toBeUndefined()
  })

  it('离开页面（输入框卸载）再回来，草稿还在', async () => {
    const { w, store, pinia } = await setup()
    await w.find('textarea').setValue('写了一半')
    w.unmount()
    mounted.length = 0
    const Composer = (await import('./Composer.vue')).default
    const again = mount(Composer, {
      global: { plugins: [pinia], stubs: { RouterLink: true } },
      attachTo: document.body,
    })
    mounted.push(again)
    expect((again.find('textarea').element as HTMLTextAreaElement).value).toBe('写了一半')
    expect(store.drafts.s1).toBeUndefined()
  })

  it('上传途中切换会话：附件留在发起的会话，不出现在切过去的会话里', async () => {
    const { w, store } = await setup()
    let open!: () => void
    gate.list = new Promise<void>((r) => (open = r))
    paste(w.find('textarea').element, transfer([png('shot.png')]))
    await flushPromises()
    store.currentSessionId = 's2'
    await flushPromises()
    open()
    await flushPromises()
    expect(uploads).toEqual([{ sessionId: 's1', path: 'uploads/shot.png' }])
    expect(images(w)).toHaveLength(0)
    store.currentSessionId = 's1'
    await flushPromises()
    expect(images(w)).toHaveLength(1)
    expect(images(w)[0].classes()).toContain('done')
  })
})

describe('发送被拒退回草稿', () => {
  it('输入框里是用户原文（没有附件说明），图片附件原样回来', async () => {
    const { w, store } = await setup(false)
    const api = await import('../api')
    vi.spyOn(api, 'streamChatRequest').mockRejectedValue(new api.ApiError('NO_PROVIDER', 'no provider', 400))
    vi.spyOn(api, 'getSession').mockResolvedValue({ session: { id: 's1', running: false }, messages: [] } as never)
    vi.spyOn(api, 'listSessions').mockResolvedValue(store.sessions as never)
    const ta = w.find('textarea')
    paste(ta.element, transfer([png('quote.png')]))
    await flushPromises()
    await ta.setValue('请看这张图')
    await ta.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(value(w)).toBe('请看这张图')
    expect(images(w)).toHaveLength(1)
    // 再发一次，不会叠出第二份附件说明
    vi.mocked(api.streamChatRequest).mockClear()
    await ta.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const [req] = vi.mocked(api.streamChatRequest).mock.calls[0]!
    const content = (req as { content: string }).content
    expect(content.split('uploads/quote.png').length - 1).toBe(1)
  })
})

describe('粘贴', () => {
  it('剪贴板同时有文字和一张图（从表格 / 文档复制）：文字照常粘贴，不上传那张渲染图', async () => {
    const { w } = await setup()
    const event = paste(
      w.find('textarea').element,
      transfer([png('image.png')], ['text/plain', 'text/html', 'Files'], '单价 12.5 USD'),
    )
    expect(event.defaultPrevented).toBe(false)
    await flushPromises()
    expect(uploads).toHaveLength(0)
  })

  it('文字加多个文件：文字照常粘贴，文件也上传', async () => {
    const { w } = await setup()
    const event = paste(
      w.find('textarea').element,
      transfer([png('a.png'), png('b.png')], ['text/plain', 'Files'], '两张图的说明'),
    )
    expect(event.defaultPrevented).toBe(false)
    await flushPromises()
    expect(uploads.map((u) => u.path)).toEqual(['uploads/a.png', 'uploads/b.png'])
  })
})

describe('露露', () => {
  it('从正在生成的会话切到空闲会话：不显示“完成开心”；自己会话的生成结束才开心', async () => {
    const { w, store } = await setup()
    const { default: Lulu } = await import('./LuluMascot.vue')
    store.runs = { s1: { sessionId: 's1', local: true } as never }
    await flushPromises()
    expect(w.findComponent(Lulu).props('state')).toBe('thinking')
    store.currentSessionId = 's2'
    await flushPromises()
    expect(w.findComponent(Lulu).props('state')).toBe('idle')
    store.currentSessionId = 's1'
    await flushPromises()
    expect(w.findComponent(Lulu).props('state')).toBe('thinking')
    store.runs = {}
    await flushPromises()
    expect(w.findComponent(Lulu).props('state')).toBe('happy')
  })
})

describe('输入法组合输入', () => {
  const enter = (el: Element, keyCode = 13): void => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'keyCode', { value: keyCode })
    el.dispatchEvent(event)
  }

  it('上屏回车（keyCode 229）不发送', async () => {
    const { w, send } = await setup()
    const ta = w.find('textarea')
    await ta.setValue('nihao')
    enter(ta.element, 229)
    await flushPromises()
    expect(send).not.toHaveBeenCalled()
  })

  it('先 compositionend 再 keydown(Enter)、isComposing 已为 false：同一轮里不发送，之后的回车照常发送', async () => {
    const { w, send } = await setup()
    const ta = w.find('textarea')
    await ta.setValue('你好')
    ta.element.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.element.dispatchEvent(new CompositionEvent('compositionend'))
    enter(ta.element)
    await flushPromises()
    expect(send).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 5))
    enter(ta.element)
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
