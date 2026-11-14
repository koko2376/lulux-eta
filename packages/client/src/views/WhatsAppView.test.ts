import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const apiMock = vi.hoisted(() => ({
  acceptWhatsAppRisk: vi.fn(),
  createWhatsAppConversation: vi.fn(),
  getWhatsAppMessages: vi.fn(),
  listWhatsAppConversations: vi.fn(),
  logoutWhatsApp: vi.fn(),
  markWhatsAppConversationRead: vi.fn(),
  refreshWhatsAppQr: vi.fn(),
  requestWhatsAppPairingCode: vi.fn(),
  retryWhatsAppMessage: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  startWhatsAppLink: vi.fn(),
  stopWhatsAppLink: vi.fn(),
  translateWhatsAppText: vi.fn(),
  getWhatsAppConversationCounts: vi.fn(async () => ({ all: 2, unread: 1, pending: 1, archived: 0, tags: [] })),
  getWhatsAppConversationProfile: vi.fn(async () => ({ match: null, customer: null, contactId: null, deals: [] })),
  updateWhatsAppConversation: vi.fn(),
  listWhatsAppQuickReplies: vi.fn(async () => ({ items: [] as Array<Record<string, unknown>> })),
  createWhatsAppQuickReply: vi.fn(),
  deleteWhatsAppQuickReply: vi.fn(async () => undefined),
}))
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  ...apiMock,
}))
// lib/whatsapp.ts 直接引用 ../api/whatsapp，需要单独 mock 才能拦截会话/消息请求。
vi.mock('../api/whatsapp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/whatsapp')>()),
  ...apiMock,
}))

const clipboardMock = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }))
vi.mock('../lib/clipboard', () => clipboardMock)

// 顶栏会挂通知铃与 Pinia，和本页绑定逻辑无关；只保留页面主体。
vi.mock('../components/ui/PageTopbar.vue', () => ({
  default: { name: 'PageTopbar', template: '<div class="topbar-stub" />' },
}))

import WhatsAppView from './WhatsAppView.vue'
import { resetWhatsAppChats, setWhatsAppStatus, whatsappShell } from '../lib/whatsapp'
import {
  ApiError,
  type WhatsAppAccountInfo,
  type WhatsAppConversation,
  type WhatsAppMessage,
  type WhatsAppPairing,
  type WhatsAppQr,
  type WhatsAppStatus,
  type WhatsAppTranslation,
} from '../api'

const ENGINE = {
  id: 'fake',
  installed: true,
  version: '0.0.0-fake',
  dir: null,
  qrAvailable: true,
  error: null,
} as const

function risk(accepted: boolean) {
  return {
    accepted,
    acceptedAt: accepted ? Date.now() - 60_000 : null,
    expiresAt: accepted ? Date.now() + 30 * 86_400_000 : null,
    version: accepted ? 'v1' : null,
  }
}

function qr(overrides: Partial<WhatsAppQr> = {}): WhatsAppQr {
  const issuedAt = Date.now()
  return {
    dataUrl: 'data:image/png;base64,qr-fixture',
    issuedAt,
    expiresAt: issuedAt + 20_000,
    refreshCount: 0,
    warning: false,
    expired: false,
    ...overrides,
  }
}

function account(overrides: Partial<WhatsAppAccountInfo> = {}): WhatsAppAccountInfo {
  return {
    phone: '8613800138000',
    deviceName: 'LULUX ETA 测试设备',
    platform: 'Chrome',
    linkedAt: Date.now() - 86_400_000,
    lastLoginAt: Date.now() - 3_600_000,
    lastActivityAt: Date.now() - 60_000,
    ...overrides,
  }
}

function pairing(overrides: Partial<WhatsAppPairing> = {}): WhatsAppPairing {
  const issuedAt = Date.now()
  return {
    code: '4K7QM2X9',
    phone: '8613800138000',
    issuedAt,
    expiresAt: issuedAt + 240_000,
    expired: false,
    ...overrides,
  }
}

function status(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return {
    accountId: 'default',
    phase: 'unbound',
    connection: 'disconnected',
    mode: null,
    engine: { ...ENGINE },
    account: null,
    qr: null,
    pairing: null,
    reconnect: null,
    error: null,
    risk: risk(true),
    limits: { linkedDevices: 4, phoneOfflineDays: 14, deviceIdleDays: 30 },
    updatedAt: Date.now(),
    ...overrides,
  }
}

function waitingQr(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return status({ phase: 'waiting_qr', connection: 'connecting', mode: 'qr', qr: qr(), ...overrides })
}

function waitingPairing(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return status({
    phase: 'waiting_pairing',
    connection: 'connecting',
    mode: 'pairing',
    pairing: pairing(),
    ...overrides,
  })
}

function connected(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return status({ phase: 'connected', connection: 'connected', mode: 'qr', account: account(), ...overrides })
}

function conversation(overrides: Partial<WhatsAppConversation> = {}): WhatsAppConversation {
  const now = Date.now()
  return {
    id: 'conv-1',
    remoteJid: '8613800138000@s.whatsapp.net',
    phone: '+8613800138000',
    displayName: '测试客户',
    customerId: null,
    lastMessageAt: now,
    lastMessagePreview: '你好，想了解一下报价',
    lastMessageDirection: 'in',
    unreadCount: 2,
    archivedAt: null,
    pinnedAt: null,
    tags: [],
    createdAt: now - 86_400_000,
    updatedAt: now,
    ...overrides,
  }
}

function message(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  const now = Date.now()
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    direction: 'in',
    type: 'text',
    body: '你好，想了解一下报价',
    status: 'received',
    failureReason: null,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    ...overrides,
  }
}

function translation(overrides: Partial<WhatsAppTranslation> = {}): WhatsAppTranslation {
  return {
    provider: 'fake',
    kind: 'local',
    text: 'Hello, I would like to know the price',
    sourceLang: 'zh-Hans',
    targetLang: 'en',
    requestedTarget: 'en',
    ...overrides,
  }
}

const blank = { template: '<div />' }

async function mountPage(path = '/whatsapp/channels'): Promise<VueWrapper> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: blank },
      { path: '/whatsapp/channels', name: 'whatsapp-channels', component: WhatsAppView, meta: { whatsappTab: 'channels' } },
      { path: '/whatsapp/chats', name: 'whatsapp-chats', component: WhatsAppView, meta: { whatsappTab: 'chats' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(WhatsAppView, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  resetWhatsAppChats()
  clipboardMock.copyText.mockResolvedValue(true)
  apiMock.listWhatsAppConversations.mockResolvedValue({ items: [], total: 0, hasMore: false })
  apiMock.getWhatsAppMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: null })
  apiMock.markWhatsAppConversationRead.mockResolvedValue(conversation({ unreadCount: 0 }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  setWhatsAppStatus(null)
  resetWhatsAppChats()
  whatsappShell.loaded = false
  whatsappShell.loadError = ''
  document.body.innerHTML = ''
})

describe('WhatsAppView 渠道绑定页', () => {
  it('风险未确认时锁住二维码，勾选两项后才能继续并启动扫码', async () => {
    setWhatsAppStatus(status({ risk: risk(false), engine: { ...ENGINE } }))
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-risk-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-qr-locked"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-qr-image"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('我已阅读并理解上述风险，确认由我自行承担使用后果')
    expect(wrapper.text()).toContain('启用 WhatsApp 关联设备前请确认')

    const accept = wrapper.find('[data-testid="whatsapp-risk-accept"]')
    expect(accept.attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="whatsapp-risk-check1"]').setValue(true)
    expect(accept.attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="whatsapp-risk-check2"]').setValue(true)
    expect(accept.attributes('disabled')).toBeUndefined()

    apiMock.acceptWhatsAppRisk.mockResolvedValue(status({ risk: risk(true) }))
    apiMock.startWhatsAppLink.mockResolvedValue(waitingQr())

    await accept.trigger('click')
    await flushPromises()

    expect(apiMock.acceptWhatsAppRisk).toHaveBeenCalledTimes(1)
    expect(apiMock.startWhatsAppLink).toHaveBeenCalledWith('qr')
    expect(wrapper.find('[data-testid="whatsapp-risk-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="whatsapp-risk-accepted"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-qr-locked"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="whatsapp-qr-image"]').attributes('src')).toBe('data:image/png;base64,qr-fixture')
    expect(wrapper.text()).toContain('已确认 ·')
  })

  it('手机号配对：首轮走 link/start，显示分组码与倒计时，支持复制和重新生成', async () => {
    const mountedAt = Date.now()
    const first = status({
      phase: 'waiting_pairing',
      connection: 'connecting',
      mode: 'pairing',
      pairing: pairing({ expiresAt: mountedAt + 221_800 }),
    })
    setWhatsAppStatus(waitingQr())
    apiMock.startWhatsAppLink.mockResolvedValue(first)
    wrapper = await mountPage()

    await wrapper.find('[data-testid="whatsapp-mode-pairing"]').trigger('click')
    expect(wrapper.find('[data-testid="whatsapp-phone-pane"]').exists()).toBe(true)
    await wrapper.find('[data-testid="whatsapp-phone-input"]').setValue('13800138000')
    expect(wrapper.find('[data-testid="whatsapp-generate-code"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('[data-testid="whatsapp-generate-code"]').trigger('click')
    await flushPromises()

    expect(apiMock.startWhatsAppLink).toHaveBeenCalledWith('pairing', '+8613800138000')
    expect(apiMock.requestWhatsAppPairingCode).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="whatsapp-pairing-code"]').text()).toBe('4K7Q M2X9')
    expect(wrapper.text()).toContain('剩余 03:42')
    expect(wrapper.text()).toContain('+8613800138000')
    expect(wrapper.text()).toContain('WhatsApp → 设置 → 已关联的设备 → 用手机号码关联 → 输入该码')

    await wrapper.find('[data-testid="whatsapp-pairing-copy"]').trigger('click')
    await flushPromises()
    expect(clipboardMock.copyText).toHaveBeenCalledWith('4K7QM2X9')

    apiMock.requestWhatsAppPairingCode.mockResolvedValue(
      status({
        phase: 'waiting_pairing',
        connection: 'connecting',
        mode: 'pairing',
        pairing: pairing({ code: '8P2N5R6T' }),
      }),
    )
    await wrapper.find('[data-testid="whatsapp-pairing-regenerate"]').trigger('click')
    await flushPromises()

    expect(apiMock.requestWhatsAppPairingCode).toHaveBeenCalledWith('+8613800138000')
    expect(wrapper.find('[data-testid="whatsapp-pairing-code"]').text()).toBe('8P2N 5R6T')
  })

  it('二维码过期后显示覆盖层，刷新后重新读取服务端二维码', async () => {
    setWhatsAppStatus(waitingQr({ qr: qr({ expired: true, expiresAt: Date.now() - 1_000 }) }))
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-qr-expired"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已过期 · 刷新后重新扫码')

    apiMock.refreshWhatsAppQr.mockResolvedValue(waitingQr())
    await wrapper.find('[data-testid="whatsapp-qr-refresh"]').trigger('click')
    await flushPromises()

    expect(apiMock.refreshWhatsAppQr).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="whatsapp-qr-expired"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="whatsapp-qr-image"]').exists()).toBe(true)
    expect(wrapper.text()).toMatch(/有效期剩余 00:[12]\d/)
  })

  it('已连接时展示账号事实，退出登录需要二次确认勾选', async () => {
    setWhatsAppStatus(connected())
    apiMock.logoutWhatsApp.mockResolvedValue(status())
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-connected"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('+8613800138000')
    expect(wrapper.text()).toContain('LULUX ETA 测试设备')
    expect(wrapper.find('[data-testid="whatsapp-state-pill"]').text()).toBe('已关联')

    await wrapper.find('[data-testid="whatsapp-logout"]').trigger('click')
    await flushPromises()

    const confirm = byTestId('whatsapp-logout-confirm') as HTMLButtonElement | null
    expect(confirm).not.toBeNull()
    expect(confirm!.disabled).toBe(true)
    expect(document.body.textContent).toContain('这会在本机删除 WhatsApp 登录凭据')

    const check = byTestId('whatsapp-logout-check') as HTMLInputElement
    check.checked = true
    check.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(confirm!.disabled).toBe(false)

    confirm!.click()
    await flushPromises()
    expect(apiMock.logoutWhatsApp).toHaveBeenCalledTimes(1)
    expect(byTestId('whatsapp-logout-confirm')).toBeNull()
  })

  it('断线后保持账号历史，并可重新发起同一手机号的配对', async () => {
    setWhatsAppStatus(
      status({
        phase: 'failed',
        connection: 'disconnected',
        mode: 'pairing',
        account: account(),
        error: { code: 'DISCONNECTED', message: 'socket closed' },
      }),
    )
    apiMock.startWhatsAppLink.mockResolvedValue(waitingPairing())
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-disconnected"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-state-pill"]').text()).toBe('已断开')

    await wrapper.find('[data-testid="whatsapp-reconnect-disconnected"]').trigger('click')
    await flushPromises()
    expect(apiMock.startWhatsAppLink).toHaveBeenCalledWith('pairing', '+8613800138000')
  })

  it('被登出时显示重新关联入口，可切到手机号配对', async () => {
    setWhatsAppStatus(
      status({
        phase: 'reauth',
        connection: 'reauth',
        mode: null,
        account: account(),
        error: { code: 'AUTH_LOGGED_OUT', message: 'logged out' },
      }),
    )
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-reauth"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('AUTH_LOGGED_OUT')
    expect(wrapper.find('[data-testid="whatsapp-state-pill"]').text()).toBe('已被登出')
    expect(wrapper.text()).toContain('凭据已失效')
    expect(wrapper.text()).toContain('本机占用名额：0 / 4')

    await wrapper.find('[data-testid="whatsapp-relink-pairing"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="whatsapp-phone-pane"]').exists()).toBe(true)
  })

  it('配对码失败时保留绑定区并显示错误码', async () => {
    setWhatsAppStatus(
      status({
        phase: 'failed',
        connection: 'disconnected',
        mode: 'pairing',
        account: account(),
        pairing: pairing({ expired: true }),
        error: { code: 'PAIRING_CODE_EXPIRED', message: 'expired' },
      }),
    )
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-pairing-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('PAIRING_CODE_EXPIRED')
    expect(wrapper.find('[data-testid="whatsapp-phone-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-state-pill"]').text()).toBe('配对失败')
  })

  it('引擎缺失时明确报错且不显示任何绑定操作', async () => {
    setWhatsAppStatus(
      status({
        risk: risk(false),
        engine: {
          id: 'baileys',
          installed: false,
          version: null,
          dir: null,
          qrAvailable: false,
          error: { code: 'ENGINE_NOT_INSTALLED', message: 'baileys not found' },
        },
      }),
    )
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-engine-missing"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('ENGINE_NOT_INSTALLED')
    expect(wrapper.find('[data-testid="whatsapp-binding"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="whatsapp-risk-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="whatsapp-state-strip"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-tos"]').exists()).toBe(true)
  })

  it('状态读取失败时显示错误与重试，不渲染渠道绑定区', async () => {
    setWhatsAppStatus(null)
    whatsappShell.loadError = 'HTTP 500'
    wrapper = await mountPage()

    expect(wrapper.find('[data-testid="whatsapp-loading"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('无法读取 WhatsApp 状态')
    expect(wrapper.text()).toContain('HTTP 500')
    expect(wrapper.text()).toContain('重试')
    expect(wrapper.find('[data-testid="whatsapp-channels"]').exists()).toBe(false)
  })
})

describe('WhatsAppView 会话页', () => {
  it('从接口加载会话列表，点击会话读取消息并同步已读', async () => {
    const now = Date.now()
    const first = conversation({ lastMessageAt: now, updatedAt: now })
    const second = conversation({
      id: 'conv-2',
      phone: '+8613900139000',
      displayName: '第二位客户',
      lastMessageAt: now - 60_000,
      lastMessagePreview: '收到，谢谢',
      lastMessageDirection: 'out',
      unreadCount: 0,
    })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [first, second], total: 2, hasMore: false })
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()

    expect(apiMock.listWhatsAppConversations).toHaveBeenCalledWith({ limit: 30, offset: 0, filter: 'all', tag: undefined, q: undefined, sort: 'recent' }, true)
    const rows = wrapper.findAll('[data-testid="whatsapp-conversation"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('测试客户')
    expect(rows[0]!.text()).toContain('你好，想了解一下报价')
    expect(rows[1]!.text()).toContain('你：收到，谢谢')
    expect(wrapper.find('[data-testid="whatsapp-unread"]').text()).toBe('2')
    expect(wrapper.find('[data-testid="whatsapp-chat-blank"]').exists()).toBe(true)
    expect(rows[0]!.text()).not.toContain('置顶')

    apiMock.getWhatsAppMessages.mockResolvedValue({
      items: [
        message(),
        message({
          id: 'msg-2',
          direction: 'out',
          status: 'sent',
          body: '好的，稍等',
          createdAt: now,
          updatedAt: now,
        }),
      ],
      hasMore: false,
      nextCursor: null,
    })
    await rows[0]!.trigger('click')
    await flushPromises()

    expect(apiMock.getWhatsAppMessages).toHaveBeenCalledWith('conv-1', { limit: 50, before: null }, true)
    expect(apiMock.markWhatsAppConversationRead).toHaveBeenCalledWith('conv-1', true)
    expect(wrapper.find('[data-testid="whatsapp-active-name"]').text()).toBe('测试客户')
    const bubbles = wrapper.findAll('[data-testid="whatsapp-message"]')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]!.attributes('data-direction')).toBe('in')
    expect(bubbles[1]!.attributes('data-direction')).toBe('out')
    expect(bubbles[1]!.attributes('data-status')).toBe('sent')
    expect(wrapper.find('[data-testid="whatsapp-unread"]').exists()).toBe(false)
  })

  it('在渠道页期间错过入站事件时，切到会话页会补拉空会话列表', async () => {
    // 连接到服务端会让 store 预取一次（此时还没有会话）；随后客户入站消息到得太早，
    // 会话页尚未订阅事件。切到会话页时必须补拉，不能一直停在空列表。
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/channels')
    await flushPromises()
    expect(apiMock.listWhatsAppConversations).toHaveBeenCalledTimes(1)

    apiMock.listWhatsAppConversations.mockResolvedValueOnce({
      items: [conversation({ unreadCount: 1 })],
      total: 1,
      hasMore: false,
    })
    await wrapper.vm.$router.push('/whatsapp/chats')
    await flushPromises()

    expect(apiMock.listWhatsAppConversations).toHaveBeenCalledTimes(2)
    const rows = wrapper.findAll('[data-testid="whatsapp-conversation"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('测试客户')
  })

  it('发送成功后清空输入框并展示已发送气泡', async () => {
    const now = Date.now()
    const conv = conversation({ unreadCount: 0 })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [conv], total: 1, hasMore: false })
    apiMock.markWhatsAppConversationRead.mockResolvedValue(conv)
    apiMock.getWhatsAppMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: null })
    apiMock.sendWhatsAppMessage.mockResolvedValue(
      message({
        id: 'msg-sent',
        direction: 'out',
        status: 'sent',
        body: '你好，报价稍后发您',
        createdAt: now,
        updatedAt: now,
      }),
    )
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()

    const composer = wrapper.find('[data-testid="whatsapp-composer"]')
    await composer.setValue('你好，报价稍后发您')
    expect(wrapper.find('[data-testid="whatsapp-send"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-testid="whatsapp-send"]').trigger('click')
    await flushPromises()

    expect(apiMock.sendWhatsAppMessage).toHaveBeenCalledWith('conv-1', '你好，报价稍后发您')
    expect((composer.element as HTMLTextAreaElement).value).toBe('')
    const bubbles = wrapper.findAll('[data-testid="whatsapp-message"]')
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]!.attributes('data-status')).toBe('sent')
    expect(bubbles[0]!.text()).toContain('已发送')
    expect(wrapper.find('[data-testid="whatsapp-send-error"]').exists()).toBe(false)
  })

  it('发送失败保留失败气泡，可重试同一行消息', async () => {
    const conv = conversation({ unreadCount: 0 })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [conv], total: 1, hasMore: false })
    apiMock.markWhatsAppConversationRead.mockResolvedValue(conv)
    apiMock.getWhatsAppMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: null })
    apiMock.sendWhatsAppMessage.mockRejectedValue(
      new ApiError('WHATSAPP_SEND_FAILED', '发送失败', 502, '', { messageId: 'msg-failed' }),
    )
    apiMock.retryWhatsAppMessage.mockResolvedValue(
      message({
        id: 'msg-failed',
        direction: 'out',
        status: 'sent',
        body: '这条会先失败',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="whatsapp-composer"]').setValue('这条会先失败')
    await wrapper.find('[data-testid="whatsapp-send"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="whatsapp-send-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-composer"]').element).toHaveProperty('value', '')
    const failed = wrapper.find('[data-testid="whatsapp-message"]')
    expect(failed.attributes('data-status')).toBe('failed')
    expect(failed.text()).toContain('发送失败')
    expect(wrapper.find('[data-testid="whatsapp-retry-message"]').exists()).toBe(true)

    await wrapper.find('[data-testid="whatsapp-retry-message"]').trigger('click')
    await flushPromises()

    expect(apiMock.retryWhatsAppMessage).toHaveBeenCalledWith('msg-failed')
    const retried = wrapper.find('[data-testid="whatsapp-message"]')
    expect(retried.attributes('data-status')).toBe('sent')
    expect(wrapper.find('[data-testid="whatsapp-retry-message"]').exists()).toBe(false)
  })

  it('翻译：小框输入母语，译文自动填入主输入框；目标默认 en、auto 可选', async () => {
    const conv = conversation({ unreadCount: 0 })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [conv], total: 1, hasMore: false })
    apiMock.markWhatsAppConversationRead.mockResolvedValue(conv)
    apiMock.getWhatsAppMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: null })
    apiMock.translateWhatsAppText.mockResolvedValue(translation())
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="whatsapp-translate-target"]').exists()).toBe(false)
    await wrapper.find('[data-testid="whatsapp-translate-toggle"]').setValue(true)
    await flushPromises()
    const target = wrapper.find('[data-testid="whatsapp-translate-target"]')
    expect((target.element as HTMLSelectElement).value).toBe('en')
    const values = target.findAll('option').map((option) => (option.element as HTMLOptionElement).value)
    expect(values[0]).toBe('en')
    expect(values).toContain('auto')
    expect(apiMock.translateWhatsAppText).not.toHaveBeenCalled()

    const source = wrapper.find('[data-testid="whatsapp-translate-source"]')
    await source.setValue('你好，想了解一下报价')
    await source.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(apiMock.translateWhatsAppText).toHaveBeenCalledWith(
      { text: '你好，想了解一下报价', targetLang: 'en', conversationId: 'conv-1' },
      false,
    )
    // 译文直接填入主输入框（发出去的是主输入框里的内容）
    expect((wrapper.find('[data-testid="whatsapp-composer"]').element as HTMLTextAreaElement).value).toBe(
      'Hello, I would like to know the price',
    )
    expect(wrapper.find('[data-testid="whatsapp-translation-filled"]').exists()).toBe(true)

    // 手动改了主输入框：不再显示「已填入」
    await wrapper.find('[data-testid="whatsapp-composer"]').setValue('Hello, price please')
    expect(wrapper.find('[data-testid="whatsapp-translation-filled"]').exists()).toBe(false)

    // 关掉翻译：小框消失，主输入框保留
    await wrapper.find('[data-testid="whatsapp-translate-toggle"]').setValue(false)
    await flushPromises()
    expect(wrapper.find('[data-testid="whatsapp-translate-source"]').exists()).toBe(false)
    expect((wrapper.find('[data-testid="whatsapp-composer"]').element as HTMLTextAreaElement).value).toBe('Hello, price please')
  })

  it('翻译引擎缺失时显示错误码与安装指引，不改写原文', async () => {
    const conv = conversation({ unreadCount: 0 })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [conv], total: 1, hasMore: false })
    apiMock.markWhatsAppConversationRead.mockResolvedValue(conv)
    apiMock.getWhatsAppMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: null })
    apiMock.translateWhatsAppText.mockRejectedValue(
      new ApiError('TRANSLATOR_NOT_INSTALLED', '未安装翻译引擎', 503, '', {
        installHint: 'LULUX_WHATSAPP_TRANSLATOR=fake',
      }),
    )
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="whatsapp-composer"]').setValue('原文不能变成译文')
    await wrapper.find('[data-testid="whatsapp-translate-toggle"]').setValue(true)
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-translate-source"]').setValue('要翻译的内容')
    await wrapper.find('[data-testid="whatsapp-translate-source"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const failure = wrapper.find('[data-testid="whatsapp-translation-error"]')
    expect(failure.exists()).toBe(true)
    expect(failure.attributes('data-code')).toBe('TRANSLATOR_NOT_INSTALLED')
    expect(failure.text()).toContain('TRANSLATOR_NOT_INSTALLED')
    expect(failure.text()).toContain('LULUX_WHATSAPP_TRANSLATOR=fake')
    expect(wrapper.find('[data-testid="whatsapp-translation-text"]').exists()).toBe(false)
    expect((wrapper.find('[data-testid="whatsapp-composer"]').element as HTMLTextAreaElement).value).toBe(
      '原文不能变成译文',
    )
  })

  it('已连接但无会话时显示空状态，未连接时显示断线状态', async () => {
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [], total: 0, hasMore: false })
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    expect(wrapper.find('[data-testid="whatsapp-conversation-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-chat-blank"]').exists()).toBe(true)
    wrapper.unmount()
    wrapper = null

    resetWhatsAppChats()
    setWhatsAppStatus(status())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    expect(wrapper.find('[data-testid="whatsapp-chat-blank-offline"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('WhatsApp 未连接')
  })
})

describe('WhatsAppView 会话筛选与整理', () => {
  it('切到待回复走服务端筛选；归档调用整理接口', async () => {
    const first = conversation({ tags: ['询盘报价'] })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [first], total: 1, hasMore: false })
    apiMock.getWhatsAppMessages.mockResolvedValue({ items: [message()], hasMore: false, nextCursor: null })
    apiMock.markWhatsAppConversationRead.mockResolvedValue({ ...first, unreadCount: 0 })
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    expect(wrapper.find('[data-testid="whatsapp-conversation"]').text()).toContain('询盘报价')

    await wrapper.find('[data-testid="whatsapp-tab-pending"]').trigger('click')
    await flushPromises()
    expect(apiMock.listWhatsAppConversations).toHaveBeenLastCalledWith({ limit: 30, offset: 0, filter: 'pending', tag: undefined, q: undefined, sort: 'recent' }, true)

    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()
    apiMock.updateWhatsAppConversation.mockResolvedValue({ ...first, unreadCount: 0, archivedAt: Date.now() })
    expect(wrapper.find('[data-testid="whatsapp-archive"]').exists()).toBe(false)
    await wrapper.find('[data-testid="whatsapp-more"]').trigger('click')
    await wrapper.find('[data-testid="whatsapp-archive"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateWhatsAppConversation).toHaveBeenCalledWith(first.id, { archived: true })
    expect(wrapper.find('[data-testid="whatsapp-profile"]').exists()).toBe(true)
  })
})

describe('WhatsAppView 快捷回复', () => {
  it('左栏列出快捷回复，点击填入输入框；可新增', async () => {
    const conv = conversation({ unreadCount: 0 })
    const qr = { id: 'waq_1', title: '报价确认', body: 'Price confirmed: USD 12.5/pc FOB.', position: 0, createdAt: 1, updatedAt: 1 }
    apiMock.listWhatsAppQuickReplies.mockResolvedValue({ items: [qr] })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [conv], total: 1, hasMore: false })
    apiMock.markWhatsAppConversationRead.mockResolvedValue(conv)
    apiMock.getWhatsAppMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: null })
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()

    const item = wrapper.find('[data-testid="whatsapp-quick-item"]')
    expect(item.text()).toBe('报价确认')
    await item.trigger('click')
    expect((wrapper.find('[data-testid="whatsapp-composer"]').element as HTMLTextAreaElement).value).toBe(qr.body)

    apiMock.createWhatsAppQuickReply.mockResolvedValue({ ...qr, id: 'waq_2', title: '交期说明', body: 'Lead time 25 days.' })
    await wrapper.find('[data-testid="whatsapp-quick-add"]').trigger('click')
    await wrapper.find('[data-testid="whatsapp-quick-title"]').setValue('交期说明')
    await wrapper.find('[data-testid="whatsapp-quick-body"]').setValue('Lead time 25 days.')
    await wrapper.find('[data-testid="whatsapp-quick-form"]').trigger('submit')
    await flushPromises()
    expect(apiMock.createWhatsAppQuickReply).toHaveBeenCalledWith({ title: '交期说明', body: 'Lead time 25 days.' })
    expect(wrapper.findAll('[data-testid="whatsapp-quick-item"]')).toHaveLength(2)
  })
})

describe('WhatsAppView LULUX 草稿', () => {
  async function openWithDraft(text = 'Dear Anna, the price is USD 12.5/pc FOB.') {
    const conv = conversation({ unreadCount: 0, draft: { text, createdAt: Date.now() - 60_000 } })
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [conv], total: 1, hasMore: false })
    apiMock.markWhatsAppConversationRead.mockResolvedValue(conv)
    apiMock.getWhatsAppMessages.mockResolvedValue({ items: [message()], hasMore: false, nextCursor: null })
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()
    return conv
  }

  it('显示草稿卡；使用并编辑：清掉服务端草稿后填入主输入框，不自动发送', async () => {
    const conv = await openWithDraft()
    const card = wrapper!.find('[data-testid="whatsapp-draft"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('Dear Anna, the price is USD 12.5/pc FOB.')
    apiMock.updateWhatsAppConversation.mockResolvedValue({ ...conv, draft: null })
    await wrapper!.find('[data-testid="whatsapp-draft-use"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateWhatsAppConversation).toHaveBeenCalledWith(conv.id, { draft: null })
    expect((wrapper!.find('[data-testid="whatsapp-composer"]').element as HTMLTextAreaElement).value).toBe(
      'Dear Anna, the price is USD 12.5/pc FOB.',
    )
    expect(wrapper!.find('[data-testid="whatsapp-draft"]').exists()).toBe(false)
    expect(apiMock.sendWhatsAppMessage).not.toHaveBeenCalled()
  })

  it('丢弃：PATCH draft:null，草稿卡消失；失败时保留草稿且不改输入框', async () => {
    const conv = await openWithDraft()
    apiMock.updateWhatsAppConversation.mockRejectedValueOnce(new ApiError('INTERNAL', 'boom', 500))
    await wrapper!.find('[data-testid="whatsapp-draft-use"]').trigger('click')
    await flushPromises()
    expect(wrapper!.find('[data-testid="whatsapp-draft"]').exists()).toBe(true)
    expect((wrapper!.find('[data-testid="whatsapp-composer"]').element as HTMLTextAreaElement).value).toBe('')

    apiMock.updateWhatsAppConversation.mockResolvedValue({ ...conv, draft: null })
    await wrapper!.find('[data-testid="whatsapp-draft-dismiss"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateWhatsAppConversation).toHaveBeenLastCalledWith(conv.id, { draft: null })
    expect(wrapper!.find('[data-testid="whatsapp-draft"]').exists()).toBe(false)
    expect(apiMock.sendWhatsAppMessage).not.toHaveBeenCalled()
  })
})

describe('WhatsAppView 客户档案', () => {
  it('只显示已有客户字段（公司 / 国家 / 网站 / 阶段 / 负责人），可取消手动关联', async () => {
    const conv = conversation({ unreadCount: 0, customerId: 'cus_1' })
    apiMock.getWhatsAppConversationProfile.mockResolvedValue({
      match: 'manual',
      customer: {
        id: 'cus_1',
        company: 'Northwind Valves',
        country: 'DE',
        website: 'https://northwind.example.com',
        stage: 'lead',
        tags: ['VIP'],
        source: '',
        notes: '',
        contacts: [{ id: 'ct_1', name: 'Anna', title: 'Buyer', email: 'anna@example.com', phone: '', whatsapp: '+8613800138000', isPrimary: true }],
        createdAt: 1,
        updatedAt: 1,
        ownerName: 'koko',
      },
      contactId: 'ct_1',
      deals: [],
    } as never)
    apiMock.listWhatsAppConversations.mockResolvedValue({ items: [conv], total: 1, hasMore: false })
    apiMock.markWhatsAppConversationRead.mockResolvedValue(conv)
    setWhatsAppStatus(connected())
    wrapper = await mountPage('/whatsapp/chats')
    await flushPromises()
    await wrapper.find('[data-testid="whatsapp-conversation"]').trigger('click')
    await flushPromises()
    const panel = wrapper.find('[data-testid="whatsapp-profile"]')
    expect(panel.find('[data-testid="whatsapp-profile-company"]').text()).toBe('Northwind Valves')
    expect(panel.text()).toContain('https://northwind.example.com')
    expect(panel.text()).toContain('koko')
    expect(panel.text()).toContain('anna@example.com')

    apiMock.updateWhatsAppConversation.mockResolvedValue({ ...conv, customerId: null })
    apiMock.getWhatsAppConversationProfile.mockResolvedValue({ match: null, customer: null, contactId: null, deals: [] })
    await panel.find('.wp-unlink').trigger('click')
    await flushPromises()
    expect(apiMock.updateWhatsAppConversation).toHaveBeenCalledWith(conv.id, { customerId: null })
    expect(wrapper.find('[data-testid="whatsapp-profile-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="whatsapp-profile-link"]').exists()).toBe(true)
  })
})
