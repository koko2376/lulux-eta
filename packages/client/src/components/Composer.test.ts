import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const uploads: Array<{ path: string }> = []
vi.mock('../api/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/skills')>()
  return {
    ...actual,
    listSessionFiles: vi.fn(async () => []),
    uploadSessionFile: vi.fn(async (_id: string, input: { path: string; dataBase64: string }) => {
      uploads.push({ path: input.path })
      return { path: input.path, size: 68 }
    }),
    fileToBase64: vi.fn(async () => 'AAAA'),
  }
})
const caps = { vision: true }
vi.mock('../api/builtin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/builtin')>()
  return {
    ...actual,
    getCapabilities: vi.fn(async () => ({ model: 'deepseek-chat', capabilities: { ...caps }, price: null })),
  }
})

const longBody = 'x'.repeat(5000)
vi.mock('../api/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/email')>()
  const summary = {
    id: 'm1',
    folder: 'inbox',
    from: { name: 'Jonas Weber', address: 'jonas@nordlicht.de' },
    to: [{ name: '', address: 'sales@example.com' }],
    cc: [],
    subject: 'Ball valve DN50 inquiry',
    date: Date.UTC(2026, 9, 20, 8, 30),
    snippet: 'Please quote',
    customerName: 'Nordlicht Armaturen',
  }
  return {
    ...actual,
    listEmailMessages: vi.fn(async () => ({ items: [summary], total: 1 })),
    getEmailMessage: vi.fn(async () => ({ ...summary, text: longBody, attachments: [] })),
  }
})

const png = (name: string, size = 68): File => {
  const f = new File([new Uint8Array(4)], name, { type: 'image/png' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

/** jsdom 没有 DataTransfer / ClipboardEvent.clipboardData：造一个够用的 */
function transfer(files: File[]): DataTransfer {
  return {
    files,
    items: files.map((f) => ({ kind: 'file', getAsFile: () => f })),
    types: ['Files'],
  } as unknown as DataTransfer
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.ready = true
  store.providers = [
    { id: 'p1', name: 'DeepSeek', kind: 'openai', model: 'deepseek-chat', models: ['deepseek-chat'] } as never,
  ]
  store.agents = [{ id: 'builtin', name: 'LULUX', kind: 'builtin', available: true } as never]
  store.sessions = [{ id: 's1', title: 't', groupName: null, providerId: 'p1', agentIds: ['builtin'] } as never]
  store.currentSessionId = 's1'
  const send = vi.spyOn(store, 'send').mockResolvedValue(undefined)
  const Composer = (await import('./Composer.vue')).default
  const w = mount(Composer, { global: { plugins: [pinia], stubs: { RouterLink: true } }, attachTo: document.body })
  mounted.push(w)
  return { w, store, send }
}

describe('输入框：图片粘贴 / 拖放 / 限制', () => {
  beforeEach(() => {
    uploads.length = 0
    caps.vision = true
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('粘贴截图：上传到 uploads/，显示缩略图；发送时带图片附件（无文字也能发）', async () => {
    const { w, send } = await setup()
    const textarea = w.find('textarea')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer([png('image.png'), png('two.png')]) })
    textarea.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(uploads.map((u) => u.path)).toEqual([
      expect.stringMatching(/^uploads\/pasted-\d{8}-\d{6}\.png$/),
      'uploads/two.png',
    ])
    const thumbs = w.findAll('[data-testid="composer-image"] img')
    expect(thumbs).toHaveLength(2)
    expect(thumbs[0].attributes('src')).toBe('blob:preview')
    // 点击缩略图放大
    await w.find('[data-testid="composer-image"] .composer-thumb-btn').trigger('click')
    expect(document.body.querySelector('[data-testid="image-lightbox"]')).not.toBeNull()
    const send_btn = w.find('.composer-send')
    expect(send_btn.attributes('disabled')).toBeUndefined()
    await send_btn.trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    const [text, options] = send.mock.calls[0]!
    expect(text).toContain('uploads/two.png')
    expect(options!.attachments!.map((a) => [a.kind, a.path, a.mime])).toEqual([
      ['image', uploads[0]!.path, 'image/png'],
      ['image', 'uploads/two.png', 'image/png'],
    ])
    expect(w.findAll('[data-testid="composer-image"]')).toHaveLength(0)
  })

  it('纯文字粘贴不拦截', async () => {
    const { w } = await setup()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], items: [{ kind: 'string' }], types: ['text/plain'] },
    })
    w.find('textarea').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('拖放：显示提示，松开后上传；超过 8 张、超过 10 MB、不支持的格式都提示并跳过', async () => {
    const { w } = await setup()
    const wrap = w.find('.composer-wrap')
    const enter = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(enter, 'dataTransfer', { value: transfer([]) })
    wrap.element.dispatchEvent(enter)
    await flushPromises()
    expect(w.find('.composer-drop-hint').exists()).toBe(true)
    const files = [
      ...Array.from({ length: 9 }, (_, i) => png(`p${i}.png`)),
      png('huge.png', 11 * 1024 * 1024),
      new File([new Uint8Array(2)], 'x.bmp', { type: 'image/bmp' }),
    ]
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: transfer(files) })
    wrap.element.dispatchEvent(drop)
    await flushPromises()
    expect(w.find('.composer-drop-hint').exists()).toBe(false)
    expect(uploads).toHaveLength(8)
    expect(w.findAll('[data-testid="composer-image"]')).toHaveLength(8)
    const { uiState } = await import('../stores/ui')
    const texts = uiState.toasts.map((x) => x.message).join('\n')
    expect(texts).toContain('每条消息最多 8 张图片')
    expect(texts).toContain('图片超过 10 MB：huge.png')
    expect(texts).toContain('不支持的图片格式：x.bmp')
  })

  it('当前模型不支持看图：输入框上方提示，图片以文件路径发送', async () => {
    caps.vision = false
    const { w } = await setup()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer([png('a.png')]) })
    w.find('textarea').element.dispatchEvent(event)
    await flushPromises()
    const note = w.find('[data-testid="composer-vision-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('deepseek-chat 不支持看图')
  })
})

describe('输入框：还没有配置模型', () => {
  afterEach(async () => {
    const { auth } = await import('../lib/session')
    auth.mode = 'desktop'
    auth.me = null
    document.body.innerHTML = ''
  })

  it('有 providers:write：提示去添加', async () => {
    const { auth } = await import('../lib/session')
    auth.mode = 'desktop'
    auth.me = null
    const { w, store } = await setup()
    store.providers = []
    await flushPromises()
    const blocker = w.find('.composer-blocker')
    expect(blocker.text()).toContain('还没有配置模型 Provider')
    expect(blocker.html()).toContain('/settings/models')
  })

  it('云端成员没有 providers:write：请联系管理员，不给去添加的链接', async () => {
    const { auth } = await import('../lib/session')
    auth.mode = 'server'
    auth.me = { mode: 'server', user: { id: 'm', role: 'member' }, permissions: ['data:read', 'data:write'] } as never
    const { w, store } = await setup()
    store.providers = []
    await flushPromises()
    const blocker = w.find('.composer-blocker')
    expect(blocker.text()).toBe('管理员还没有配置模型，请联系管理员')
    expect(blocker.html()).not.toContain('/settings/models')
  })

  it('英文界面同样提示联系管理员', async () => {
    const { auth } = await import('../lib/session')
    const { i18n } = await import('../i18n')
    const g = i18n.global as unknown as { locale: { value: string } }
    auth.mode = 'server'
    auth.me = { mode: 'server', user: { id: 'm', role: 'member' }, permissions: ['data:read'] } as never
    g.locale.value = 'en'
    try {
      const { w, store } = await setup()
      store.providers = []
      await flushPromises()
      expect(w.find('.composer-blocker').text()).toBe(
        "Your administrator hasn't set up a model yet. Please contact your administrator.",
      )
    } finally {
      g.locale.value = 'zh-CN'
    }
  })
})

describe('输入框：“+”添加上下文', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('“+”是添加上下文菜单（不再新建会话）；上传文件并进“+”菜单最后一项；Esc / 点外面关闭', async () => {
    const { w, store } = await setup()
    const newSession = vi.spyOn(store, 'newSession')
    expect(w.find('.composer-attach').exists()).toBe(false)
    const trigger = w.find('[data-testid="composer-add"]')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    await trigger.trigger('click')
    expect(newSession).not.toHaveBeenCalled()
    const items = w.findAll('[role="menuitem"]')
    expect(items.map((i) => i.attributes('data-item'))).toEqual(['customer', 'quote', 'email', 'deal', 'order', 'file'])
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(items[0]!.element)
    // 方向键在菜单项之间移动（循环）
    await w.find('[role="menu"]').trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[5]!.element)
    await w.find('[role="menu"]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(w.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    // 键盘 ↓ 打开
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('[role="menu"]').exists()).toBe(true)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(w.find('[role="menu"]').exists()).toBe(false)
  })

  it('引用邮件：选中后显示一次性标签，下一条消息带上摘要（正文截断），发送后清空', async () => {
    const { w, send } = await setup()
    await w.find('[data-testid="composer-add"]').trigger('click')
    await w.find('[data-item="email"]').trigger('click')
    await flushPromises()
    const option = document.body.querySelector<HTMLButtonElement>('[data-testid="record-picker-email"] .pick')
    expect(option?.textContent).toContain('Ball valve DN50 inquiry')
    option!.click()
    await flushPromises()
    const chip = w.find('[data-testid="composer-ref"]')
    expect(chip.text()).toContain('邮件：Ball valve DN50 inquiry')
    expect(chip.classes()).toContain('once')
    await w.find('textarea').setValue('帮我回复这封询盘')
    await w.find('.composer-send').trigger('click')
    await flushPromises()
    const [text] = send.mock.calls[0]!
    expect(text.startsWith('帮我回复这封询盘\n\n<context kind="email" label="Ball valve DN50 inquiry">')).toBe(true)
    expect(text).toContain('发件人：Jonas Weber <jonas@nordlicht.de>')
    expect(text).toContain('客户：Nordlicht Armaturen')
    expect(text).toContain('（正文已截断，共 5000 字）')
    expect(text).not.toContain('x'.repeat(4001))
    expect(w.find('[data-testid="composer-ref"]').exists()).toBe(false)
  })

  it('会话绑定在输入框里显示为图钉标签，× 解除绑定；内核会话不显示', async () => {
    const { w, store } = await setup()
    const setContext = vi.spyOn(store, 'setContext').mockResolvedValue(undefined)
    store.context = { customerId: 'c1', quoteId: null }
    store.contextNames = { customer: 'Nordlicht Armaturen', quote: '' }
    await flushPromises()
    const pinned = w.find('[data-testid="composer-pinned"]')
    expect(pinned.text()).toContain('客户：Nordlicht Armaturen')
    expect(pinned.classes()).toContain('pinned')
    await pinned.find('button').trigger('click')
    expect(setContext).toHaveBeenCalledWith({ customerId: null, quoteId: null })
    store.agents = [{ id: 'builtin', name: 'Claude Code', kind: 'kernel', available: true } as never]
    await flushPromises()
    expect(w.find('[data-testid="composer-pinned"]').exists()).toBe(false)
    // 一次性引用对内核也适用：菜单仍在
    expect(w.find('[data-testid="composer-add"]').exists()).toBe(true)
  })
})
