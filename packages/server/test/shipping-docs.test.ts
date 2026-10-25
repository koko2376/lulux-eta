import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

/**
 * 出货单证：默认值（发货人 / 收货人 / HS / 港口）、缺项检查、修改合并、CI / PL / CO PDF、金额大写、
 * HS 建议（产品库 + 历史单证 + 英国税则 fixture，不访问网络）、Agent 工具与 MCP。
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'trade', name), 'utf8')
let server: TestServer
let registry: typeof import('../src/services/tools/registry.js')
let docsModule: typeof import('../src/services/trade/shipping-docs.js')
let orderId = ''
let customerId = ''
const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })
const ctx = () => ({ sessionId: 'docs-test', agentId: 'builtin', signal: new AbortController().signal, addArtifact: () => undefined })
async function callTool(name: string, args: Record<string, unknown>) {
  const tool = registry.findTool(name)
  expect(tool, `${name} 未注册`).toBeTruthy()
  const outcome = await registry.runTool(tool!, args, ctx())
  return { ...outcome, json: outcome.ok ? JSON.parse(outcome.text) : null }
}

let hasPdftotext = false
function pdfText(buffer: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'lulux-doc-'))
  writeFileSync(join(dir, 'a.pdf'), buffer)
  return execFileSync('pdftotext', ['-layout', join(dir, 'a.pdf'), '-'], { encoding: 'utf8' })
}

beforeAll(async () => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
    hasPdftotext = true
  } catch {
    hasPdftotext = false
  }
  server = await startTestServer({ LULUX_PDF_FONT: '' })
  registry = await import('../src/services/tools/registry.js')
  docsModule = await import('../src/services/trade/shipping-docs.js')
  const http = await import('../src/services/http-client.js')
  vi.spyOn(http, 'fetchWithProxy').mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const json = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/search?q=LED%20lamp')) return json(fixture('uktt-search-led-lamp.json'))
    if (url.includes('/search?q=ball%20valve')) return json(fixture('uktt-search-ball-valve.json'))
    if (url.includes('/subheadings/8481300000-80')) return json(fixture('uktt-subheading-8481300000-80.json'))
    if (url.includes('/search?q=')) return new Response('down', { status: 503 })
    return new Response('not found', { status: 404 })
  }) as never)

  await api('POST', '/api/quote-templates', {
    name: '默认',
    isDefault: true,
    company: { name: 'Koko Valve Co., Ltd.', address: 'No. 8 Industrial Rd, Longwan, Wenzhou, China', phone: '+86 577 0000 0000', email: 'sales@koko-valve.example.com' },
  })
  const product = await api('POST', '/api/products', { sku: 'BV-DN25', name: 'Brass ball valve', spec: 'DN25 PN25', unit: 'pcs', price: 3.2, currency: 'USD', hsCode: '8481804090' })
  expect(product.status, product.text).toBe(201)
  const customer = await api('POST', '/api/customers', { company: 'Nordic Tools AB', country: 'SE', contacts: [{ name: 'Anna Berg', email: 'anna@nordic-tools.example.com', isPrimary: true }] })
  customerId = customer.json.id
  const quote = await api('POST', '/api/quotes', {
    customerId,
    currency: 'USD',
    incoterm: 'FOB',
    port: 'Ningbo',
    paymentTerms: '30% T/T deposit, 70% before shipment',
    items: [
      { productId: product.json.id, name: 'Brass ball valve', spec: 'DN25 PN25', qty: 2000, unit: 'pcs', unitPrice: 3.2 },
      { productId: null, name: 'Brass gate valve', spec: 'DN50', qty: 500, unit: 'pcs', unitPrice: 7.45 },
    ],
  })
  expect(quote.status, quote.text).toBe(201)
  const order = await api('POST', `/api/quotes/${quote.json.id}/order`, {})
  expect(order.status, order.text).toBeLessThan(300)
  orderId = order.json.id
  await api('PATCH', `/api/orders/${orderId}`, { portOfLoading: 'NINGBO, CHINA', portOfDischarge: 'GOTHENBURG, SWEDEN', vessel: 'MAERSK EDINBURGH 245W' })
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  await server?.close()
})

describe('金额大写', () => {
  it('整数、带分、千 / 百万、AND 的位置', () => {
    expect(docsModule.amountInWords(10125, 'USD')).toBe('SAY US DOLLARS TEN THOUSAND ONE HUNDRED AND TWENTY-FIVE ONLY')
    expect(docsModule.amountInWords(1234567.89, 'EUR')).toBe('SAY EUROS ONE MILLION TWO HUNDRED AND THIRTY-FOUR THOUSAND FIVE HUNDRED AND SIXTY-SEVEN AND CENTS EIGHTY-NINE ONLY')
    expect(docsModule.amountInWords(0.5, 'USD')).toBe('SAY US DOLLARS ZERO AND CENTS FIFTY ONLY')
    expect(docsModule.amountInWords(100, 'XYZ')).toBe('SAY XYZ ONE HUNDRED ONLY')
    expect(docsModule.amountInWords(13065, 'USD')).toBe('SAY US DOLLARS THIRTEEN THOUSAND AND SIXTY-FIVE ONLY')
    expect(docsModule.amountInWords(2000000, 'USD')).toBe('SAY US DOLLARS TWO MILLION ONLY')
    expect(docsModule.amountInWords(1.005, 'USD')).toBe('SAY US DOLLARS ONE AND CENTS ONE ONLY')
    expect(docsModule.amountInWords(1001, 'USD')).toBe('SAY US DOLLARS ONE THOUSAND AND ONE ONLY')
    expect(docsModule.amountInWords(19.999, 'USD')).toBe('SAY US DOLLARS TWENTY ONLY')
  })
})

describe('单证资料', () => {
  it('默认值：发货人取报价模板、收货人取客户、HS 取产品库、港口船名取订单；缺项列出', async () => {
    const res = await api('GET', `/api/orders/${orderId}/docs`)
    expect(res.status, res.text).toBe(200)
    const b = res.json
    expect(b.info.shipper.name).toBe('Koko Valve Co., Ltd.')
    expect(b.info.consignee.name).toBe('Nordic Tools AB')
    expect(b.info).toMatchObject({ portOfLoading: 'NINGBO, CHINA', portOfDischarge: 'GOTHENBURG, SWEDEN', vessel: 'MAERSK EDINBURGH 245W', origin: 'CHINA', marks: 'N/M' })
    expect(b.lines[0]).toMatchObject({ hsCode: '8481804090', description: 'Brass ball valve DN25 PN25', qty: 2000, amount: 6400 })
    expect(b.lines[1].hsCode).toBe('')
    expect(b.totals.amount).toBe(10125)
    const codes = b.issues.map((i: { code: string }) => i.code)
    expect(codes).toEqual(expect.arrayContaining(['hsMissing', 'cartons', 'netKg', 'grossKg', 'consigneeAddress']))
    // 有阻断问题时不出 PDF
    const pdf = await api('GET', `/api/orders/${orderId}/docs/ci.pdf`)
    expect(pdf.status).toBe(409)
    expect(pdf.json.error.code).toBe('DOCS_INCOMPLETE')
  })

  it('修改：只改传入字段，lines 按 itemIndex 合并；校验毛净重、越界行', async () => {
    expect((await api('PATCH', `/api/orders/${orderId}/docs`, { lines: [{ itemIndex: 5, cartons: 1 }] })).status).toBe(400)
    expect((await api('PATCH', `/api/orders/${orderId}/docs`, { lines: [{ itemIndex: 0, netKg: -1 }] })).status).toBe(400)
    const bad = await api('PATCH', `/api/orders/${orderId}/docs`, { lines: [{ itemIndex: 0, cartons: 40, netKg: 600, grossKg: 500 }] })
    expect(bad.json.issues.some((i: { code: string }) => i.code === 'grossLtNet')).toBe(true)
    const res = await api('PATCH', `/api/orders/${orderId}/docs`, {
      invoiceNo: 'KV-2026-1024',
      invoiceDate: '2026-10-24',
      consignee: { address: 'Hamngatan 12, 411 06 Gothenburg, Sweden' },
      marks: 'NORDIC TOOLS\nGOTHENBURG\nC/NO. 1-60',
      lines: [
        { itemIndex: 0, cartons: 40, netKg: 600, grossKg: 640, cbm: 1.28 },
        { itemIndex: 1, hsCode: '8481 8040 90', description: 'Brass gate valve DN50', cartons: 20, netKg: 410, grossKg: 432.5, cbm: 0.96 },
      ],
    })
    expect(res.status, res.text).toBe(200)
    const b = res.json
    expect(b.info.consignee.name).toBe('Nordic Tools AB')
    expect(b.info.consignee.address).toContain('Gothenburg')
    expect(b.lines[1].hsCode).toBe('84818040 90'.replace(/\s/g, ''))
    expect(b.lines[0].hsCode).toBe('8481804090')
    expect(b.totals).toMatchObject({ cartons: 60, netKg: 1010, grossKg: 1072.5, cbm: 2.24 })
    expect(b.issues.filter((i: { level: string }) => i.level === 'error')).toEqual([])
  })

  it('出 CI / PL / CO PDF：内容含发票号、HS、合计、大写金额、毛净重；CO 标明是申请草稿', async () => {
    for (const kind of ['ci', 'pl', 'co']) {
      const res = await fetch(`${server.base}/api/orders/${orderId}/docs/${kind}.pdf`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/pdf')
      expect(res.headers.get('content-disposition')).toContain('KV-2026-1024')
      const buf = Buffer.from(await res.arrayBuffer())
      expect(buf.subarray(0, 4).toString()).toBe('%PDF')
      if (!hasPdftotext) continue
      const text = pdfText(buf)
      expect(text).toContain('KV-2026-1024')
      if (kind === 'ci') {
        expect(text).toContain('COMMERCIAL INVOICE')
        expect(text).toContain('8481804090')
        expect(text).toContain('10,125.00')
        expect(text).toContain('SAY US DOLLARS TEN THOUSAND ONE HUNDRED AND TWENTY-FIVE ONLY')
        expect(text).toContain('FOB NINGBO, CHINA')
      }
      if (kind === 'pl') {
        expect(text).toContain('PACKING LIST')
        expect(text).toContain('1,072.5')
        expect(text).toContain('2.240')
        expect(text).toContain('SAY TOTAL SIXTY (60) CTNS ONLY')
        expect(text).not.toContain('3.20')
      }
      if (kind === 'co') {
        expect(text).toContain('CERTIFICATE OF ORIGIN')
        expect(text).toContain('DRAFT FOR APPLICATION')
        expect(text).toContain('40 CTNS OF Brass ball valve DN25 PN25')
      }
    }
    expect((await api('GET', `/api/orders/${orderId}/docs/xx.pdf`)).status).toBe(400)
  })
})

describe('订单明细变化', () => {
  it('明细被改动的行，旧单证资料作废（不会错位到别的货上）', async () => {
    const quote = await api('POST', '/api/quotes', { customerId, currency: 'USD', incoterm: 'FOB', port: 'Ningbo', items: [
      { productId: null, name: 'A valve', spec: '', qty: 1, unit: 'pcs', unitPrice: 1 },
      { productId: null, name: 'B valve', spec: '', qty: 1, unit: 'pcs', unitPrice: 1 },
    ] })
    const order = await api('POST', `/api/quotes/${quote.json.id}/order`, {})
    const saved = await api('PATCH', `/api/orders/${order.json.id}/docs`, { lines: [{ itemIndex: 0, hsCode: '1111111111', cartons: 3, itemKey: 'forged' }, { itemIndex: 1, hsCode: '2222222222', cartons: 7 }] })
    expect(saved.status, saved.text).toBe(200)
    expect(saved.json.info.lines[0].itemKey).toBe('A valve||pcs')
    const { db } = await import('../src/db.js')
    // 模拟删除第一行明细：B valve 变成第 0 行
    db.prepare('UPDATE orders SET items = ? WHERE id = ?').run(JSON.stringify([{ productId: null, name: 'B valve', spec: '', qty: 1, unit: 'pcs', unitPrice: 1 }]), order.json.id)
    const after = await api('GET', `/api/orders/${order.json.id}/docs`)
    expect(after.json.lines).toHaveLength(1)
    expect(after.json.lines[0]).toMatchObject({ name: 'B valve', hsCode: '', cartons: 0 })
  })
})

describe('HS 建议', () => {
  it('检索词变体：去掉规格词，长名再试首尾词 / 末两词', async () => {
    const { tariffQueries } = await import('../src/services/trade/hs-suggest.js')
    expect(tariffQueries('LED panel lamp 600x600 40W')).toEqual(['LED panel lamp', 'LED lamp', 'panel lamp'])
    expect(tariffQueries('Brass ball valve DN25 PN25')).toEqual(['Brass ball valve', 'Brass valve', 'ball valve'])
    expect(tariffQueries('不锈钢 LED lamp')).toEqual(['LED lamp'])
    expect(tariffQueries('闸阀')).toEqual([])
  })

  it('产品库 / 历史单证优先；英国税则候选只取 6 位；精确匹配查子目描述；税则挂了仍返回本地结果', async () => {
    const valve = await api('GET', `/api/hs/suggest?q=${encodeURIComponent('ball valve')}`)
    expect(valve.status, valve.text).toBe(200)
    expect(valve.json.candidates[0]).toMatchObject({ code: '8481804090', source: 'product' })
    const uk = valve.json.candidates.find((c: { source: string }) => c.source === 'uk_tariff')
    expect(uk).toMatchObject({ code: '848130', description: 'Check (non-return) valves' })
    const led = await api('GET', `/api/hs/suggest?q=${encodeURIComponent('LED lamp')}`)
    const ledCodes = led.json.candidates.map((c: { code: string }) => c.code)
    expect(ledCodes).toContain('853952')
    expect(ledCodes.every((c: string) => c.length === 6)).toBe(true)
    const gate = await api('GET', `/api/hs/suggest?q=${encodeURIComponent('gate valve 闸阀')}`)
    expect(gate.json.candidates.some((c: { source: string; code: string }) => c.source === 'history' && c.code === '8481804090')).toBe(true)
    expect(gate.json.tariffError).toContain('503')
    expect(gate.json.note).toContain('单一窗口')
  })
})

describe('Agent 工具 / MCP', () => {
  it('docs_get / docs_update / docs_generate / hs_suggest', async () => {
    const got = await callTool('docs_get', { orderId })
    expect(got.ok, got.text).toBe(true)
    expect(got.json.ready).toBe(true)
    const upd = await callTool('docs_update', { orderId, notifyParty: 'NORDIC TOOLS AB, SAME AS CONSIGNEE', lines: [{ itemIndex: 1, cbm: 1.0 }] })
    expect(upd.ok, upd.text).toBe(true)
    expect(upd.json.totals.cbm).toBe(2.28)
    const gen = await callTool('docs_generate', { orderId, kinds: ['ci', 'pl', 'co'] })
    expect(gen.ok, gen.text).toBe(true)
    expect(gen.json.generated).toBe(true)
    expect(gen.json.files.map((f: { kind: string }) => f.kind)).toEqual(['ci', 'pl', 'co'])
    expect(gen.json.note).toContain('原产地证只是申请草稿')
    const hs = await callTool('hs_suggest', { query: 'LED lamp' })
    expect(hs.ok, hs.text).toBe(true)
    expect(hs.json.candidates.length).toBeGreaterThan(0)
  })

  it('资料不全时 docs_generate 不出文件，返回缺项', async () => {
    const quote = await api('POST', '/api/quotes', { customerId, currency: 'USD', incoterm: 'CIF', items: [{ productId: null, name: 'Valve', spec: '', qty: 1, unit: 'pcs', unitPrice: 1 }] })
    const order = await api('POST', `/api/quotes/${quote.json.id}/order`, {})
    // CIF 报价的港口是目的港
    expect(order.json.shipment).toMatchObject({ portOfLoading: '', portOfDischarge: '' })
    const quote3 = await api('POST', '/api/quotes', { customerId, currency: 'USD', incoterm: 'CIF', port: 'Hamburg', items: [{ productId: null, name: 'Valve', spec: '', qty: 1, unit: 'pcs', unitPrice: 1 }] })
    const order3 = await api('POST', `/api/quotes/${quote3.json.id}/order`, {})
    expect(order3.json.shipment).toMatchObject({ portOfLoading: '', portOfDischarge: 'Hamburg' })
    // 用订单号也能查
    const byNumber = await callTool('docs_get', { orderId: order3.json.number })
    expect(byNumber.ok, byNumber.text).toBe(true)
    expect(byNumber.json.portOfDischarge).toBe('Hamburg')
    const gen = await callTool('docs_generate', { orderId: order.json.id })
    expect(gen.ok, gen.text).toBe(true)
    expect(gen.json.generated).toBe(false)
    expect(gen.json.missing.join(' ')).toContain('HS')
  })

  it('MCP 暴露 docs_* / hs_suggest', async () => {
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const session = await api('POST', '/api/sessions', { agentIds: ['kernel-pi'], permissionLevel: 'full' })
    const issued = luluxMcpTokens.issue({
      actor: LOCAL_ACTOR,
      kernelId: 'pi',
      bridge: { sessionId: session.json.session.id, agentId: 'kernel-pi', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    try {
      const rpc = async (method: string, params: Record<string, unknown> = {}) =>
        (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: 1, method, params } })).json
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
      const names = ((await rpc('tools/list')).result.tools as Array<{ name: string }>).map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['docs_get', 'docs_update', 'docs_generate', 'hs_suggest']))
    } finally {
      issued.revoke()
    }
  })
})
