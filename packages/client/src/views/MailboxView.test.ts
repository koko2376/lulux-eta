import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import MailboxView from './MailboxView.vue'

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
// 顶栏铃铛依赖 pinia，与本文件用例无关：模块级替身比按名 stub 稳定
vi.mock('../components/NotificationBell.vue', () => ({
  default: { name: 'NotificationBell', template: '<div />' },
}))

function account(extra: Partial<api.EmailAccount>): api.EmailAccount {
  return {
    id: 'acc1',
    name: 'Mine',
    email: 'me@acme.example.com',
    displayName: '',
    status: { state: 'idle', lastSyncAt: null, lastError: null, lastErrorCode: null, idle: false },
    secretError: null,
    ownerId: 'me',
    ownerName: 'Me',
    visibility: 'private',
    teamId: null,
    ...extra,
  } as api.EmailAccount
}

async function mountWith(accounts: api.EmailAccount[]) {
  vi.spyOn(api, 'listEmailAccounts').mockResolvedValue(accounts)
  const list = vi.spyOn(api, 'listEmailMessages').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(api, 'listEmailDrafts').mockResolvedValue([])
  const w = mount(MailboxView, {
    global: {
      stubs: {
        RouterLink: true,
        CustomerPicker: true,
        MailDraftEditor: true,
        NotificationBell: true,
        SectionTabs: true,
        teleport: true,
      },
    },
  })
  await flushPromises()
  return { w, list }
}

afterEach(() => vi.restoreAllMocks())

describe('邮箱：管理员可查看成员邮箱的提示', () => {
  it('组织开启后，成员在自己的邮箱里看到“管理员可查看此邮箱”', async () => {
    const { w } = await mountWith([account({ adminCanRead: true, contentAccess: 'own' })])
    expect(w.get('[data-testid="mail-admin-notice"]').text()).toContain('管理员可查看此邮箱')
    expect(w.get('[data-testid="acct-admin-visible"]').text()).toBe('管理员可查看此邮箱')
  })

  it('未开启时不显示提示', async () => {
    const { w } = await mountWith([account({ adminCanRead: false, contentAccess: 'own' })])
    expect(w.find('[data-testid="mail-admin-notice"]').exists()).toBe(false)
  })

  it('管理员不能查看的成员邮箱：标“仅可管理”，选中后不请求内容并说明原因', async () => {
    const { w, list } = await mountWith([
      account({ contentAccess: 'own' }),
      account({
        id: 'acc2',
        email: 'alice@acme.example.com',
        ownerId: 'alice',
        ownerName: 'Alice',
        contentAccess: 'restricted',
      }),
    ])
    expect(w.get('[data-testid="acct-restricted"]').text()).toContain('仅可管理')
    list.mockClear()
    const rows = w.findAll('.acct-row button')
    await rows[1]!.trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="mail-restricted"]').text()).toContain('不能查看邮件内容')
    expect(list.mock.calls.some(([q]) => q.accountId === 'acc2')).toBe(false)
  })

  it('管理员查看成员邮箱时提示本次查看会记审计', async () => {
    const { w } = await mountWith([account({ id: 'acc2', ownerName: 'Alice', contentAccess: 'admin' })])
    await w.findAll('.acct-row button')[0]!.trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="mail-admin-reading"]').text()).toContain('Alice')
  })
})

/* ── 正文视图：有 HTML 默认图文、远程图片按邮件放行 ── */
function sampleMessage(extra: Partial<api.EmailMessage> = {}): api.EmailMessage {
  return {
    id: 'm1',
    accountId: 'acc1',
    folder: 'inbox',
    uid: 1,
    messageId: '<m1@example.com>',
    threadKey: 't1',
    from: { name: 'Fictional Buyer', address: 'buyer@example.com' },
    to: [{ name: '', address: 'me@acme.example.com' }],
    cc: [],
    subject: 'Fictional sample',
    date: 0,
    snippet: '',
    seen: true,
    flagged: false,
    hasAttachments: false,
    verdict: null,
    verdictSource: null,
    verdictReason: '',
    matchedRuleId: null,
    customerId: null,
    customerName: null,
    inquiryScore: null,
    inquiryGrade: null,
    createdAt: 0,
    inquiry: null,
    replyTo: [],
    inReplyTo: null,
    references: [],
    text: 'plain fallback',
    hasHtml: true,
    truncated: false,
    remoteImages: { hasRemote: false, allowed: false },
    attachments: [],
    ...extra,
  }
}

function summarize(m: api.EmailMessage): api.EmailMessageSummary {
  const {
    inquiry: _inquiry,
    replyTo: _replyTo,
    inReplyTo: _inReplyTo,
    references: _references,
    text: _text,
    hasHtml: _hasHtml,
    truncated: _truncated,
    remoteImages: _remoteImages,
    attachments: _attachments,
    ...summary
  } = m
  return summary
}

async function mountWithMessage(m: api.EmailMessage, html: string) {
  vi.spyOn(api, 'listEmailAccounts').mockResolvedValue([account({})])
  vi.spyOn(api, 'listEmailMessages').mockResolvedValue({ items: [summarize(m)], total: 1 })
  vi.spyOn(api, 'listEmailDrafts').mockResolvedValue([])
  vi.spyOn(api, 'getEmailMessage').mockResolvedValue(m)
  const htmlSpy = vi.spyOn(api, 'getEmailMessageHtml').mockResolvedValue(html)
  const w = mount(MailboxView, {
    global: {
      stubs: {
        RouterLink: true,
        CustomerPicker: true,
        MailDraftEditor: true,
        NotificationBell: true,
        SectionTabs: true,
        teleport: true,
      },
    },
  })
  await flushPromises()
  return { w, htmlSpy }
}

describe('邮箱：正文默认图文视图', () => {
  it('有 HTML 正文时默认渲染排版正文，而不是纯文本', async () => {
    const { w } = await mountWithMessage(sampleMessage(), '<p>rich body</p>')
    const frame = w.get('iframe.mail-html')
    expect(frame.attributes('srcdoc')).toContain('rich body')
    expect(w.find('pre.mail-text').exists()).toBe(false)
  })

  it('纯文本邮件不请求 HTML 正文', async () => {
    const { w, htmlSpy } = await mountWithMessage(sampleMessage({ hasHtml: false }), '<p>rich</p>')
    expect(htmlSpy).not.toHaveBeenCalled()
    expect(w.get('pre.mail-text').text()).toContain('plain fallback')
    expect(w.find('iframe.mail-html').exists()).toBe(false)
  })

  it('远程图片默认拦截；点“显示远程图片”后持久化并按放行模式重新加载', async () => {
    const { w, htmlSpy } = await mountWithMessage(
      sampleMessage({ remoteImages: { hasRemote: true, allowed: false } }),
      '<p>blocked</p>',
    )
    expect(w.get('.remote-line').text()).toContain('远程图片已拦截')
    const setSpy = vi.spyOn(api, 'setEmailRemoteImages').mockResolvedValue({ allowed: true })
    htmlSpy.mockResolvedValue('<p>remote loaded</p>')

    await w.get('[data-testid="remote-images-toggle"]').trigger('click')
    await flushPromises()

    expect(setSpy).toHaveBeenCalledWith('m1', true)
    expect(htmlSpy).toHaveBeenLastCalledWith('m1', { remote: true })
    expect(w.get('iframe.mail-html').attributes('srcdoc')).toContain('remote loaded')
    expect(w.get('.remote-line').text()).toContain('远程图片经服务器代理加载')
    expect(w.get('[data-testid="remote-images-toggle"]').text()).toContain('隐藏远程图片')
  })
})

describe('邮箱：重新复核后计数刷新', () => {
  it('点“让模型复核”后左栏计数重新拉取，并通知全局侧栏刷新角标', async () => {
    const m = sampleMessage()
    const { w } = await mountWithMessage(m, '<p>x</p>')
    const list = vi.mocked(api.listEmailMessages)
    const { MAIL_COUNTS_EVENT } = await import('../lib/mail-counts')
    const heard = vi.fn()
    window.addEventListener(MAIL_COUNTS_EVENT, heard)
    vi.spyOn(api, 'classifyEmailMessage').mockResolvedValue({ ...m, verdict: 'spam' })
    const before = list.mock.calls.filter((c) => c[0]?.pageSize === 1).length
    await w.get('[data-testid="mail-reclassify"]').trigger('click')
    await flushPromises()
    expect(list.mock.calls.filter((c) => c[0]?.pageSize === 1).length).toBeGreaterThan(before)
    expect(heard).toHaveBeenCalled()
    window.removeEventListener(MAIL_COUNTS_EVENT, heard)
  })
})
