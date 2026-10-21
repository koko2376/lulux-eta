import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 万级客户数据性能基线：
 * 10,000 客户 + 20,000 联系人 + 30,000 跟进 + 5,000 报价 + 3,000 任务，真实 HTTP 测关键接口耗时。
 * 阈值放宽（CI 机器慢），实际数字打印在输出里。
 */
let server: TestServer
const N = 10_000
const timings: Record<string, number> = {}

async function timed(name: string, path: string): Promise<any> {
  const started = performance.now()
  const res = await server.request('GET', path)
  timings[name] = Math.round(performance.now() - started)
  expect(res.status, res.text.slice(0, 200)).toBe(200)
  return res.json
}

beforeAll(async () => {
  server = await startTestServer()
  const { db } = await import('../src/db.js')
  const stages = ['lead', 'contacted', 'quoted', 'negotiating', 'won', 'lost']
  const now = Date.now()
  db.exec('BEGIN')
  const cus = db.prepare(
    `INSERT INTO customers (id, company, company_key, country, website, website_key, stage, tags, source, notes, created_at, updated_at, org_id, owner_id, visibility)
     VALUES (?, ?, ?, ?, '', '', ?, ?, 'seed', '', ?, ?, 'local', 'local', 'private')`,
  )
  const con = db.prepare(`INSERT INTO contacts (id, customer_id, name, title, email, phone, whatsapp, is_primary, position) VALUES (?, ?, ?, '', ?, '', '', ?, ?)`)
  const act = db.prepare(`INSERT INTO activities (id, customer_id, type, content, created_at) VALUES (?, ?, 'note', ?, ?)`)
  for (let i = 0; i < N; i += 1) {
    const id = `cus_p${i}`
    const company = `Perf Trading ${i} ${i % 7 === 0 ? 'Valves' : 'Pumps'} GmbH`
    cus.run(id, company, company.toLowerCase(), ['DE', 'US', 'BR', 'JP'][i % 4]!, stages[i % 6]!, JSON.stringify(i % 5 === 0 ? ['VIP'] : []), now - i * 60_000, now - i * 60_000)
    con.run(`con_p${i}a`, id, `Buyer ${i}`, `buyer${i}@perf${i}.example.com`, 1, 0)
    con.run(`con_p${i}b`, id, `Assistant ${i}`, `assist${i}@perf${i}.example.com`, 0, 1)
    for (let k = 0; k < 3; k += 1) act.run(`act_p${i}_${k}`, id, `follow up ${k}`, now - i * 60_000 - k)
  }
  const quo = db.prepare(
    `INSERT INTO quotes (id, number, customer_id, currency, incoterm, port, valid_until, payment_terms, lead_time, items, notes, status, subtotal, created_at, updated_at, org_id, owner_id)
     VALUES (?, ?, ?, 'USD', 'FOB', '', '', '', '', '[]', '', ?, ?, ?, ?, 'local', 'local')`,
  )
  for (let i = 0; i < 5000; i += 1) quo.run(`quo_p${i}`, `PQ-${i}`, `cus_p${i * 2}`, ['draft', 'sent', 'accepted', 'rejected'][i % 4]!, 1000 + i, now, now)
  const task = db.prepare(`INSERT INTO tasks (id, title, customer_id, due_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`)
  for (let i = 0; i < 3000; i += 1) task.run(`tsk_p${i}`, `task ${i}`, `cus_p${i}`, now + (i - 1500) * 3600_000, now, now)
  db.exec('COMMIT')
}, 120_000)

afterAll(async () => {
  console.info('[perf-crm] ms:', JSON.stringify(timings))
  await server?.close()
})

describe('万级客户性能', () => {
  it('列表 / 搜索 / 筛选 / 详情 / 工作台 / 漏斗 / 任务 在阈值内', async () => {
    const page1 = await timed('list', '/api/customers?page=1&pageSize=50')
    expect(page1.total).toBe(N)
    await timed('listLastPage', `/api/customers?page=${N / 50}&pageSize=50`)
    const search = await timed('searchContactEmail', '/api/customers?query=buyer9999@')
    expect(search.total).toBe(1)
    await timed('searchCompany', '/api/customers?query=valves')
    await timed('filterStageTag', '/api/customers?stage=quoted&tag=VIP')
    await timed('detail', '/api/customers/cus_p5000')
    await timed('activities', '/api/customers/cus_p5000/activities')
    await timed('workbench', '/api/workbench/summary')
    const stats = await timed('pipeline', '/api/pipeline/stats')
    expect(stats.customers.total).toBe(N)
    await timed('tasksOverdue', '/api/tasks?due=overdue')
    await timed('quotes', '/api/quotes')
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(name === 'quotes' ? 5000 : 2000)
  }, 60_000)
})
