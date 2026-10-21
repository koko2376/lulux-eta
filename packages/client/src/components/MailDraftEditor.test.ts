import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'
import { uiState } from '../stores/ui'
import MailDraftEditor from './MailDraftEditor.vue'

const account = {
  id: 'acc1',
  email: 'sales@lulux.example.com',
  displayName: 'Koko',
} as api.EmailAccount
const draft: api.EmailDraft = {
  id: 'd1',
  accountId: 'acc1',
  replyToMessageId: 'm1',
  customerId: null,
  quoteId: null,
  to: [{ name: 'Hans', address: 'hans@a.example.com' }],
  cc: [],
  bcc: [],
  subject: 'Re: RFQ',
  text: 'Dear Hans',
  attachQuotePdf: false,
  attachments: [],
  source: 'ai',
  ai: { providerName: 'Mock', model: 'mock-gpt' },
  status: 'draft',
  error: null,
  sentAt: null,
  sentMessageId: null,
  ownerId: 'local',
  createdAt: 0,
  updatedAt: 0,
}

describe('MailDraftEditor 发送确认', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listQuotes').mockResolvedValue([])
  })
  afterEach(() => {
    vi.restoreAllMocks()
    uiState.confirm = null
    auth.mode = 'desktop'
    auth.me = null
  })

  it('点击发送先弹出确认框，列出收件人；取消则不发送', async () => {
    const send = vi
      .spyOn(api, 'sendEmailDraft')
      .mockResolvedValue({ draft: { ...draft, status: 'sent' }, message: {} as api.EmailMessage })
    const w = mount(MailDraftEditor, { props: { draft, accounts: [account] } })
    await flushPromises()
    await w.get('[data-testid=draft-send]').trigger('click')
    await flushPromises()
    expect(uiState.confirm?.message).toContain('收件人：Hans <hans@a.example.com>')
    expect(uiState.confirm?.message).toContain('发件人：Koko <sales@lulux.example.com>')
    uiState.confirm?.resolve(false)
    await flushPromises()
    expect(send).not.toHaveBeenCalled()
  })

  it('确认后才调用发送；修改过的内容先保存', async () => {
    const update = vi
      .spyOn(api, 'updateEmailDraft')
      .mockImplementation(async (_id, body) => ({ ...draft, ...body }) as api.EmailDraft)
    const send = vi
      .spyOn(api, 'sendEmailDraft')
      .mockResolvedValue({ draft: { ...draft, status: 'sent' }, message: {} as api.EmailMessage })
    const w = mount(MailDraftEditor, { props: { draft, accounts: [account] } })
    await flushPromises()
    await w.get('textarea[name=text]').setValue('Dear Hans, offer attached.')
    await w.get('[data-testid=draft-send]').trigger('click')
    await flushPromises()
    expect(update).toHaveBeenCalledWith('d1', expect.objectContaining({ text: 'Dear Hans, offer attached.' }))
    uiState.confirm?.resolve(true)
    await flushPromises()
    expect(send).toHaveBeenCalledWith('d1', { confirmSendAs: false })
    expect(w.emitted('sent')).toHaveLength(1)
  })

  it('非法收件人不发送并提示', async () => {
    const send = vi.spyOn(api, 'sendEmailDraft')
    const w = mount(MailDraftEditor, { props: { draft, accounts: [account] } })
    await w.get('input[name=to]').setValue('hans@@bad')
    await w.get('[data-testid=draft-send]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('无法识别的地址')
    expect(uiState.confirm).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('没有 email:send 权限（viewer）时发送按钮禁用', async () => {
    auth.mode = 'server'
    auth.me = { mode: 'server', user: { id: 'v', role: 'viewer' }, permissions: ['data:read'] } as unknown as api.Me
    const w = mount(MailDraftEditor, { props: { draft, accounts: [account] } })
    expect(w.get('[data-testid=draft-send]').attributes('disabled')).toBeDefined()
    expect(w.find('textarea[name=text]').attributes('readonly')).toBeDefined()
  })

  it('已发送草稿只读、不显示发送', () => {
    const w = mount(MailDraftEditor, { props: { draft: { ...draft, status: 'sent' }, accounts: [account] } })
    expect(w.find('[data-testid=draft-send]').exists()).toBe(false)
    expect(w.text()).toContain('已发送')
  })

  it('管理员用成员邮箱发信：单独确认“以成员身份发送”，确认后带 confirmSendAs', async () => {
    const send = vi
      .spyOn(api, 'sendEmailDraft')
      .mockResolvedValue({ draft: { ...draft, status: 'sent' }, message: {} as api.EmailMessage })
    const member = { ...account, ownerName: 'Alice', contentAccess: 'admin' } as api.EmailAccount
    const w = mount(MailDraftEditor, { props: { draft, accounts: [member] } })
    await flushPromises()
    await w.get('[data-testid=draft-send]').trigger('click')
    await flushPromises()
    expect(uiState.confirm?.title).toBe('以成员身份发送？')
    expect(uiState.confirm?.message).toContain('sales@lulux.example.com')
    expect(uiState.confirm?.message).toContain('Alice')
    expect(uiState.confirm?.danger).toBe(true)
    uiState.confirm?.resolve(true)
    await flushPromises()
    expect(send).toHaveBeenCalledWith('d1', { confirmSendAs: true })
  })

  it('服务端要求代发确认（CONFIRM_SEND_AS）时再问一次，取消则不重发', async () => {
    const send = vi
      .spyOn(api, 'sendEmailDraft')
      .mockRejectedValueOnce(new api.ApiError('CONFIRM_SEND_AS', '请确认', 409))
    vi.spyOn(api, 'getEmailDraft').mockResolvedValue(draft)
    const w = mount(MailDraftEditor, { props: { draft, accounts: [account] } })
    await flushPromises()
    await w.get('[data-testid=draft-send]').trigger('click')
    await flushPromises()
    uiState.confirm?.resolve(true)
    await flushPromises()
    expect(uiState.confirm?.title).toBe('以成员身份发送？')
    uiState.confirm?.resolve(false)
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
