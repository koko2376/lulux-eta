import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 回归：邮件去重（UIDVALIDITY 变化）/ 询盘打分去掉引用 / 客户导入查重与行号 / 应收汇总 / 回收站自动清理 */
let server: TestServer
let db: typeof import('../src/db.js')['db']
const api = (m: string, p: string, body?: unknown) => server.request(m, p, { body })

beforeAll(async () => {
  server = await startTestServer()
  ;({ db } = await import('../src/db.js'))
  const now = Date.now()
  db.prepare(`INSERT INTO email_accounts (id, email, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, created_at, updated_at)
    VALUES ('acc_dup', 'me@x.example.com', 'h', 1, 'u', 'h', 1, 'u', ?, ?)`).run(now, now)
})
afterAll(async () => server?.close())

describe('邮件：UIDVALIDITY 变化后按 Message-ID 去重', () => {
  it('同一封邮件在新 uidValidity 下不再入库一份，只更新 uid / uid_validity，也不算新邮件', async () => {
    const ms = await import('../src/services/email/message-service.js')
    const { accountRow } = await import('../src/services/email/account-service.js')
    const raw = Buffer.from('From: Buyer <b@buyer.example.com>\r\nTo: me@x.example.com\r\nSubject: RFQ\r\nMessage-ID: <rfq-1@buyer.example.com>\r\nDate: Fri, 23 Oct 2026 10:00:00 +0000\r\n\r\nNeed 500 pcs\r\n')
    const mail = await ms.parseRaw(raw)
    const acc = accountRow('acc_dup')!
    const a = ms.storeMessage(acc, 'inbox', 'INBOX', 101, '1111', new Set(), mail)
    const b = ms.storeMessage(acc, 'inbox', 'INBOX', 7, '2222', new Set(), mail) // 服务端重建邮箱 / 换了收件文件夹
    expect(a).toBeTruthy()
    expect(b).toBeNull() // 不是新邮件：不会再通知 / 打分 / 回信检测
    const rows = db.prepare("SELECT id, uid, uid_validity FROM email_messages WHERE account_id = 'acc_dup' AND message_id = ?").all(mail.messageId) as Array<{ id: string; uid: number; uid_validity: string }>
    expect(rows).toEqual([{ id: a, uid: 7, uid_validity: '2222' }])
    // 同一 uidValidity 下再来一次也只认一份
    expect(ms.storeMessage(acc, 'inbox', 'INBOX', 7, '2222', new Set(), mail)).toBeNull()
  })

  it('没有 Message-ID 的邮件按 日期 + 发件人 + 主题 认出是同一封', async () => {
    const ms = await import('../src/services/email/message-service.js')
    const { accountRow } = await import('../src/services/email/account-service.js')
    const raw = Buffer.from('From: Buyer <nomid@buyer.example.com>\r\nTo: me@x.example.com\r\nSubject: No id\r\nDate: Fri, 23 Oct 2026 11:00:00 +0000\r\n\r\nHello\r\n')
    const acc = accountRow('acc_dup')!
    const first = ms.storeMessage(acc, 'inbox', 'INBOX', 201, '1111', new Set(), await ms.parseRaw(raw))
    const second = ms.storeMessage(acc, 'inbox', 'INBOX', 9, '3333', new Set(), await ms.parseRaw(raw))
    expect(first).toBeTruthy()
    expect(second).toBeNull()
    const n = (db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE account_id = 'acc_dup' AND subject = 'No id'").get() as { n: number }).n
    expect(n).toBe(1)
  })
})

describe('询盘打分只看对方新写的部分', () => {
  it('回信里引用的我方原文（签名、电话、网站、产品规格）不加分', async () => {
    const ms = await import('../src/services/email/message-service.js')
    const { accountRow } = await import('../src/services/email/account-service.js')
    const acc = accountRow('acc_dup')!
    const fresh = 'Hi, please send more details.'
    const quoted =
      `${fresh}\n\nOn Mon, Sales <me@x.example.com> wrote:\n> Our stainless steel 304 M6 bolts, DIN 933.\n> --\n> Wenzhou Regress Fasteners Co., Ltd.\n> Tel: +86 577 6123 4567\n> www.regress-fasteners.example.com`
    const store = async (id: string, body: string, uid: number) => {
      const raw = Buffer.from(`From: Buyer <x${id}@buyer-score.example.com>\r\nTo: me@x.example.com\r\nSubject: Re: bolts\r\nMessage-ID: <${id}@buyer-score.example.com>\r\nDate: Fri, 23 Oct 2026 12:00:00 +0000\r\n\r\n${body.replace(/\n/g, '\r\n')}\r\n`)
      const msgId = ms.storeMessage(acc, 'inbox', 'INBOX', uid, '9999', new Set(), await ms.parseRaw(raw))!
      return db.prepare('SELECT * FROM email_messages WHERE id = ?').get(msgId) as never
    }
    const plain = ms.computeInquiryScore(await store('plain', fresh, 501))
    const withQuote = ms.computeInquiryScore(await store('quoted', quoted, 502))
    expect(withQuote.score).toBe(plain.score)
    const keys = withQuote.reasons.map((r: { key: string }) => r.key)
    expect(keys).not.toContain('signature')
    expect(keys).not.toContain('product')
  })
})

describe('客户导入按公司名查重与手动新建同一口径', () => {
  it('已有「ACME Trading Co., Ltd.」，导入「Acme Trading」(company, merge) 合并到已有客户，不新建', async () => {
    const c = await api('POST', '/api/customers', { company: 'ACME Trading Co., Ltd.' })
    expect(c.status, c.text).toBe(201)
    expect((await api('POST', '/api/customers', { company: 'Acme Trading' })).status).toBe(409)
    const imp = await api('POST', '/api/customers/import', { rows: [{ Company: 'Acme Trading' }], mapping: { company: 'Company' }, dedupeBy: 'company', onDuplicate: 'merge' })
    expect(imp.status, imp.text).toBe(200)
    expect(imp.json).toMatchObject({ created: 0, merged: 1 })
    const skip = await api('POST', '/api/customers/import', { rows: [{ Company: 'acme trading ltd' }], mapping: { company: 'Company' }, dedupeBy: 'company', onDuplicate: 'skip' })
    expect(skip.json).toMatchObject({ created: 0, skipped: 1 })
  })

  it('错误行号优先用客户端带来的源文件行号（__line）', async () => {
    const imp = await api('POST', '/api/customers/import', {
      rows: [
        { Company: 'Line Ok Co', Email: 'ok@line.example.com', __line: '3' },
        { Company: 'Line Bad Co', Email: 'not-an-email', __line: '7' },
      ],
      mapping: { company: 'Company', contactEmail: 'Email' },
      dedupeBy: 'email',
      onDuplicate: 'skip',
    })
    expect(imp.status, imp.text).toBe(200)
    expect(imp.json.errors.map((e: { row: number }) => e.row)).toEqual([7])
    // 没带行号时按请求里的第几行
    const plain = await api('POST', '/api/customers/import', { rows: [{ Company: 'X1' }, { Company: '' }], mapping: { company: 'Company' }, dedupeBy: 'company', onDuplicate: 'skip' })
    expect(plain.json.errors.map((e: { row: number }) => e.row)).toEqual([2])
  })
})

describe('应收汇总统计全部未收订单', () => {
  it('501 个未收订单都计入 outstanding；逾期的单独汇总', async () => {
    const c = await api('POST', '/api/customers', { company: 'Receivable Big Co' })
    const cid = c.json.id
    const now = Date.now()
    const ins = db.prepare(`INSERT INTO orders (id, number, customer_id, currency, amount, items, incoterm, payment_terms, deposit_amount, due_date, status, notes, org_id, owner_id, created_at, updated_at)
      VALUES (?, ?, ?, 'USD', 100, '[]', 'FOB', '', 0, ?, 'pending_production', '', 'local', 'local', ?, ?)`)
    db.exec('BEGIN')
    for (let i = 0; i < 501; i++) ins.run(`ord_reg${i}`, `SO-REG-${String(i).padStart(4, '0')}`, cid, i < 3 ? '2020-01-01' : '', now + i, now + i)
    db.exec('COMMIT')
    // 一个已收清、一个已取消：都不计入
    ins.run('ord_reg_paid', 'SO-REG-PAID', cid, '', now, now)
    db.prepare("INSERT INTO payments (id, order_id, amount, currency, received_at, method, reference, notes, created_by, source, created_at) VALUES ('pay_reg', 'ord_reg_paid', 100, 'USD', '2026-10-01', '', '', '', 'local', 'user', ?)").run(now)
    ins.run('ord_reg_cancel', 'SO-REG-CANCEL', cid, '', now, now)
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_reg_cancel'").run()
    const r = await api('GET', '/api/receivables')
    expect(r.status, r.text).toBe(200)
    expect(r.json.summary).toMatchObject({ openCount: 501, outstandingByCurrency: { USD: 50100 }, overdueCount: 3, overdueByCurrency: { USD: 300 } })
  })
})

describe('回收站自动清理分批循环直到清完', () => {
  it('前面的客户因名下还有没到期的记录被跳过时，后面的客户照样被清掉', async () => {
    const trash = await import('../src/services/trash-service.js')
    trash.setPurgeBatchForTest(1)
    try {
      const now = Date.now()
      const ids: string[] = []
      for (let i = 0; i < 4; i++) {
        const c = await api('POST', '/api/customers', { company: `Purge Co ${i}` })
        expect(c.status, c.text).toBe(201)
        expect((await api('DELETE', `/api/customers/${c.json.id}`)).status).toBeLessThan(300)
        ids.push(c.json.id)
      }
      // 三个客户名下有一张刚移入回收站（没到期）的订单：清理客户时会被拦下
      const ins = db.prepare(`INSERT INTO orders (id, number, customer_id, currency, amount, items, incoterm, payment_terms, deposit_amount, due_date, status, notes, org_id, owner_id, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, 'USD', 1, '[]', 'FOB', '', 0, '', 'cancelled', '', 'local', 'local', ?, ?, ?)`)
      const later = now + 35 * 86400_000
      const blocked = ids.slice(0, 3)
      blocked.forEach((id, i) => ins.run(`ord_purge${i}`, `SO-PURGE-${i}`, id, now, now, later))
      trash.trashService.autoPurge(now + 40 * 86400_000)
      const left = (id: string) => Boolean(db.prepare('SELECT 1 AS ok FROM customers WHERE id = ?').get(id))
      for (const id of blocked) expect(left(id)).toBe(true)
      expect(left(ids[3]!)).toBe(false)
    } finally {
      trash.setPurgeBatchForTest(500)
    }
  })
})
