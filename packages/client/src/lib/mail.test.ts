import { describe, expect, it } from 'vitest'
import { ApiError, type EmailPreset } from '../api'
import {
  emailErrorText,
  formatAddress,
  mailTime,
  parseAddressList,
  presetForEmail,
  secretLabel,
  sendConfirmMessage,
} from './mail'

const preset = (id: string, domains: string[]): EmailPreset =>
  ({ id, name: id, domains, authTypes: ['password'], oauthProvider: null }) as unknown as EmailPreset

describe('邮箱工具函数', () => {
  it('按邮箱后缀推荐服务商', () => {
    const list = [preset('qq', ['qq.com', 'foxmail.com']), preset('gmail', ['gmail.com'])]
    expect(presetForEmail(list, 'a@Foxmail.com')?.id).toBe('qq')
    expect(presetForEmail(list, 'a@example.com')).toBeNull()
    expect(presetForEmail(list, 'not-an-email')).toBeNull()
  })
  it('密码栏叫法随服务商变化', () => {
    expect(secretLabel(preset('163', []))).toBe('授权码')
    expect(secretLabel(preset('gmail', []))).toBe('应用专用密码')
    expect(secretLabel(null)).toBe('密码')
  })
  it('解析收件人：名字、去重、非法片段', () => {
    const r = parseAddressList('Hans Becker <hans@a.example.com>; hans@a.example.com，lin@b.example.com\nbad@@x')
    expect(r.list).toEqual([
      { name: 'Hans Becker', address: 'hans@a.example.com' },
      { name: '', address: 'lin@b.example.com' },
    ])
    expect(r.invalid).toEqual(['bad@@x'])
    expect(formatAddress(r.list[0])).toBe('Hans Becker <hans@a.example.com>')
  })
  it('发送确认文案完整列出发件人、收件人、抄送、密送与附件', () => {
    const msg = sendConfirmMessage(
      {
        to: [{ name: 'Hans', address: 'hans@a.example.com' }],
        cc: [{ name: '', address: 'cc@a.example.com' }],
        bcc: [{ name: '', address: 'boss@lulux.example.com' }],
        subject: 'Re: RFQ',
        attachments: [{ filename: 'spec.txt' }],
        attachQuotePdf: true,
      },
      'Koko <sales@lulux.example.com>',
    )
    expect(msg).toContain('发件人：Koko <sales@lulux.example.com>')
    expect(msg).toContain('收件人：Hans <hans@a.example.com>')
    expect(msg).toContain('抄送：cc@a.example.com')
    expect(msg).toContain('密送：boss@lulux.example.com')
    expect(msg).toContain('spec.txt、报价单 PDF')
    expect(msg).toContain('无法撤回')
  })
  it('错误码翻译并保留服务商原因', () => {
    expect(emailErrorText(new ApiError('EMAIL_ACCOUNT_EXISTS', 'EMAIL_ACCOUNT_EXISTS', 409))).toBe(
      '这个邮箱已经添加过了',
    )
    expect(emailErrorText(new ApiError('EMAIL_SEND_FAILED', '550 mailbox unavailable', 502))).toContain(
      '550 mailbox unavailable',
    )
    expect(emailErrorText(new ApiError('EMAIL_AUTH_FAILED', '请开启 IMAP 并使用授权码', 400))).toBe(
      '请开启 IMAP 并使用授权码',
    )
  })
  it('列表时间：今天显示时刻，今年显示月日', () => {
    const now = new Date(2026, 9, 20, 15, 0).getTime()
    expect(mailTime(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe('09:05')
    expect(mailTime(new Date(2026, 2, 3).getTime(), now)).toBe('3月3日')
    expect(mailTime(new Date(2025, 0, 2).getTime(), now)).toBe('2025-01-02')
  })
})
