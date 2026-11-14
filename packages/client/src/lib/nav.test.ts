import { describe, expect, it } from 'vitest'
import { NAV_ENTRIES, WHATSAPP_TABS, tabActive, tabsFor } from './nav'

describe('页面分组标签', () => {
  it('客户组 5 个标签，报价标签包含产品库', () => {
    const tabs = tabsFor('quotation')
    expect(tabs.map((t) => t.to)).toEqual(['/prospects', '/customers', '/deals', '/quotation', '/orders'])
    const quote = tabs.find((t) => t.to === '/quotation')!
    expect(tabActive(quote, '/products')).toBe(true)
    expect(tabActive(quote, '/quotation/12')).toBe(true)
    expect(tabActive(quote, '/quotationx')).toBe(false)
  })
  it('邮箱、工作流各两个标签；工作台 / 技能没有标签', () => {
    expect(tabsFor('mailbox').map((t) => t.to)).toEqual(['/mailbox', '/sequences'])
    expect(tabsFor('schedules').map((t) => t.to)).toEqual(['/workflows', '/schedules'])
    expect(tabsFor('workbench')).toEqual([])
    expect(tabsFor('skills')).toEqual([])
  })
  it('WhatsApp 入口没有顶部标签；页内只有会话 / 渠道两个分段，会话只精确匹配 /whatsapp', () => {
    expect(NAV_ENTRIES.map((e) => e.id)).toEqual(['agent', 'workbench', 'customers', 'mailbox', 'whatsapp', 'workflows', 'skills'])
    expect(tabsFor('whatsapp')).toEqual([])
    expect(WHATSAPP_TABS.map((t) => t.to)).toEqual(['/whatsapp', '/whatsapp/channels'])
    const [chats, channels] = WHATSAPP_TABS
    expect(tabActive(chats!, '/whatsapp')).toBe(true)
    expect(tabActive(chats!, '/whatsapp/channels')).toBe(false)
    expect(tabActive(channels!, '/whatsapp/channels')).toBe(true)
  })
})
