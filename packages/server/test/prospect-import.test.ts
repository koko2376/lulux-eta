import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 线索表格导入：列映射、upsert 合并、证据 kind=import、制裁初筛、逐行错误 */
let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
  const { sanctionsService } = await import('../src/services/sanctions/sanctions-service.js')
  sanctionsService.importCustom('name,country\nBad Actor Trading,RU\n')
}, 60_000)
afterAll(async () => {
  await server?.close()
})

const mapping = { company: '公司', country: '国家', website: '官网', hsCodes: 'HS', emails: '邮箱', notes: '备注' }

describe('POST /api/prospects/import', () => {
  it('按映射写入；重复导入合并；证据 kind=import 带文件名与行号', async () => {
    const rows = [
      { 公司: 'Import Alpha Ltd', 国家: 'gb', 官网: 'import-alpha.example', HS: '8413.70; 8481', 邮箱: 'Buyer@Import-Alpha.example', 备注: '展会认识' },
      { 公司: '', 国家: 'DE' },
      { 公司: 'Import Beta GmbH', 国家: 'DE', 官网: 'ftp://bad.example' },
    ]
    const res = await server.request('POST', '/api/prospects/import', { body: { fileName: 'leads.xlsx', mapping, rows } })
    expect(res.status, res.text).toBe(200)
    expect(res.json).toMatchObject({ created: 1, merged: 0, skipped: 1, sanctionsHits: 0 })
    expect(res.json.errors).toHaveLength(1)
    expect(res.json.errors[0].row).toBe(4)
    const list = await server.request('GET', '/api/prospects?q=Import%20Alpha')
    const p = list.json.items[0]
    expect(p).toMatchObject({ company: 'Import Alpha Ltd', country: 'GB', website: 'https://import-alpha.example/', hsCodes: ['841370', '8481'], emails: ['buyer@import-alpha.example'], notes: '展会认识' })
    expect(p.evidence[0]).toMatchObject({ kind: 'import', source: 'spreadsheet', title: 'leads.xlsx 第 2 行' })
    const again = await server.request('POST', '/api/prospects/import', { body: { fileName: 'leads.xlsx', mapping, rows: rows.slice(0, 1) } })
    expect(again.json).toMatchObject({ created: 0, merged: 1 })
    expect((await server.request('GET', '/api/prospects?q=Import%20Alpha')).json.total).toBe(1)
  })

  it('制裁初筛命中：打标记并在备注追加一行', async () => {
    const res = await server.request('POST', '/api/prospects/import', { body: { mapping, rows: [{ 公司: 'BAD ACTOR TRADING LLC', 国家: 'RU' }] } })
    expect(res.json).toMatchObject({ created: 1, sanctionsHits: 1 })
    const p = (await server.request('GET', '/api/prospects?q=Bad%20Actor')).json.items[0]
    expect(p.flags).toContain('sanctions_hit')
    expect(p.notes).toContain('[制裁名单初筛]')
  })

  it('没映射公司列 → 400', async () => {
    const res = await server.request('POST', '/api/prospects/import', { body: { mapping: { country: '国家' }, rows: [] } })
    expect(res.status).toBe(400)
  })
})
