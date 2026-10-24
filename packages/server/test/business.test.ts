import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
})
afterAll(() => server.close())

const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })

describe('客户 Customers', () => {
  let id = ''

  it('创建：校验 + 默认值 + 主联系人', async () => {
    expect((await api('POST', '/api/customers', { company: '' })).status).toBe(400)
    expect((await api('POST', '/api/customers', { company: 'A', stage: 'bogus' })).status).toBe(400)
    expect((await api('POST', '/api/customers', { company: 'A', contacts: [{ email: 'not-an-email' }] })).status).toBe(400)

    const res = await api('POST', '/api/customers', {
      company: 'Acme Trading Ltd',
      country: 'DE',
      website: 'https://www.acme.de/en',
      tags: ['valve', 'Valve', 'EU'],
      contacts: [
        { name: 'Hans', email: 'Hans@Acme.de' },
        { name: 'Eva', email: 'eva@acme.de', isPrimary: true },
      ],
    })
    expect(res.status).toBe(201)
    id = res.json.id
    expect(res.json).toMatchObject({ company: 'Acme Trading Ltd', stage: 'lead', tags: ['valve', 'EU'] })
    expect(res.json.contacts.map((c: { email: string; isPrimary: boolean }) => [c.email, c.isPrimary])).toEqual([
      ['hans@acme.de', false],
      ['eva@acme.de', true],
    ])
  })

  it('查询 / 筛选 / 分页', async () => {
    await api('POST', '/api/customers', { company: 'Beta Pumps', stage: 'quoted', tags: ['pump'] })
    await api('POST', '/api/customers', { company: 'Gamma Locks', stage: 'quoted', tags: ['lock'] })
    const all = await server.request('GET', '/api/customers')
    expect(all.json.total).toBe(3)
    expect((await server.request('GET', '/api/customers?stage=quoted')).json.total).toBe(2)
    expect((await server.request('GET', '/api/customers?tag=VALVE')).json.items[0].id).toBe(id)
    expect((await server.request('GET', '/api/customers?query=eva%40acme')).json.total).toBe(1)
    expect((await server.request('GET', '/api/customers?query=100%25')).json.total).toBe(0)
    const page = await server.request('GET', '/api/customers?page=2&pageSize=2')
    expect(page.json.items).toHaveLength(1)
    expect(page.json.total).toBe(3)
    expect((await server.request('GET', '/api/customers?pageSize=999')).status).toBe(400)
  })

  it('列表：最近跟进 / 下次跟进、国家筛选、侧栏 facets', async () => {
    const c = await api('POST', '/api/customers', { company: 'Facet Fjord AS', country: 'Norway', tags: ['fjord'] })
    expect(c.status).toBe(201)
    const fresh = (await server.request('GET', '/api/customers?country=norway')).json
    expect(fresh.items.map((x: { company: string }) => x.company)).toEqual(['Facet Fjord AS'])
    expect(fresh.items[0]).toMatchObject({ lastTouchAt: null, nextTask: null })
    await api('POST', `/api/customers/${c.json.id}/activities`, { type: 'note', content: '电话沟通' })
    await api('POST', '/api/tasks', { title: '寄样', customerId: c.json.id, dueAt: Date.now() - 86_400_000 })
    await api('POST', '/api/tasks', { title: '回访', customerId: c.json.id, dueAt: Date.now() + 86_400_000 })
    const row = (await server.request('GET', '/api/customers?country=Norway')).json.items[0]
    expect(row.lastTouchAt).toEqual(expect.any(Number))
    expect(row.nextTask).toMatchObject({ title: '寄样', overdue: true })
    const facets = (await server.request('GET', '/api/customers/facets')).json
    expect(facets.total).toBeGreaterThan(0)
    expect(facets.newThisMonth).toBeGreaterThan(0)
    expect(facets.countries).toContainEqual({ value: 'Norway', count: 1 })
    expect(facets.tags).toContainEqual({ value: 'fjord', count: 1 })
    expect(facets.owners[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) })
    await api('DELETE', `/api/customers/${c.json.id}`)
  })

  it('读取 / 修改 / 未知字段拒绝 / 404', async () => {
    expect((await server.request('GET', `/api/customers/${id}`)).json.company).toBe('Acme Trading Ltd')
    const patched = await api('PATCH', `/api/customers/${id}`, { stage: 'contacted', notes: '展会认识' })
    expect(patched.json).toMatchObject({ stage: 'contacted', notes: '展会认识' })
    expect(patched.json.contacts).toHaveLength(2)
    expect((await api('PATCH', `/api/customers/${id}`, { hacker: 1 })).status).toBe(400)
    expect((await server.request('GET', '/api/customers/cus_missing')).status).toBe(404)
  })

  it('跟进记录', async () => {
    expect((await api('POST', `/api/customers/${id}/activities`, { type: 'fax', content: 'x' })).status).toBe(400)
    const created = await api('POST', `/api/customers/${id}/activities`, { type: 'call', content: '电话沟通交期' })
    expect(created.status).toBe(201)
    const list = await server.request('GET', `/api/customers/${id}/activities`)
    expect(list.json[0]).toMatchObject({ type: 'call', content: '电话沟通交期', customerId: id })
  })

  it('删除级联联系人与跟进', async () => {
    const tmp = await api('POST', '/api/customers', { company: 'Temp', contacts: [{ name: 'x' }] })
    await api('POST', `/api/customers/${tmp.json.id}/activities`, { type: 'note', content: 'n' })
    expect((await server.request('DELETE', `/api/customers/${tmp.json.id}`)).status).toBe(204)
    expect((await server.request('GET', `/api/customers/${tmp.json.id}/activities`)).status).toBe(404)
    expect((await server.request('DELETE', `/api/customers/${tmp.json.id}`)).status).toBe(404)
  })
})

describe('客户导入与去重', () => {
  const mapping = { company: 'Company', contactEmail: 'Email', website: 'Site', tags: 'Tags', contactName: 'Name' }

  it('按邮箱去重：skip / merge / 批内去重 / 错误行', async () => {
    const rows = [
      { Company: 'Delta GmbH', Email: 'buyer@delta.de', Site: 'delta.de', Tags: 'new,eu', Name: 'Tom' },
      { Company: 'Delta Duplicate', Email: 'BUYER@delta.de', Site: '', Tags: 'vip', Name: 'Tom' },
      { Company: '', Email: 'x@y.z', Site: '', Tags: '', Name: '' },
      { Company: 'Bad Email Co', Email: 'oops', Site: '', Tags: '', Name: '' },
    ]
    const skip = await api('POST', '/api/customers/import', { rows, mapping, dedupeBy: 'email', onDuplicate: 'skip' })
    expect(skip.status).toBe(200)
    expect(skip.json).toMatchObject({ created: 1, merged: 0, skipped: 1 })
    expect(skip.json.errors.map((e: { row: number }) => e.row)).toEqual([3, 4])

    const merge = await api('POST', '/api/customers/import', { rows: rows.slice(1, 2), mapping, dedupeBy: 'email', onDuplicate: 'merge' })
    expect(merge.json).toMatchObject({ created: 0, merged: 1, skipped: 0 })
    const found = await server.request('GET', '/api/customers?query=delta')
    expect(found.json.total).toBe(1)
    expect(found.json.items[0].tags).toEqual(['new', 'eu', 'vip'])
    expect(found.json.items[0].contacts).toHaveLength(1)
  })

  it('按公司名（忽略大小写空白）与网站域名去重', async () => {
    const byCompany = await api('POST', '/api/customers/import', {
      rows: [{ Company: '  delta   gmbh ' }, { Company: 'Epsilon Inc' }],
      mapping,
      dedupeBy: 'company',
      onDuplicate: 'skip',
    })
    expect(byCompany.json).toMatchObject({ created: 1, skipped: 1 })

    const bySite = await api('POST', '/api/customers/import', {
      rows: [{ Company: 'Delta Again', Site: 'https://www.DELTA.de/contact' }],
      mapping,
      dedupeBy: 'website',
      onDuplicate: 'skip',
    })
    expect(bySite.json).toMatchObject({ created: 0, skipped: 1 })
  })

  it('参数校验', async () => {
    expect((await api('POST', '/api/customers/import', { rows: [], mapping: {}, dedupeBy: 'phone', onDuplicate: 'skip' })).status).toBe(400)
    expect((await api('POST', '/api/customers/import', { rows: [], mapping: { evil: 'x' }, dedupeBy: 'email', onDuplicate: 'skip' })).status).toBe(400)
  })
})

describe('产品、报价模板、报价', () => {
  let productId = ''
  let customerId = ''
  let quoteId = ''

  it('产品 CRUD', async () => {
    expect((await api('POST', '/api/products', { name: 'Valve', price: -1 })).status).toBe(400)
    expect((await api('POST', '/api/products', { name: 'Valve', currency: 'dollars' })).status).toBe(400)
    const created = await api('POST', '/api/products', {
      sku: 'BV-25', name: 'Ball valve DN25', spec: 'PN16 brass', unit: 'pcs', price: 3.2, currency: 'usd', moq: 500, hsCode: '8481.80',
    })
    expect(created.status).toBe(201)
    expect(created.json.currency).toBe('USD')
    productId = created.json.id
    expect((await api('PATCH', `/api/products/${productId}`, { price: 3.5 })).json.price).toBe(3.5)
    expect((await server.request('GET', '/api/products')).json).toHaveLength(1)
    const tmp = await api('POST', '/api/products', { name: 'tmp' })
    expect((await server.request('DELETE', `/api/products/${tmp.json.id}`)).status).toBe(204)
    expect((await api('PATCH', `/api/products/${tmp.json.id}`, { price: 1 })).status).toBe(404)
  })

  it('报价模板：默认模板唯一、logo 只收位图 data URL', async () => {
    expect(
      (await api('POST', '/api/quote-templates', { name: 'x', company: { logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } })).status,
    ).toBe(400)
    const a = await api('POST', '/api/quote-templates', {
      name: 'Default',
      company: { name: 'Wenzhou Valve Co.', address: 'Example Industrial Park', phone: '+86', email: 'sales@wv.cn', logoDataUrl: '' },
      defaultIncoterm: 'CIF',
      defaultCurrency: 'EUR',
      defaultPaymentTerms: '30% T/T deposit',
      footer: 'Thank you <b>!</b>',
    })
    expect(a.status).toBe(201)
    expect(a.json.isDefault).toBe(true)
    const b = await api('POST', '/api/quote-templates', { name: 'Second', isDefault: true })
    const list = await server.request('GET', '/api/quote-templates')
    expect(list.json.filter((t: { isDefault: boolean }) => t.isDefault).map((t: { id: string }) => t.id)).toEqual([b.json.id])
    await api('PATCH', `/api/quote-templates/${a.json.id}`, { isDefault: true })
    expect((await server.request('DELETE', `/api/quote-templates/${b.json.id}`)).status).toBe(204)
  })

  it('报价：模板默认值、自动单号、小计、客户跟进', async () => {
    const customer = await api('POST', '/api/customers', { company: 'Quote <Script> Buyer', contacts: [{ name: 'Ann', email: 'ann@b.com' }] })
    customerId = customer.json.id
    expect((await api('POST', '/api/quotes', { customerId: 'cus_missing' })).status).toBe(400)
    expect((await api('POST', '/api/quotes', { customerId, incoterm: 'XYZ' })).status).toBe(400)
    expect((await api('POST', '/api/quotes', { customerId, items: [{ name: 'x', qty: 0, unitPrice: 1 }] })).status).toBe(400)

    const created = await api('POST', '/api/quotes', {
      customerId,
      port: 'Ningbo',
      validUntil: '2026-12-31',
      items: [
        { productId, name: 'Ball valve DN25', spec: 'PN16', qty: 1000, unit: 'pcs', unitPrice: 3.5 },
        { productId: null, name: '<img src=x onerror=alert(1)>', qty: 2, unitPrice: 10.005 },
      ],
    })
    expect(created.status).toBe(201)
    quoteId = created.json.id
    expect(created.json).toMatchObject({ currency: 'EUR', incoterm: 'CIF', paymentTerms: '30% T/T deposit', status: 'draft' })
    expect(created.json.number).toMatch(/^Q-\d{8}-001$/)
    expect(created.json.subtotal).toBe(3520.01)

    const second = await api('POST', '/api/quotes', { customerId })
    expect(second.json.number).toMatch(/-002$/)
    expect((await api('POST', '/api/quotes', { customerId, number: second.json.number })).status).toBe(409)

    const activities = await server.request('GET', `/api/customers/${customerId}/activities`)
    expect(activities.json.some((a: { type: string }) => a.type === 'quote')).toBe(true)
    expect((await server.request('GET', `/api/customers/${customerId}`)).json.stage).toBe('quoted')
  })

  it('报价更新、状态流转、列表筛选', async () => {
    const updated = await api('PATCH', `/api/quotes/${quoteId}`, { status: 'accepted', items: [{ name: 'A', qty: 2, unitPrice: 5 }] })
    expect(updated.json).toMatchObject({ status: 'accepted', subtotal: 10 })
    expect((await server.request('GET', `/api/customers/${customerId}`)).json.stage).toBe('won')
    expect((await server.request('GET', `/api/quotes?customerId=${customerId}`)).json).toHaveLength(2)
    expect((await server.request('GET', `/api/quotes/${quoteId}`)).json.id).toBe(quoteId)
  })

  it('可打印 HTML：转义、CSP、模板信息', async () => {
    await api('PATCH', `/api/quotes/${quoteId}`, {
      items: [{ name: '<img src=x onerror=alert(1)>', qty: 1, unitPrice: 1 }],
    })
    const res = await server.request('GET', `/api/quotes/${quoteId}/html`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.text).toContain('QUOTATION')
    expect(res.text).toContain('Wenzhou Valve Co.')
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(res.text).not.toContain('<img src=x')
    expect(res.text).toContain('Quote &lt;Script&gt; Buyer')
    expect(res.text).toContain('Thank you &lt;b&gt;!&lt;/b&gt;')
    expect((await server.request('GET', `/api/quotes/${quoteId}/html?templateId=qtpl_missing`)).status).toBe(404)
    expect((await server.request('GET', '/api/quotes/quo_missing/html')).status).toBe(404)
  })

  it('删除报价', async () => {
    expect((await server.request('DELETE', `/api/quotes/${quoteId}`)).status).toBe(204)
    expect((await server.request('GET', `/api/quotes/${quoteId}`)).status).toBe(404)
  })
})

describe('询盘判定规则', () => {
  it('CRUD + test + 正则校验 + 优先级', async () => {
    expect((await api('POST', '/api/inquiry-rules', { name: 'bad', conditions: [{ field: 'body', op: 'regex', value: '(' }], action: 'spam' })).status).toBe(400)
    expect((await api('POST', '/api/inquiry-rules', { name: 'empty', conditions: [], action: 'spam' })).status).toBe(400)
    const spam = await api('POST', '/api/inquiry-rules', {
      name: 'SEO spam',
      conditions: [{ field: 'body', op: 'regex', value: 'seo|backlinks' }],
      action: 'spam',
      priority: 10,
    })
    expect(spam.status).toBe(201)
    const inquiry = await api('POST', '/api/inquiry-rules', {
      name: 'Price request',
      conditions: [
        { field: 'subject', op: 'contains', value: 'quotation' },
        { field: 'domain', op: 'not_contains', value: 'gmail.com' },
      ],
      action: 'inquiry',
      priority: 5,
    })
    expect((await api('POST', '/api/inquiry-rules/test', { subject: 'Request for Quotation', body: 'need 500 pcs', from: 'Bob <bob@buyer.com>' })).json).toEqual({
      verdict: 'inquiry',
      matchedRuleId: inquiry.json.id,
    })
    expect((await api('POST', '/api/inquiry-rules/test', { subject: 'Quotation', body: 'cheap SEO backlinks', from: 'x@buyer.com' })).json).toEqual({
      verdict: 'spam',
      matchedRuleId: spam.json.id,
    })
    expect((await api('POST', '/api/inquiry-rules/test', { subject: 'Quotation', body: '', from: 'a@gmail.com' })).json).toEqual({
      verdict: 'review',
      matchedRuleId: null,
    })
    await api('PATCH', `/api/inquiry-rules/${spam.json.id}`, { enabled: false })
    expect((await api('POST', '/api/inquiry-rules/test', { subject: 'Quotation', body: 'seo', from: 'x@buyer.com' })).json.verdict).toBe('inquiry')
    expect((await server.request('GET', '/api/inquiry-rules')).json[0].id).toBe(spam.json.id)
    expect((await server.request('DELETE', `/api/inquiry-rules/${spam.json.id}`)).status).toBe(204)
    expect((await api('PATCH', `/api/inquiry-rules/${spam.json.id}`, { enabled: true })).status).toBe(404)
  })
})

describe('工作台、本机锁、数据导入导出', () => {
  it('工作台汇总', async () => {
    const res = await server.request('GET', '/api/workbench/summary')
    expect(res.status).toBe(200)
    expect(res.json.customers.total).toBeGreaterThan(0)
    expect(res.json.customers.byStage).toHaveProperty('lead')
    expect(res.json.quotes).toMatchObject({ total: expect.any(Number), draft: expect.any(Number) })
    expect(res.json.quotes.amountByCurrency).toHaveProperty('EUR')
    expect(Array.isArray(res.json.recentActivities)).toBe(true)
    expect(Array.isArray(res.json.recentSessions)).toBe(true)
  })

  it('工作台概览：按时区切自然日、邮件/询盘按天计数、范围筛选、跟进与久未联系', async () => {
    const { db } = await import('../src/db.js')
    const now = Date.now()
    const day = 86_400_000
    // 空邮箱：计数为 0，不造数据
    const empty = await server.request('GET', '/api/workbench/summary?range=7d&tz=480')
    expect(empty.status).toBe(200)
    expect(empty.json.overview.mail).toMatchObject({ accounts: [], current: { total: 0, inquiry: 0 } })
    expect(empty.json.overview.mail.daily).toHaveLength(7)
    expect((await server.request('GET', '/api/workbench/summary?range=bogus')).status).toBe(400)

    const cust = await api('POST', '/api/customers', { company: 'Overview Buyer GmbH', country: 'DE', stage: 'contacted' })
    expect(cust.status).toBe(201)
    db.prepare(
      `INSERT INTO email_accounts (id, email, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, created_at, updated_at, last_sync_at)
       VALUES ('acc_wb', 'sales@wb.test', 'h', 993, 'u', 'h', 465, 'u', ?, ?, ?)`,
    ).run(now, now, now)
    const mail = (id: string, date: number, verdict: string | null, customerId: string | null = null, folder = 'inbox') =>
      db
        .prepare(`INSERT INTO email_messages (id, account_id, folder, date, verdict, customer_id, created_at) VALUES (?, 'acc_wb', ?, ?, ?, ?, ?)`)
        .run(id, folder, date, verdict, customerId, now)
    mail('m1', now, 'inquiry', cust.json.id)
    mail('m2', now, null, cust.json.id)
    mail('m3', now, 'spam')
    mail('m4', now - 3 * day, 'inquiry')
    mail('m5', now - 20 * day, 'review')
    mail('m6', now, 'inquiry', null, 'sent')

    const todayRes = (await server.request('GET', '/api/workbench/summary?range=today&tz=480')).json.overview
    expect(todayRes.mail.accounts).toEqual([expect.objectContaining({ email: 'sales@wb.test' })])
    expect(todayRes.mail.current).toEqual({ total: 3, inquiry: 1, customerReply: 1, other: 1 })
    expect(todayRes.mail.inquiryCountries).toBe(1)
    expect(todayRes.mail.inquiryNewCustomers).toBe(1)
    expect(todayRes.mail.daily.at(-1)).toMatchObject({ total: 3, inquiry: 1 })
    expect(todayRes.newCustomers.current).toBeGreaterThanOrEqual(1)

    const week = (await server.request('GET', '/api/workbench/summary?range=7d&tz=480')).json.overview
    expect(week.mail.current).toMatchObject({ total: 4, inquiry: 2 })
    expect(week.mail.daily.reduce((n: number, d: { total: number }) => n + d.total, 0)).toBe(4)
    const month = (await server.request('GET', '/api/workbench/summary?range=30d&tz=480')).json.overview
    expect(month.mail.current.total).toBe(5)
    expect(month.mail.daily).toHaveLength(30)

    // 跟进：一条逾期 + 一条以后到期
    await api('POST', '/api/tasks', { title: '问样品反馈', customerId: cust.json.id, dueAt: now - 2 * day })
    await api('POST', '/api/tasks', { title: '首次联系', dueAt: now + 5 * day })
    const f = (await server.request('GET', '/api/workbench/summary?tz=480')).json.overview.followUps
    expect(f.overdue).toBeGreaterThanOrEqual(1)
    expect(f.items[0]).toMatchObject({ title: '问样品反馈', company: 'Overview Buyer GmbH', overdue: true })

    // 久未联系：把客户与邮件挪到 10 天前
    db.prepare('UPDATE customers SET created_at = ? WHERE id = ?').run(now - 10 * day, cust.json.id)
    db.prepare("UPDATE email_messages SET date = ? WHERE customer_id = ?").run(now - 10 * day, cust.json.id)
    const stale = (await server.request('GET', '/api/workbench/summary?tz=480')).json.overview.stale
    expect(stale.items.map((s: { company: string }) => s.company)).toContain('Overview Buyer GmbH')
    db.prepare("DELETE FROM email_accounts WHERE id = 'acc_wb'").run()
  })

  it('本机锁：默认关闭、scrypt、验证、限速、停用', async () => {
    const { lockService } = await import('../src/services/lock-service.js')
    expect((await server.request('GET', '/api/lock')).json).toEqual({ enabled: false })
    expect((await api('POST', '/api/lock/setup', { pin: '12' })).status).toBe(400)
    expect((await api('POST', '/api/lock/setup', { pin: 'abcd' })).status).toBe(400)
    expect((await api('POST', '/api/lock/setup', { pin: '123456' })).json).toEqual({ enabled: true })
    expect((await api('POST', '/api/lock/setup', { pin: '654321' })).status).toBe(409)
    const { db } = await import('../src/db.js')
    const stored = (db.prepare("SELECT value FROM app_meta WHERE key='lockHash'").get() as { value: string }).value
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(stored).not.toContain('123456')
    expect((await api('POST', '/api/lock/verify', { pin: '123456' })).json).toEqual({ ok: true })
    expect((await api('POST', '/api/lock/verify', { pin: '000000' })).json).toEqual({ ok: false })
    for (let i = 0; i < 4; i += 1) await api('POST', '/api/lock/verify', { pin: '000000' })
    expect((await api('POST', '/api/lock/verify', { pin: '123456' })).status).toBe(429)
    lockService.resetForTests()
    expect((await api('POST', '/api/lock/disable', { pin: '999999' })).status).toBe(403)
    expect((await api('POST', '/api/lock/disable', { pin: '123456' })).json).toEqual({ enabled: false })
    expect((await server.request('GET', '/api/lock')).json).toEqual({ enabled: false })
  })

  it('导出 → 导入（自动快照、按 id 幂等）', async () => {
    const exported = await server.request('GET', '/api/data/export')
    expect(exported.status).toBe(200)
    expect(exported.json.customers.length).toBeGreaterThan(0)
    expect(exported.json.products.length).toBeGreaterThan(0)

    // 删掉一个客户与产品后再导入，应能恢复
    const victim = exported.json.customers[0]
    await server.request('DELETE', `/api/customers/${victim.id}`)
    const payload = { ...exported.json, settings: { ...exported.json.settings, unknownKey: 'x', theme: 'system' } }
    const res = await api('POST', '/api/data/import', payload)
    expect(res.status).toBe(200)
    expect(res.json.imported.customers).toBe(exported.json.customers.length)
    expect(res.json.imported.products).toBe(exported.json.products.length)
    expect(res.json.imported.settings).toBe(Object.keys(exported.json.settings).length + 1 - 1)
    expect(existsSync(res.json.backup)).toBe(true)
    expect(readdirSync(join(server.home, 'backups')).some((f) => f.startsWith('before-import-'))).toBe(true)
    expect((await server.request('GET', `/api/customers/${victim.id}`)).json.company).toBe(victim.company)
    expect((await server.request('GET', '/api/settings')).json.settings.theme).toBe('system')

    const again = await api('POST', '/api/data/import', exported.json)
    expect(again.status).toBe(200)
    expect((await server.request('GET', '/api/customers')).json.total).toBe(exported.json.customers.length)
    expect((await api('POST', '/api/data/import', { customers: 'nope' })).status).toBe(400)
  })

  it('数据概览', async () => {
    const res = await server.request('GET', '/api/data/summary')
    expect(res.json).toMatchObject({ customers: expect.any(Number), databaseBytes: expect.any(Number) })
  })
})

describe('会话与 Agent', () => {
  it('Agent 列表只有内核：LULUX（可用）+ 命令行内核（未安装不可用），不再有 persona', async () => {
    const res = await server.request('GET', '/api/agents')
    const agents = res.json.agents as Array<{ id: string; name: string; kind: string; description: string; available: boolean; unavailableReason: string | null }>
    expect(agents[0]).toMatchObject({ id: 'builtin', kind: 'builtin', name: 'LULUX', available: true })
    const kernels = agents.filter((a) => a.kind === 'kernel')
    expect(kernels.map((a) => a.id)).toEqual(['kernel-hermes', 'kernel-claude-code', 'kernel-codex', 'kernel-pi', 'kernel-grok', 'kernel-gemini-cli', 'kernel-qwen-code'])
    expect(kernels.map((a) => a.name)).toEqual(['Hermes Agent', 'Claude Code', 'Codex', 'Pi', 'Grok', 'Gemini CLI', 'Qwen Code'])
    expect(kernels.find((a) => a.id === 'kernel-pi')!.description).toBe('Earendil Works · npm')
    expect(kernels.find((a) => a.id === 'kernel-grok')!.description).toBe('SpaceXAI · npm')
    expect(kernels.every((a) => !a.available && a.unavailableReason === '未安装')).toBe(true)
    expect(agents.length).toBe(1 + kernels.length)
  })

  it('旧 persona id（含更早的 hermes/claude）作为输入别名映射到内置内核', async () => {
    const res = await api('POST', '/api/sessions', { agentIds: ['hermes', 'claude', 'unknown'] })
    expect(res.json.session.agentIds).toEqual(['builtin'])
    const later = await api('POST', '/api/sessions', { agentIds: ['lux-analyst', 'kernel-codex'] })
    expect(later.json.session.agentIds).toEqual(['builtin', 'kernel-codex'])
  })

  it('选中不可用的内核 Agent 发消息 → 409 KERNEL_UNAVAILABLE', async () => {
    const session = await api('POST', '/api/sessions', { agentIds: ['kernel-codex'] })
    const res = await api('POST', '/api/chat', { sessionId: session.json.session.id, content: 'hi' })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('KERNEL_UNAVAILABLE')
  })

  it('会话 CRUD 校验', async () => {
    const session = await api('POST', '/api/sessions', {})
    expect((await api('PATCH', `/api/sessions/${session.json.session.id}`, {})).status).toBe(400)
    expect((await api('PATCH', `/api/sessions/${session.json.session.id}`, { title: 'New' })).json.session.title).toBe('New')
    expect((await api('PATCH', `/api/sessions/${session.json.session.id}`, { bogus: 1 })).status).toBe(400)
    expect((await server.request('DELETE', `/api/sessions/${session.json.session.id}`)).status).toBe(204)
    expect((await server.request('GET', `/api/sessions/${session.json.session.id}`)).status).toBe(404)
  })
})
