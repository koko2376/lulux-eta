import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 报价引擎 Agent 工具：经真实注册表（RBAC / zod / ToolError）与 LULUX MCP 调用。不访问网络。 */

type Registry = typeof import('../src/services/tools/registry.js')
let server: TestServer
let registry: Registry
let customerId = ''

const ctx = () => ({ sessionId: 'pricing-tools-test', agentId: 'builtin', signal: new AbortController().signal, addArtifact: () => undefined })

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = registry.findTool(name)
  expect(tool, `${name} 未注册`).toBeTruthy()
  const outcome = await registry.runTool(tool!, args, ctx())
  return { ...outcome, json: outcome.ok ? JSON.parse(outcome.text) : null }
}

beforeAll(async () => {
  server = await startTestServer()
  registry = await import('../src/services/tools/registry.js')
  const http = await import('../src/services/http-client.js')
  vi.spyOn(http, 'fetchWithProxy').mockImplementation((async () => new Response('offline', { status: 503 })) as never)
  expect((await server.request('PATCH', '/api/settings', { body: { fxLocks: '{"USD/CNY":7,"EUR/USD":1.1}' } })).status).toBe(200)
  const customer = await server.request('POST', '/api/customers', { body: { company: 'Northwind Pumps Ltd', country: 'GB' } })
  expect(customer.status, customer.text).toBe(201)
  customerId = customer.json.id
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  await server?.close()
})

describe('报价引擎工具', () => {
  it('fx_rates：锁汇可读', async () => {
    const res = await callTool('fx_rates', { base: 'CNY', symbols: ['USD'] })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.rates[0]).toMatchObject({ pair: 'CNY/USD', locked: true })
  })

  it('fx_rates：实时源都挂了且没缓存 → 工具报错而不是崩溃', async () => {
    const res = await callTool('fx_rates', { base: 'USD', symbols: ['JPY'] })
    expect(res.ok).toBe(false)
    expect(res.text).toContain('汇率')
  })

  it('quote_calculate：返回价格阶梯、费用拆分、汇率', async () => {
    const res = await callTool('quote_calculate', {
      items: [{ name: 'Centrifugal pump', qty: 50, unitCost: 1400, cbmPerUnit: 0.2 }],
      incoterm: 'CIF',
      pricing: { marginPct: 25 },
      costs: { exportPerShipment: 700, freight: { amount: 1200, currency: 'USD' }, pod: 'Felixstowe' },
    })
    expect(res.ok, res.text).toBe(true)
    const item = res.json.items[0]
    expect(Object.keys(item.priceLadder)).toEqual(['EXW', 'FOB', 'CFR', 'CIF'])
    expect(item.priceLadder.EXW).toBeCloseTo(200 / 0.75, 2)
    expect(item.marginPct).toBe(25)
    expect(res.json.container.type).toBe('LCL')
    expect(res.json.fx[0].pair).toBe('CNY/USD')
    expect(res.json).not.toHaveProperty('quoteItems')
  })

  it('quote_calculate：参数错误给出可读错误', async () => {
    const res = await callTool('quote_calculate', { items: [{ name: 'X', qty: 1, unitCost: 1 }], incoterm: 'CFR' })
    expect(res.ok).toBe(false)
    expect(res.text).toContain('海运费')
  })

  it('quote_generate_pi：建草稿报价单（备注带汇率）并生成 PDF', async () => {
    const res = await callTool('quote_generate_pi', {
      customerId,
      items: [{ name: 'Gate valve DN50', qty: 200, unitCost: 77 }],
      quoteCurrency: 'EUR',
      incoterm: 'FOB',
      pricing: { marginPct: 20 },
      costs: { pol: 'Ningbo', exportPerShipment: 0 },
      paymentTerms: '30% T/T deposit, 70% before shipment',
      validUntil: '2026-12-31',
    })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.quote).toMatchObject({ currency: 'EUR', incoterm: 'FOB', status: 'draft' })
    // 77 CNY → 11 USD → 10 EUR（EUR/USD 1.1 反向）→ /0.8 = 12.5
    expect(res.json.calculation.items[0].unitPrice).toBe(12.5)
    const quote = await server.request('GET', `/api/quotes/${res.json.quote.id}`)
    expect(quote.json.port).toBe('Ningbo')
    // 备注印在 PI 上：不能泄露汇率 / 成本
    expect(quote.json.notes).toBe('')
    expect(res.json.calculation.fx[0]).toMatchObject({ pair: 'CNY/EUR', locked: true })
    expect(quote.json.items[0].unitPrice).toBe(12.5)
    expect(res.json.pdf.note).toContain('PDF')
  }, 60_000)

  it('quote_generate_pi：PDF 失败时不报错（避免模型重试建重复报价单），如实返回已建好的报价单', async () => {
    const { CRM_TOOLS } = await import('../src/services/chat/crm-tools.js')
    const pdfTool = CRM_TOOLS.find((tool) => tool.name === 'generate_quote_pdf')!
    const spy = vi.spyOn(pdfTool, 'run').mockRejectedValue(new Error('disk full'))
    try {
      const res = await callTool('quote_generate_pi', { customerId, items: [{ name: 'X', qty: 1, unitCost: 7 }], incoterm: 'EXW' })
      expect(res.ok, res.text).toBe(true)
      expect(res.json.created).toBe(true)
      expect(res.json.pdf.path).toBeNull()
      expect(res.json.pdf.note).toContain('disk full')
      expect(res.json.pdf.note).toContain(res.json.quote.number)
    } finally {
      spy.mockRestore()
    }
  })

  it('quote_generate_pi：客户不存在 → 错误，不建报价单', async () => {
    const before = (await server.request('GET', '/api/quotes')).json.length
    const res = await callTool('quote_generate_pi', { customerId: 'cus_nope', items: [{ name: 'X', qty: 1, unitCost: 7 }], incoterm: 'EXW' })
    expect(res.ok).toBe(false)
    expect((await server.request('GET', '/api/quotes')).json.length).toBe(before)
  })

  it('save_freight_rate / list_freight_rates，并被 quote_calculate 用上', async () => {
    const saved = await callTool('save_freight_rate', { pol: 'Ningbo', pod: 'Hamburg', container: '20GP', price: 1800, currency: 'USD' })
    expect(saved.ok, saved.text).toBe(true)
    const listed = await callTool('list_freight_rates', { pod: 'hamburg' })
    expect(listed.json.total).toBe(1)
    const updated = await callTool('save_freight_rate', { id: saved.json.rate.id, price: 1700 })
    expect(updated.json.rate.price).toBe(1700)
    const calc = await callTool('quote_calculate', {
      items: [{ name: 'X', qty: 100, unitCost: 70, cbmPerUnit: 0.2 }],
      incoterm: 'CFR',
      pricing: { marginPct: 0 },
      costs: { pol: 'Ningbo', pod: 'Hamburg' },
    })
    expect(calc.ok, calc.text).toBe(true)
    expect(calc.json.freight).toMatchObject({ source: 'rate_table', amount: 1700 })
    expect(calc.json.items[0].unitPrice).toBe(27)
  })

  it('风险分级：计算与查询是 read，出 PI 与改运价是 write', () => {
    expect(registry.findTool('quote_calculate')!.risk).toBe('read')
    expect(registry.findTool('fx_rates')!.risk).toBe('read')
    expect(registry.findTool('quote_generate_pi')!.risk).toBe('write')
    expect(registry.findTool('save_freight_rate')!.risk).toBe('write')
  })

  it('LULUX MCP 暴露报价引擎工具并可执行', async () => {
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-pi'], permissionLevel: 'full' } })
    expect(session.status, session.text).toBe(201)
    const issued = luluxMcpTokens.issue({
      actor: LOCAL_ACTOR,
      kernelId: 'pi',
      bridge: { sessionId: session.json.session.id, agentId: 'kernel-pi', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    try {
      let id = 0
      const rpc = async (method: string, params: Record<string, unknown> = {}) =>
        (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: ++id, method, params } })).json
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      const tools = (await rpc('tools/list')).result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>
      const names = tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['quote_calculate', 'quote_generate_pi', 'fx_rates', 'list_freight_rates', 'save_freight_rate']))
      expect(tools.find((tool) => tool.name === 'quote_calculate')!.annotations.readOnlyHint).toBe(true)
      expect(tools.find((tool) => tool.name === 'quote_generate_pi')!.annotations.readOnlyHint).toBe(false)
      const called = await rpc('tools/call', { name: 'quote_calculate', arguments: { items: [{ name: 'X', qty: 10, unitCost: 70 }], incoterm: 'EXW', pricing: { marginPct: 50 } } })
      expect(called.result.isError ?? false).toBe(false)
      expect(JSON.parse(called.result.content[0].text).items[0].unitPrice).toBe(20)
    } finally {
      issued.revoke()
    }
  })
})
