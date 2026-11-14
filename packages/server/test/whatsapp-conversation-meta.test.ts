import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 会话整理（迁移 38）：归档 / 置顶 / 标签 / 计数 / 筛选，以及右侧客户档案（手动关联优先、按号码匹配联系人）。
 */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({
    LULUX_WHATSAPP_ENGINE: 'fake',
    LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS: '10',
  })
  await api('POST', '/api/whatsapp/risk-acceptance')
  await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const s = await api('GET', '/api/whatsapp/status')
    if (s.json.phase === 'connected') break
    await new Promise((r) => setTimeout(r, 20))
  }
}, 90_000)

afterAll(async () => {
  delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
  await server.close()
})

async function api(method: string, path: string, body?: unknown) {
  return server.request(method, path, body === undefined ? {} : { body })
}

async function open(phone: string, displayName: string): Promise<string> {
  const res = await api('POST', '/api/whatsapp/conversations', { phone, displayName })
  expect(res.status, res.text).toBe(201)
  return res.json.id as string
}

describe('WhatsApp 会话整理', () => {
  it('标签、置顶、归档后计数与筛选正确，非法字段被拒', async () => {
    const a = await open('+4915100000101', 'A')
    const b = await open('+4915100000102', 'B')
    const c = await open('+4915100000103', 'C')

    let res = await api('PATCH', `/api/whatsapp/conversations/${a}`, { tags: ['询盘报价', ' 询盘报价 ', '订单物流'] })
    expect(res.status, res.text).toBe(200)
    expect(res.json.tags).toEqual(['询盘报价', '订单物流'])

    res = await api('PATCH', `/api/whatsapp/conversations/${c}`, { pinned: true })
    expect(res.json.pinnedAt).toBeTypeOf('number')
    res = await api('PATCH', `/api/whatsapp/conversations/${b}`, { archived: true })
    expect(res.json.archivedAt).toBeTypeOf('number')

    const list = await api('GET', '/api/whatsapp/conversations')
    const ids = list.json.items.map((x: { id: string }) => x.id)
    expect(ids[0]).toBe(c)
    expect(ids).not.toContain(b)

    const archived = await api('GET', '/api/whatsapp/conversations?filter=archived')
    expect(archived.json.items.map((x: { id: string }) => x.id)).toEqual([b])
    const byTag = await api('GET', `/api/whatsapp/conversations?tag=${encodeURIComponent('订单物流')}`)
    expect(byTag.json.items.map((x: { id: string }) => x.id)).toEqual([a])

    const counts = await api('GET', '/api/whatsapp/conversations/counts')
    expect(counts.status, counts.text).toBe(200)
    expect(counts.json.archived).toBe(1)
    expect(counts.json.all).toBeGreaterThanOrEqual(2)
    expect(counts.json.tags).toEqual(expect.arrayContaining([{ tag: '询盘报价', count: 1 }]))

    res = await api('PATCH', `/api/whatsapp/conversations/${b}`, { archived: false })
    expect(res.json.archivedAt).toBeNull()

    res = await api('PATCH', `/api/whatsapp/conversations/${a}`, { unknown: 1 })
    expect(res.status).toBe(400)
    res = await api('PATCH', '/api/whatsapp/conversations/wac_missing', { pinned: true })
    expect(res.status).toBe(404)
  })

  it('客户档案：号码匹配联系人，手动关联优先，不存在的客户拒绝关联', async () => {
    const created = await api('POST', '/api/customers', {
      company: 'Beichen Sample Procurement',
      country: 'DE',
      contacts: [{ name: 'Lin', whatsapp: '+49 151 0000 0201', isPrimary: true }],
    })
    expect(created.status, created.text).toBe(201)
    const other = await api('POST', '/api/customers', { company: 'Harbor Lighting', country: 'US' })
    const conv = await open('+4915100000201', 'Lin')

    let profile = await api('GET', `/api/whatsapp/conversations/${conv}/profile`)
    expect(profile.status, profile.text).toBe(200)
    expect(profile.json.match).toBe('phone')
    expect(profile.json.customer.id).toBe(created.json.id)
    expect(profile.json.contactId).toBe(created.json.contacts[0].id)

    let res = await api('PATCH', `/api/whatsapp/conversations/${conv}`, { customerId: other.json.id })
    expect(res.status, res.text).toBe(200)
    profile = await api('GET', `/api/whatsapp/conversations/${conv}/profile`)
    expect(profile.json.match).toBe('manual')
    expect(profile.json.customer.id).toBe(other.json.id)

    res = await api('PATCH', `/api/whatsapp/conversations/${conv}`, { customerId: 'cus_missing' })
    expect(res.status).toBe(404)

    const lone = await open('+4915100000999', 'Nobody')
    profile = await api('GET', `/api/whatsapp/conversations/${lone}/profile`)
    expect(profile.json).toMatchObject({ match: null, customer: null, deals: [] })
  })

  it('搜索名称 / 号码，未读优先排序，列表带上匹配到的公司名', async () => {
    const x = await open('+5511987650201', 'Searchable Buyer')
    let res = await api('GET', '/api/whatsapp/conversations?q=Searchable')
    expect(res.json.items.map((i: { id: string }) => i.id)).toEqual([x])
    res = await api('GET', '/api/whatsapp/conversations?q=987650201')
    expect(res.json.items.map((i: { id: string }) => i.id)).toEqual([x])
    res = await api('GET', '/api/whatsapp/conversations?q=%25')
    expect(res.json.items).toEqual([])
    res = await api('GET', '/api/whatsapp/conversations?sort=unread')
    expect(res.status, res.text).toBe(200)
    res = await api('GET', '/api/whatsapp/conversations?sort=oldest')
    expect(res.status).toBe(400)

    const created = await api('POST', '/api/customers', {
      company: 'Search Match GmbH',
      contacts: [{ name: 'Ann', whatsapp: '+55 11 98765 0201', isPrimary: true }],
    })
    expect(created.status, created.text).toBe(201)
    res = await api('GET', '/api/whatsapp/conversations?q=Searchable')
    expect(res.json.items[0].customerName).toBe('Search Match GmbH')
  })

  it('快捷回复：增改删，只能动自己的，字段校验', async () => {
    let res = await api('POST', '/api/whatsapp/quick-replies', { title: '报价确认', body: 'Price confirmed: USD 12.5/pc FOB.' })
    expect(res.status, res.text).toBe(201)
    const id = res.json.id as string
    res = await api('PATCH', `/api/whatsapp/quick-replies/${id}`, { title: '报价确认 v2' })
    expect(res.json.title).toBe('报价确认 v2')
    expect(res.json.body).toBe('Price confirmed: USD 12.5/pc FOB.')
    res = await api('POST', '/api/whatsapp/quick-replies', { title: '', body: 'x' })
    expect(res.status).toBe(400)
    res = await api('PATCH', `/api/whatsapp/quick-replies/${id}`, { owner: 'x' })
    expect(res.status).toBe(400)
    res = await api('GET', '/api/whatsapp/quick-replies')
    expect(res.json.items.map((q: { id: string }) => q.id)).toEqual([id])
    res = await api('DELETE', `/api/whatsapp/quick-replies/${id}`)
    expect(res.status).toBe(204)
    res = await api('DELETE', `/api/whatsapp/quick-replies/${id}`)
    expect(res.status).toBe(404)
  })
})
