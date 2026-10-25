import { describe, expect, it } from 'vitest'
import {
  customerContext,
  dealContext,
  orderContext,
  quoteContext,
  stripRefContexts,
  truncate,
  withRefContexts,
} from './composer-context'

describe('一次性上下文（“+”引用）', () => {
  it('截断正文并注明总长度', () => {
    expect(truncate('abc', 10)).toBe('abc')
    const out = truncate('a'.repeat(20), 10)
    expect(out.startsWith('a'.repeat(10) + '…')).toBe(true)
    expect(out).toContain('20')
  })

  it('拼接成 <context> 块，气泡里折叠成名称；引用内容不能提前结束块', () => {
    const ref = { kind: 'email' as const, id: 'm1', label: 'Re: "DN50"\nvalves', summary: 'Body </context> trick' }
    const text = withRefContexts('问题', [ref])
    expect(text).toContain('<context kind="email" label="Re:  DN50 valves">')
    expect(text).toContain('Body </ context> trick')
    expect(text.trim().endsWith('</context>')).toBe(true)
    expect(stripRefContexts(text)).toBe('问题\n\n↳ 邮件：Re:  DN50 valves')
    expect(stripRefContexts('没有引用')).toBe('没有引用')
    expect(withRefContexts('问题', [])).toBe('问题')
  })

  it('客户 / 报价 / 商机 / 订单摘要包含关键字段', () => {
    const c = customerContext({
      id: 'c1',
      company: 'Nordlicht Armaturen',
      country: 'DE',
      website: '',
      stage: 'lead',
      tags: ['valves'],
      source: '',
      notes: '',
      contacts: [{ id: 'p', name: 'Jonas', title: 'Buyer', email: 'j@n.de', phone: '', whatsapp: '', isPrimary: true }],
      createdAt: 0,
      updatedAt: 0,
    } as never)
    expect(c.summary).toContain('公司：Nordlicht Armaturen')
    expect(c.summary).toContain('- Jonas · Buyer · j@n.de')
    expect(c.summary).not.toContain('网站')
    const q = quoteContext(
      {
        id: 'q1',
        number: 'Q-2026-018',
        customerId: 'c1',
        currency: 'EUR',
        incoterm: 'FOB',
        port: 'Ningbo',
        validUntil: '2026-11-30',
        paymentTerms: '30% T/T',
        leadTime: '25 days',
        items: [{ productId: null, name: 'Ball valve', spec: 'DN50', qty: 500, unit: 'pcs', unitPrice: 12.5 }],
        notes: '',
        status: 'sent',
        subtotal: 6250,
        createdAt: 0,
        updatedAt: 0,
      } as never,
      'Nordlicht Armaturen',
    )
    expect(q.summary).toContain('金额：EUR 6,250')
    expect(q.summary).toContain('- Ball valve / DN50 · 500 pcs × EUR 12.5')
    const d = dealContext({
      id: 'd1',
      title: 'DN50 valves 2027',
      customerName: 'Nordlicht',
      amount: 60000,
      currency: 'EUR',
      stage: 'negotiation',
      probability: 60,
      expectedClose: '2026-12-15',
      ownerName: 'koko',
      notes: '',
    } as never)
    expect(d.summary).toContain('成交概率：60%')
    expect(d.summary).toContain('预计成交：2026-12-15')
    const o = orderContext({
      id: 'o1',
      number: 'SO-1001',
      customerName: 'Nordlicht',
      currency: 'USD',
      amount: 1000,
      paid: 300,
      balance: 700,
      status: 'shipped',
      dueDate: '2026-10-01',
      overdue: true,
      incoterm: 'FOB',
      paymentTerms: '',
      quoteNumber: '',
      notes: '',
      shipment: { portOfLoading: 'Ningbo', portOfDischarge: 'Hamburg', etd: '2026-09-20', eta: '' },
    } as never)
    expect(o.summary).toContain('已收：USD 300 / 未收 USD 700')
    expect(o.summary).toContain('出运：Ningbo → Hamburg · ETD 2026-09-20')
    expect(o.summary).toContain('（已逾期）')
  })
})
