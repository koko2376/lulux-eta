import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 商机（Deal）、报价 → 订单、出运、收款与应收、JSON 导出含任务 / 商机 / 订单（docs/API-CONTRACT.md §10.3 §10.7 §10.8） */
let server: TestServer
let customerId = ''

beforeAll(async () => {
  server = await startTestServer()
  customerId = (await server.request('POST', '/api/customers', { body: { company: 'Deal Buyer GmbH', country: 'DE' } })).json.id
}, 90_000)
afterAll(async () => {
  await server?.close()
})

describe('商机 /api/deals', () => {
  it('CRUD、阶段默认概率与加权金额、输单必须填原因、漏斗按金额加权', async () => {
    const a = await server.request('POST', '/api/deals', {
      body: { customerId, title: 'LED 2027 年框', amount: 100000, currency: 'usd', stage: 'proposal', expectedClose: '2099-01-31' },
    })
    expect(a.status, a.text).toBe(201)
    expect(a.json).toMatchObject({ currency: 'USD', probability: 50, weightedAmount: 50000, customerName: 'Deal Buyer GmbH', overdue: false })
    const b = (await server.request('POST', '/api/deals', { body: { customerId, title: '样品单', amount: 2000, currency: 'EUR', stage: 'negotiation', probability: 90 } })).json
    expect(b).toMatchObject({ probability: 90, probabilityOverridden: true, weightedAmount: 1800 })

    const bad = await server.request('PATCH', `/api/deals/${b.id}`, { body: { stage: 'lost' } })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('LOST_REASON_REQUIRED')
    const lost = await server.request('PATCH', `/api/deals/${b.id}`, { body: { stage: 'lost', lostReason: '价格高于越南供应商' } })
    expect(lost.status, lost.text).toBe(200)
    expect(lost.json).toMatchObject({ stage: 'lost', probability: 0, weightedAmount: 0 })
    expect(lost.json.closedAt).toBeTypeOf('number')

    const unknownCustomer = await server.request('POST', '/api/deals', { body: { customerId: 'nope', title: 'x' } })
    expect(unknownCustomer.status).toBe(404)

    const list = await server.request('GET', `/api/deals?stage=open&customerId=${customerId}`)
    expect(list.json.total).toBe(1)
    const stats = (await server.request('GET', '/api/pipeline/stats')).json
    expect(stats.deals.open).toMatchObject({ count: 1, amountByCurrency: { USD: 100000 }, weightedByCurrency: { USD: 50000 } })
    expect(stats.deals.winRate).toBe(0)
    expect(stats.deals.lostReasons).toEqual([{ reason: '价格高于越南供应商', count: 1 }])
    expect(stats.deals.byStage.find((s: any) => s.stage === 'proposal').count).toBe(1)
    // 原有字段保持不变
    expect(stats.funnel).toBeInstanceOf(Array)
    expect(stats.receivables).toMatchObject({ openCount: 0 })

    const activities = (await server.request('GET', `/api/customers/${customerId}/activities`)).json
    expect(activities.some((x: any) => x.content.includes('价格高于越南供应商'))).toBe(true)
    const { db } = await import('../src/db.js')
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'deal.%'").get() as { n: number }).n).toBeGreaterThanOrEqual(3)
    expect((await server.request('DELETE', `/api/deals/${b.id}`)).status).toBe(204)
  })
})

describe('报价 → 订单 → 出运 → 收款', () => {
  it('转订单（报价自动接受、商机赢单）、状态与出运信息、收款与应收余额、逾期应收', async () => {
    const quote = (
      await server.request('POST', '/api/quotes', {
        body: { customerId, currency: 'USD', incoterm: 'FOB', port: 'Ningbo', items: [{ name: 'Valve DN50', qty: 1000, unitPrice: 12.5 }] },
      })
    ).json
    const deal = (await server.request('POST', '/api/deals', { body: { customerId, title: '阀门首单', amount: 12500, quoteId: quote.id, stage: 'negotiation' } })).json

    const empty = (await server.request('POST', '/api/quotes', { body: { customerId } })).json
    expect((await server.request('POST', `/api/quotes/${empty.id}/order`, { body: {} })).json.error.code).toBe('QUOTE_EMPTY')

    const created = await server.request('POST', `/api/quotes/${quote.id}/order`, { body: { depositAmount: 3750, dueDate: '2000-01-15' } })
    expect(created.status, created.text).toBe(201)
    const order = created.json
    expect(order.number).toMatch(/^SO-\d{8}-001$/)
    expect(order).toMatchObject({ status: 'pending_production', currency: 'USD', amount: 12500, paid: 0, balance: 12500, paymentStatus: 'unpaid', dealId: deal.id, quoteNumber: quote.number })
    expect(order.shipment.portOfLoading).toBe('Ningbo')
    expect(order.overdue).toBe(true)
    expect((await server.request('GET', `/api/quotes/${quote.id}`)).json.status).toBe('accepted')
    expect((await server.request('GET', `/api/deals/${deal.id}`)).json).toMatchObject({ stage: 'won', wonReason: `已生成订单 ${order.number}` })
    const again = await server.request('POST', `/api/quotes/${quote.id}/order`, { body: {} })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('ORDER_EXISTS')

    const shipped = await server.request('PATCH', `/api/orders/${order.id}`, {
      body: { status: 'shipped', containerType: "40'HQ", containerNo: 'MSKU1234567', blNo: 'MAEU123456789', etd: '2026-11-01', eta: '2026-12-05' },
    })
    expect(shipped.status, shipped.text).toBe(200)
    expect(shipped.json.shipment).toMatchObject({ containerType: "40'HQ", blNo: 'MAEU123456789', etd: '2026-11-01', eta: '2026-12-05' })
    expect(shipped.json.shippedAt).toBeTypeOf('number')
    expect((await server.request('PATCH', `/api/orders/${order.id}`, { body: { containerType: '99GP' } })).status).toBe(400)
    expect((await server.request('PATCH', `/api/orders/${order.id}`, { body: { etd: '2026/11/01' } })).status).toBe(400)

    const p1 = await server.request('POST', `/api/orders/${order.id}/payments`, { body: { amount: 3750, receivedAt: '2026-10-20', method: 'T/T', reference: 'DEP-1' } })
    expect(p1.status, p1.text).toBe(201)
    expect(p1.json.order).toMatchObject({ paid: 3750, balance: 8750, paymentStatus: 'partial' })
    expect((await server.request('POST', `/api/orders/${order.id}/payments`, { body: { amount: 10, currency: 'EUR' } })).json.error.code).toBe('CURRENCY_MISMATCH')
    expect((await server.request('POST', `/api/orders/${order.id}/payments`, { body: { amount: 9000 } })).json.error.code).toBe('PAYMENT_EXCEEDS_BALANCE')

    const overdue = (await server.request('GET', '/api/receivables?overdue=1')).json
    expect(overdue.total).toBe(1)
    expect(overdue.items[0]).toMatchObject({ id: order.id, balance: 8750 })
    expect(overdue.summary).toMatchObject({ openCount: 1, outstandingByCurrency: { USD: 8750 }, overdueCount: 1 })

    const p2 = (await server.request('POST', `/api/orders/${order.id}/payments`, { body: { amount: 8750 } })).json
    expect(p2.order).toMatchObject({ balance: 0, paymentStatus: 'paid', overdue: false })
    expect((await server.request('GET', '/api/receivables')).json.total).toBe(0)
    const detail = (await server.request('GET', `/api/orders/${order.id}`)).json
    expect(detail.payments).toHaveLength(2)
    expect((await server.request('DELETE', `/api/orders/${order.id}/payments/${p2.payment.id}`)).status).toBe(204)
    expect((await server.request('GET', `/api/orders/${order.id}`)).json.balance).toBe(8750)
    const done = (await server.request('PATCH', `/api/orders/${order.id}`, { body: { status: 'completed' } })).json
    expect(done.completedAt).toBeTypeOf('number')

    const stats = (await server.request('GET', '/api/pipeline/stats')).json
    expect(stats.receivables.outstandingByCurrency).toEqual({ USD: 8750 })
    const { db } = await import('../src/db.js')
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'order.%' OR action LIKE 'payment.%'").all() as Array<{ action: string }>).map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining(['order.create', 'order.update', 'payment.create', 'payment.delete']))
  })
})

describe('JSON 导出 / 导入包含任务、商机、订单与收款', () => {
  it('导出 → 删除 → 导入后恢复', async () => {
    await server.request('POST', '/api/tasks', { body: { title: '催尾款', customerId, dueAt: '2099-01-01' } })
    const exported = (await server.request('GET', '/api/data/export')).json
    expect(exported.tasks.some((t: any) => t.title === '催尾款')).toBe(true)
    expect(exported.deals.length).toBeGreaterThanOrEqual(2)
    expect(exported.orders).toHaveLength(1)
    expect(exported.orders[0].payments).toHaveLength(1)
    const { db } = await import('../src/db.js')
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM deals').run()
    db.prepare('DELETE FROM orders').run()
    const res = await server.request('POST', '/api/data/import', { body: exported })
    expect(res.status, res.text).toBe(200)
    expect(res.json.imported).toMatchObject({ tasks: exported.tasks.length, deals: exported.deals.length, orders: 1, payments: 1 })
    const order = (await server.request('GET', `/api/orders/${exported.orders[0].id}`)).json
    expect(order).toMatchObject({ number: exported.orders[0].number, paid: 3750, balance: 8750 })
    expect((await server.request('GET', '/api/tasks?status=all')).json.items.some((t: any) => t.title === '催尾款')).toBe(true)
  })
})
