import { createServer, request as httpRequest, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

const require = createRequire(import.meta.url)
// hoodiecrow-imap（MIT）：进程内可编程 IMAP 测试服务
const hoodiecrow = require('hoodiecrow-imap') as (options: unknown) => {
  listen(port: number, host: string, cb: () => void): void
  close(cb?: () => void): void
  server?: { address(): AddressInfo }
  address?(): AddressInfo
}

const USER = 'me@example.com'
const PASS = 'app-specific-pass'
const OAUTH_USER = 'oauth@example.com'
const OAUTH_ACCESS = 'ya29.test-access-token'

let server: TestServer
let imap: ReturnType<typeof hoodiecrow>
let imapPort = 0
let smtp: SMTPServer
let smtpPort = 0
let mock: Server
let mockUrl = ''
const received: Array<{ from: string; to: string[]; raw: Buffer; user: string }> = []
const llmRequests: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = []
const tokenRequests: URLSearchParams[] = []

const date = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toUTCString()
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n')

const INQUIRY = crlf(`From: Hans Becker <hans@acme-valves.de>
To: Me <${USER}>
Subject: Price inquiry for ball valves DN25
Message-ID: <inq-1@acme-valves.de>
Date: ${date(1)}
Content-Type: text/plain; charset=utf-8

Hello, please send your best price for 500 pcs ball valves DN25, FOB Ningbo.
`)

const SPAM = crlf(`From: SEO Pro <promo@newsletter-blast.com>
To: ${USER}
Subject: Rank #1 on Google today!!!
Message-ID: <spam-1@newsletter-blast.com>
Date: ${date(2)}
Content-Type: text/html; charset=utf-8

<html><body><h1>Cheap SEO</h1><script>alert(1)</script><img src="http://tracker.example/p.png"><a href="javascript:alert(2)" onclick="steal()">click</a><p style="background:url(http://x/y)">hi</p></body></html>
`)

const UNKNOWN = crlf(`From: Maria Lopez <maria@nuevo-import.es>
To: ${USER}
Subject: Catalogue request
Message-ID: <cat-1@nuevo-import.es>
Date: ${date(3)}
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

Hi, we are an importer in Spain. Could you share your catalogue? Our spec is attached.
--b1
Content-Type: text/plain; name="spec.txt"
Content-Disposition: attachment; filename="spec.txt"
Content-Transfer-Encoding: base64

${Buffer.from('DN25 PN16 brass, 500 pcs').toString('base64')}
--b1--
`)

const OLD = crlf(`From: Old <old@ancient.com>
To: ${USER}
Subject: Ancient mail
Message-ID: <old-1@ancient.com>
Date: ${date(400)}
Content-Type: text/plain

too old
`)

function startImap(): Promise<void> {
  imap = hoodiecrow({
    plugins: ['IDLE', 'CONDSTORE', 'UIDPLUS', 'SPECIAL-USE', 'ENABLE', 'SASL-IR', 'XOAUTH2', 'ID', 'LITERALPLUS', 'MOVE'],
    users: {
      [USER]: { password: PASS },
      [OAUTH_USER]: { password: 'unused-pass', xoauth2: { accessToken: OAUTH_ACCESS, sessionTimeout: 3600 } },
    },
    storage: {
      INBOX: {
        messages: [
          { raw: INQUIRY, internaldate: new Date(Date.now() - 1 * 86400_000) },
          { raw: SPAM, internaldate: new Date(Date.now() - 2 * 86400_000) },
          { raw: UNKNOWN, internaldate: new Date(Date.now() - 3 * 86400_000) },
          { raw: OLD, internaldate: new Date(Date.now() - 400 * 86400_000), flags: ['\\Seen'] },
        ],
      },
      '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] } } },
    },
  })
  return new Promise((resolve) => {
    imap.listen(0, '127.0.0.1', () => {
      imapPort = (imap.server ?? (imap as unknown as { address(): AddressInfo })).address().port
      resolve()
    })
  })
}

function startSmtp(): Promise<void> {
  smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
    onAuth(auth, _session, callback) {
      if (auth.method === 'XOAUTH2') {
        return auth.username === OAUTH_USER && auth.accessToken === OAUTH_ACCESS
          ? callback(null, { user: auth.username })
          : callback(null, { data: { status: '401' } })
      }
      if (auth.username === USER && auth.password === PASS) return callback(null, { user: auth.username })
      return callback(new Error('Invalid username or password'))
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks),
          user: String(session.user),
        })
        callback()
      })
    },
  })
  return new Promise((resolve) => {
    smtp.listen(0, '127.0.0.1', () => {
      smtpPort = (smtp.server.address() as AddressInfo).port
      resolve()
    })
  })
}

/** OpenAI 兼容 mock + OAuth token/userinfo mock */
function startMock(): Promise<void> {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      if (req.url === '/oauth/token') {
        const params = new URLSearchParams(raw)
        tokenRequests.push(params)
        const ok = params.get('grant_type') === 'refresh_token' ? params.get('refresh_token') === 'refresh-1' : params.get('code') === 'auth-code-1'
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(ok ? { access_token: OAUTH_ACCESS, refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' } : { error: 'invalid_grant' }))
        return
      }
      if (req.url === '/oauth/userinfo') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ email: OAUTH_USER, name: 'OAuth User' }))
        return
      }
      const body = JSON.parse(raw || '{}')
      llmRequests.push(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const system = String(body.messages[0]?.content ?? '')
      const last = body.messages[body.messages.length - 1]
      const toolCall = (name: string, args: unknown) =>
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }] } }] })
      if (system.includes('邮件分拣')) {
        send({ choices: [{ delta: { content: '{"verdict":"inquiry","reason":"进口商索要产品目录"}' } }] })
      } else if (system.includes('写信助手')) {
        send({ choices: [{ delta: { content: 'Dear Hans,\n\nThank you for your inquiry. ' } }] })
        send({ choices: [{ delta: { content: 'Please find our quotation attached.\n\nBest regards' } }] })
      } else if (last.role === 'user' && String(last.content).includes('查客户')) {
        toolCall('search_customers', { query: 'acme' })
      } else if (last.role === 'user' && String(last.content).includes('起草')) {
        toolCall('create_email_draft', { to: ['hans@acme-valves.de'], subject: 'Follow-up', text: 'Hi Hans, following up.' })
      } else if (last.role === 'user' && String(last.content).includes('发送')) {
        // 模型想直接“发送”：只能调草稿工具，没有发送工具
        const names = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name)
        send({ choices: [{ delta: { content: `可用工具：${names.join(',')}` } }] })
      } else if (last.role === 'tool') {
        send({ choices: [{ delta: { content: `完成：${String(last.content).slice(0, 60)}` } }] })
      } else {
        send({ choices: [{ delta: { content: '好的。' } }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    mock.listen(0, '127.0.0.1', () => {
      mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`
      resolve()
    })
  })
}

beforeAll(async () => {
  await Promise.all([startImap(), startSmtp(), startMock()])
  server = await startTestServer({
    LULUX_OAUTH_TEST_ENDPOINTS: JSON.stringify({
      google: { auth: 'https://accounts.example.test/auth', token: `${mockUrl}/oauth/token`, userinfo: `${mockUrl}/oauth/userinfo` },
    }),
    LULUX_PDF_FONT: '',
  })
}, 30_000)

afterAll(async () => {
  await server.close()
  await new Promise<void>((resolve) => smtp.close(() => resolve()))
  await new Promise<void>((resolve) => imap.close(() => resolve()))
  await new Promise<void>((resolve) => mock.close(() => resolve()))
})

const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })
const endpoints = () => ({
  imap: { host: '127.0.0.1', port: imapPort, secure: false },
  smtp: { host: '127.0.0.1', port: smtpPort, secure: false },
})

let accountId = ''
let acmeId = ''
const ids: Record<string, string> = {}

describe('邮箱账户', () => {
  it('预设包含常见服务商与授权码提示', async () => {
    const res = await api('GET', '/api/email/presets')
    const presetIds = res.json.map((p: { id: string }) => p.id)
    for (const id of ['gmail', 'outlook', 'office365', 'qq', 'exmail-qq', '163', '126', 'aliyun-qiye', 'zoho']) expect(presetIds).toContain(id)
    const qq = res.json.find((p: { id: string }) => p.id === 'qq')
    expect(qq).toMatchObject({ imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465 } })
    expect(qq.authHint).toContain('授权码')
  })

  it('测试连接：错误密码 → EMAIL_AUTH_FAILED；连不上 → EMAIL_CONNECT_FAILED；正确 → ok', async () => {
    const bad = await api('POST', '/api/email/accounts/test', { email: USER, ...endpoints(), password: 'wrong' })
    expect(bad.status).toBe(200)
    expect(bad.json.ok).toBe(false)
    expect(bad.json.imap.code).toBe('EMAIL_AUTH_FAILED')
    expect(bad.json.smtp.code).toBe('EMAIL_AUTH_FAILED')
    const down = await api('POST', '/api/email/accounts/test', { email: USER, imap: { host: '127.0.0.1', port: 1, secure: false }, smtp: { host: '127.0.0.1', port: 1, secure: false }, password: 'x' })
    expect(down.json.imap.code).toBe('EMAIL_CONNECT_FAILED')
    const ok = await api('POST', '/api/email/accounts/test', { email: USER, ...endpoints(), password: PASS })
    expect(ok.json).toMatchObject({ ok: true, imap: { ok: true, folders: { inbox: 'INBOX', sent: 'Sent' } }, smtp: { ok: true } })
  })

  it('新建账户：保存前校验，密码加密且不回传', async () => {
    const bad = await api('POST', '/api/email/accounts', { email: USER, ...endpoints(), password: 'wrong' })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('EMAIL_AUTH_FAILED')
    const res = await api('POST', '/api/email/accounts', { email: USER, displayName: 'Koko Trading', ...endpoints(), password: PASS, signature: '-- \nKoko' })
    expect(res.status, res.text).toBe(201)
    accountId = res.json.id
    expect(res.json).toMatchObject({ email: USER, authType: 'password', hasSecret: true, folders: { inbox: 'INBOX', sent: 'Sent' }, syncDays: 30, ownerId: 'local' })
    expect(res.text).not.toContain(PASS)
    const { db } = await import('../src/db.js')
    const stored = db.prepare('SELECT secret FROM email_accounts WHERE id = ?').get(accountId) as { secret: string }
    expect(stored.secret.startsWith('enc:v1:')).toBe(true)
    expect((await api('POST', '/api/email/accounts', { email: USER, ...endpoints(), password: PASS })).json.error.code).toBe('EMAIL_ACCOUNT_EXISTS')
    expect((await api('GET', '/api/email/accounts')).json).toHaveLength(1)
  })
})

describe('同步 → 判定 → 关联客户', () => {
  it('准备规则与已有客户', async () => {
    await api('POST', '/api/inquiry-rules', { name: '询价', priority: 10, conditions: [{ field: 'subject', op: 'regex', value: 'price|quotation|inquiry' }], action: 'inquiry' })
    await api('POST', '/api/inquiry-rules', { name: '推广域名', priority: 20, conditions: [{ field: 'domain', op: 'contains', value: 'newsletter' }], action: 'spam' })
    const acme = await api('POST', '/api/customers', { company: 'ACME Valves GmbH', website: 'https://www.acme-valves.de' })
    acmeId = acme.json.id
  })

  it('首次同步只拉最近 N 天；按规则判定；按域名自动关联', async () => {
    const res = await api('POST', `/api/email/accounts/${accountId}/sync`, { wait: true })
    expect(res.status, res.text).toBe(200)
    expect(res.json.newMessages).toBe(3)
    expect(res.json.verdicts).toEqual({ inquiry: 1, spam: 1, review: 1 })
    expect(res.json.linkedToCustomers).toBe(1)
    expect(res.json.folders.map((f: { role: string }) => f.role)).toEqual(['inbox', 'sent'])

    const list = await server.request('GET', '/api/email/messages?folder=inbox')
    expect(list.json.total).toBe(3)
    for (const item of list.json.items) ids[item.messageId] = item.id
    const inquiry = list.json.items.find((m: { messageId: string }) => m.messageId === '<inq-1@acme-valves.de>')
    expect(inquiry).toMatchObject({ verdict: 'inquiry', verdictSource: 'rule', verdictReason: '规则「询价」', customerId: acmeId, customerName: 'ACME Valves GmbH', seen: false })
    expect(inquiry.text).toBeUndefined()
    // 同步时自动给询盘打分：已有客户 + 公司域名 + 写了数量/规格/术语 → A 级；垃圾邮件不打分
    expect(inquiry.inquiryGrade).toBe('A')
    expect(inquiry.inquiryScore).toBeGreaterThanOrEqual(75)
    expect(list.json.items.find((m: { messageId: string }) => m.messageId === '<spam-1@newsletter-blast.com>').inquiryScore).toBeNull()
    const detail = (await server.request('GET', `/api/email/messages/${inquiry.id}`)).json
    expect(detail.inquiry.reasons.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['existing_customer', 'company_domain', 'quantity', 'product', 'terms']))
    expect(detail.inquiry.language).toBe('en')
    expect(list.json.items.some((m: { subject: string }) => m.subject === 'Ancient mail')).toBe(false)
    expect((await server.request('GET', '/api/email/messages?verdict=spam')).json.items[0].from.address).toBe('promo@newsletter-blast.com')
    expect((await server.request(`GET`, `/api/email/messages?customerId=${acmeId}`)).json.total).toBe(1)
    expect((await server.request('GET', '/api/email/messages?query=catalogue')).json.total).toBe(1)
  })

  it('增量同步不重复；新邮件到达后只拉新的', async () => {
    const again = await api('POST', `/api/email/accounts/${accountId}/sync`, { wait: true })
    expect(again.json.newMessages).toBe(0)
    const client = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: USER, pass: PASS }, logger: false })
    await client.connect()
    await client.append('INBOX', crlf(`From: hans@acme-valves.de\nTo: ${USER}\nSubject: Re: quotation follow up\nMessage-ID: <inq-2@acme-valves.de>\nIn-Reply-To: <inq-1@acme-valves.de>\nReferences: <inq-1@acme-valves.de>\nDate: ${new Date().toUTCString()}\n\nAny update?\n`))
    await client.logout()
    const third = await api('POST', `/api/email/accounts/${accountId}/sync`, { wait: true })
    expect(third.json.newMessages).toBe(1)
    const thread = await server.request('GET', `/api/email/messages?threadKey=${encodeURIComponent('<inq-1@acme-valves.de>')}`)
    expect(thread.json.total).toBe(2)
  })

  it('邮件详情、HTML 清洗、附件按需下载', async () => {
    const detail = await server.request('GET', `/api/email/messages/${ids['<cat-1@nuevo-import.es>']}`)
    expect(detail.json.text).toContain('importer in Spain')
    expect(detail.json.attachments).toHaveLength(1)
    expect(detail.json.attachments[0]).toMatchObject({ filename: 'spec.txt', downloaded: false })
    const file = await server.request('GET', `/api/email/attachments/${detail.json.attachments[0].id}`)
    expect(file.status).toBe(200)
    expect(file.text).toBe('DN25 PN16 brass, 500 pcs')
    expect(file.headers['content-disposition']).toContain('spec.txt')
    expect(file.headers['x-content-type-options']).toBe('nosniff')
    expect((await server.request('GET', `/api/email/messages/${ids['<cat-1@nuevo-import.es>']}`)).json.attachments[0].downloaded).toBe(true)

    const html = await server.request('GET', `/api/email/messages/${ids['<spam-1@newsletter-blast.com>']}/html`)
    expect(html.status).toBe(200)
    expect(html.headers['content-security-policy']).toContain("default-src 'none'")
    expect(html.text).toContain('Cheap SEO')
    expect(html.text).not.toMatch(/<script|onclick|javascript:|\ssrc="http|url\(/i)
    expect(html.text).toContain('data-blocked-src="http://tracker.example/p.png"')
    expect((await server.request('GET', `/api/email/messages/${ids['<inq-1@acme-valves.de>']}/html`)).json.error.code).toBe('NO_HTML')
  })

  it('标记已读写回 IMAP；人工改判定', async () => {
    const patched = await api('PATCH', `/api/email/messages/${ids['<inq-1@acme-valves.de>']}`, { seen: true, flagged: true })
    expect(patched.json).toMatchObject({ seen: true, flagged: true })
    const manual = await api('PATCH', `/api/email/messages/${ids['<spam-1@newsletter-blast.com>']}`, { verdict: 'review' })
    expect(manual.json).toMatchObject({ verdict: 'review', verdictSource: 'manual' })
    await new Promise((r) => setTimeout(r, 300))
    const client = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: USER, pass: PASS }, logger: false })
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    const flags: string[] = []
    for await (const msg of client.fetch('1:*', { flags: true, envelope: true })) {
      if (msg.envelope?.messageId === '<inq-1@acme-valves.de>') flags.push(...(msg.flags ?? []))
    }
    lock.release()
    await client.logout()
    expect(flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))
  })

  it('灰区邮件用模型二次判定（返回理由）', async () => {
    await api('POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockUrl}/v1`, apiKey: 'sk-test-1234567890', model: 'mock-1' })
    const res = await api('POST', `/api/email/messages/${ids['<cat-1@nuevo-import.es>']}/classify`, { useModel: true })
    expect(res.status, res.text).toBe(200)
    expect(res.json).toMatchObject({ verdict: 'inquiry', verdictSource: 'model' })
    expect(res.json.verdictReason).toContain('进口商索要产品目录')
    const prompt = llmRequests.at(-1)!.messages.map((m) => m.content).join('\n')
    expect(prompt).toContain('不可信')
  })

  it('一键从邮件建客户并记 Activity；重复 409', async () => {
    const res = await api('POST', `/api/email/messages/${ids['<cat-1@nuevo-import.es>']}/create-customer`, { country: 'ES' })
    expect(res.status, res.text).toBe(201)
    expect(res.json.customer).toMatchObject({ company: 'Nuevo-import', website: 'https://nuevo-import.es', country: 'ES', source: '邮件' })
    expect(res.json.customer.contacts[0]).toMatchObject({ name: 'Maria Lopez', email: 'maria@nuevo-import.es', isPrimary: true })
    expect(res.json.message.customerId).toBe(res.json.customer.id)
    const activities = await server.request('GET', `/api/customers/${res.json.customer.id}/activities`)
    expect(activities.json[0]).toMatchObject({ type: 'email' })
    expect(activities.json[0].content).toContain('Catalogue request')
    expect((await api('POST', `/api/email/messages/${ids['<cat-1@nuevo-import.es>']}/create-customer`, {})).json.error.code).toBe('ALREADY_LINKED')
  })
})

describe('回信：AI 草稿 → 附报价 PDF → 发送 → 对方收到', () => {
  let draftId = ''
  let quoteId = ''

  it('报价 PDF（浏览器态）', async () => {
    const quote = await api('POST', '/api/quotes', { customerId: acmeId, currency: 'EUR', incoterm: 'FOB', port: 'Ningbo', items: [{ name: 'Ball valve DN25', spec: 'PN16 brass', qty: 500, unit: 'pcs', unitPrice: 3.2 }] })
    quoteId = quote.json.id
    const pdf = await server.request('GET', `/api/quotes/${quoteId}/pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.text.startsWith('%PDF')).toBe(true)
    expect(['cjk', 'fallback']).toContain(pdf.headers['x-lulux-pdf-font'])
  })

  it('AI 生成回信草稿：引用原邮件、客户与报价，自动填收件人/主题/签名', async () => {
    const res = await api('POST', '/api/email/drafts/generate', { messageId: ids['<inq-1@acme-valves.de>'], quoteId, instructions: '语气正式' })
    expect(res.status, res.text).toBe(201)
    draftId = res.json.id
    expect(res.json).toMatchObject({
      accountId,
      replyToMessageId: ids['<inq-1@acme-valves.de>'],
      customerId: acmeId,
      quoteId,
      to: [{ name: 'Hans Becker', address: 'hans@acme-valves.de' }],
      subject: 'Re: Price inquiry for ball valves DN25',
      attachQuotePdf: true,
      source: 'ai',
      status: 'draft',
      ai: { providerName: 'Mock', model: 'mock-1' },
    })
    expect(res.json.text).toContain('Dear Hans')
    expect(res.json.text).toContain('Koko')
    const prompt = llmRequests.at(-1)!.messages.map((m) => m.content).join('\n')
    expect(prompt).toContain('ACME Valves GmbH')
    expect(prompt).toContain('Ball valve DN25')
    expect(prompt).toContain('500 pcs ball valves')
    expect(received).toHaveLength(0) // 生成草稿绝不发送
  })

  it('草稿可编辑、可上传附件（桌面端 printToPDF 的结果）', async () => {
    const patched = await api('PATCH', `/api/email/drafts/${draftId}`, { cc: ['boss@acme-valves.de'], text: 'Dear Hans,\n\nPlease see attached quotation.\n\n-- \nKoko' })
    expect(patched.json.cc).toEqual([{ name: '', address: 'boss@acme-valves.de' }])
    const att = await api('POST', `/api/email/drafts/${draftId}/attachments`, { filename: 'certificate.txt', contentType: 'text/plain', dataBase64: Buffer.from('CE certificate').toString('base64') })
    expect(att.status).toBe(201)
    expect(att.json).toMatchObject({ filename: 'certificate.txt', size: 14 })
  })

  it('显式 send → SMTP 投递（含报价 PDF、In-Reply-To）→ 已发送 → Activity → 审计', async () => {
    const res = await api('POST', `/api/email/drafts/${draftId}/send`)
    expect(res.status, res.text).toBe(200)
    expect(res.json.draft).toMatchObject({ status: 'sent', error: null })
    expect(res.json.message).toMatchObject({ folder: 'sent', customerId: acmeId, subject: 'Re: Price inquiry for ball valves DN25' })

    expect(received).toHaveLength(1)
    const mail = received[0]!
    expect(mail.from).toBe(USER)
    expect(mail.to.sort()).toEqual(['boss@acme-valves.de', 'hans@acme-valves.de'])
    const parsed = await simpleParser(mail.raw)
    expect(parsed.inReplyTo).toBe('<inq-1@acme-valves.de>')
    expect(parsed.text).toContain('Please see attached quotation')
    const names = parsed.attachments.map((a) => a.filename)
    expect(names).toContain('certificate.txt')
    const pdf = parsed.attachments.find((a) => a.contentType === 'application/pdf')
    expect(pdf?.filename).toMatch(/^Q-\d{8}-\d{3}\.pdf$/)
    expect(pdf?.content.subarray(0, 4).toString()).toBe('%PDF')

    const activities = await server.request('GET', `/api/customers/${acmeId}/activities`)
    expect(activities.json.some((a: { type: string; content: string }) => a.type === 'email' && a.content.includes('发送邮件'))).toBe(true)
    expect((await server.request('GET', `/api/customers/${acmeId}`)).json.stage).toBe('quoted')
    expect((await server.request('GET', `/api/quotes/${quoteId}`)).json.status).toBe('sent')
    const audit = await server.request('GET', '/api/audit?action=email.send')
    expect(audit.json.total).toBe(1)
    expect(audit.text).not.toContain('Please see attached')

    expect((await api('POST', `/api/email/drafts/${draftId}/send`)).json.error.code).toBe('DRAFT_ALREADY_SENT')
    expect((await api('PATCH', `/api/email/drafts/${draftId}`, { subject: 'x' })).json.error.code).toBe('DRAFT_ALREADY_SENT')
  })

  it('已 APPEND 到 IMAP 已发送；再次同步按 Message-ID 合并，不重复', async () => {
    const res = await api('POST', `/api/email/accounts/${accountId}/sync`, { wait: true })
    expect(res.json.newMessages).toBe(0)
    const sent = await server.request('GET', '/api/email/messages?folder=sent')
    expect(sent.json.total).toBe(1)
    expect(sent.json.items[0].uid).toBeGreaterThan(0)
  })

  it('没有收件人 → 400 NO_RECIPIENTS；SMTP 拒绝 → 502 并保留草稿为 failed', async () => {
    const empty = await api('POST', '/api/email/drafts', { accountId, subject: 'x', text: 'y' })
    expect((await api('POST', `/api/email/drafts/${empty.json.id}/send`)).json.error.code).toBe('NO_RECIPIENTS')
    // 密码被改错（模拟授权码过期）
    const { db } = await import('../src/db.js')
    const { encryptSecret } = await import('../src/security/secrets.js')
    const original = (db.prepare('SELECT secret FROM email_accounts WHERE id = ?').get(accountId) as { secret: string }).secret
    db.prepare('UPDATE email_accounts SET secret = ? WHERE id = ?').run(encryptSecret('expired'), accountId)
    await api('PATCH', `/api/email/drafts/${empty.json.id}`, { to: ['x@y.com'] })
    const failed = await api('POST', `/api/email/drafts/${empty.json.id}/send`)
    expect(failed.status).toBe(502)
    expect(failed.json.error.code).toBe('EMAIL_SEND_FAILED')
    expect((await server.request('GET', `/api/email/drafts/${empty.json.id}`)).json).toMatchObject({ status: 'failed' })
    db.prepare('UPDATE email_accounts SET secret = ? WHERE id = ?').run(original, accountId)
  })
})

describe('Agent 内置业务工具', () => {
  let sessionId = ''

  it('read 工具自动执行（ask 模式也不需要批准），结果进入上下文', async () => {
    // 断言完整业务工具列表（按需加载见 toolsets.test.ts）
    await api('PATCH', '/api/settings', { toolLoading: 'all' })
    sessionId = (await api('POST', '/api/sessions', { title: 'agent' })).json.session.id
    const res = await api('POST', '/api/chat', { sessionId, content: '帮我查客户 acme' })
    const events = parseSse(res.text)
    const request = events.find((e) => e.event === 'tool_request')
    expect(request?.data).toMatchObject({ name: 'search_customers', server: 'LULUX', builtin: true, risk: 'read', auto: true })
    const result = events.find((e) => e.event === 'tool_result')
    expect(result?.data).toMatchObject({ ok: true, approved: true, builtin: true })
    expect(result?.data.result).toContain('ACME Valves GmbH')
    const tools = llmRequests.at(-2)!.tools!.map((t) => t.function.name)
    expect(tools).toEqual(expect.arrayContaining(['search_customers', 'get_customer', 'create_customer', 'create_quote_draft', 'search_emails', 'create_email_draft']))
    expect(tools.some((name) => /send/i.test(name))).toBe(false)
  })

  it('write 工具走审批：拒绝则不创建；批准后只建草稿，不会发送', async () => {
    const before = received.length
    const draftsBefore = (await server.request('GET', '/api/email/drafts')).json.length
    // ask 模式：并行发出拒绝决定
    const chat = api('POST', '/api/chat', { sessionId, content: '起草一封跟进邮件' })
    let requestId = ''
    for (let i = 0; i < 50 && !requestId; i += 1) {
      await new Promise((r) => setTimeout(r, 100))
      const { getPendingIdsForTests } = await import('../src/services/tool-approval.js')
      requestId = getPendingIdsForTests()[0] ?? ''
    }
    expect(requestId).not.toBe('')
    expect((await api('POST', '/api/chat/tool-decision', { requestId, approved: false })).status).toBe(200)
    const denied = parseSse((await chat).text).find((e) => e.event === 'tool_result')
    expect(denied?.data).toMatchObject({ approved: false, risk: 'write' })
    expect((await server.request('GET', '/api/email/drafts')).json.length).toBe(draftsBefore)

    await api('PATCH', '/api/settings', { toolApproval: 'auto' })
    const approved = parseSse((await api('POST', '/api/chat', { sessionId, content: '起草一封跟进邮件' })).text).find((e) => e.event === 'tool_result')
    expect(approved?.data).toMatchObject({ ok: true, approved: true, name: 'create_email_draft' })
    expect(approved?.data.result).toContain('"sent": false')
    const drafts = (await server.request('GET', '/api/email/drafts?status=draft')).json
    const agentDraft = drafts.find((d: { source: string }) => d.source === 'agent')
    expect(agentDraft).toMatchObject({ subject: 'Follow-up', to: [{ address: 'hans@acme-valves.de' }], status: 'draft' })
    expect(received.length).toBe(before)
    await api('PATCH', '/api/settings', { toolApproval: 'ask' })
  })

  it('builtinTools=0 时不提供内置工具', async () => {
    await api('PATCH', '/api/settings', { builtinTools: false })
    await api('POST', '/api/chat', { sessionId, content: '请发送邮件' })
    const tools = llmRequests.at(-1)!.tools
    expect(tools ?? []).toHaveLength(0)
    await api('PATCH', '/api/settings', { builtinTools: true })
  })
})

describe('实时事件', () => {
  it('GET /api/events 推送 email.account / email.sync', async () => {
    const events: string[] = []
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path: '/api/events', headers: { Host: `127.0.0.1:${server.port}`, Authorization: `Bearer ${TEST_TOKEN}` } })
    const done = new Promise<void>((resolve) => {
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) if (line.startsWith('event: ')) events.push(line.slice(7))
          if (events.includes('email.sync')) resolve()
        })
      })
    })
    req.end()
    await new Promise((r) => setTimeout(r, 200))
    await api('POST', `/api/email/accounts/${accountId}/sync`, { wait: true })
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))])
    req.destroy()
    expect(events).toContain('ping')
    expect(events).toContain('email.account')
    expect(events).toContain('email.sync')
  })
})

describe('OAuth2（PKCE + 回环回调 + XOAUTH2 + 自动刷新）', () => {
  let oauthAccountId = ''

  it('未配置 Client ID → 400；配置后 Secret 不回传，给出需登记的回调地址', async () => {
    expect((await api('POST', '/api/email/oauth/start', { provider: 'google' })).json.error.code).toBe('OAUTH_NOT_CONFIGURED')
    const cfg = await api('PUT', '/api/email/oauth/config', { google: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'gsecret' } })
    expect(cfg.json.google).toEqual({ clientId: 'cid.apps.googleusercontent.com', hasClientSecret: true })
    expect(cfg.json.redirectUris.google).toBe(`http://127.0.0.1:${server.port}/oauth/callback`)
    expect(cfg.json.redirectUris.microsoft).toBe('http://localhost/oauth/callback')
    expect(cfg.text).not.toContain('gsecret')
  })

  it('start → authUrl 含 S256 challenge；回调换 token、读邮箱、建账户；status=done', async () => {
    const start = await api('POST', '/api/email/oauth/start', { provider: 'google' })
    expect(start.status).toBe(200)
    const url = new URL(start.json.authUrl)
    expect(url.origin).toBe('https://accounts.example.test')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('scope')).toContain('https://mail.google.com/')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect((await server.request('GET', `/api/email/oauth/status/${start.json.state}`)).json.status).toBe('pending')

    const bad = await server.request('GET', `/oauth/callback?state=nope&code=x`, { token: null })
    expect(bad.status).toBe(400)
    const cb = await server.request('GET', `/oauth/callback?state=${start.json.state}&code=auth-code-1`, { token: null })
    expect(cb.status, cb.text).toBe(200)
    expect(cb.text).toContain('授权完成')
    expect(cb.headers['content-security-policy']).toContain("default-src 'none'")
    const exchange = tokenRequests.at(-1)!
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(exchange.get('client_secret')).toBe('gsecret')
    expect(exchange.get('redirect_uri')).toBe(start.json.redirectUri)

    const status = await server.request('GET', `/api/email/oauth/status/${start.json.state}`)
    expect(status.json.status).toBe('done')
    oauthAccountId = status.json.accountId
    const account = (await server.request('GET', '/api/email/accounts')).json.find((a: { id: string }) => a.id === oauthAccountId)
    expect(account).toMatchObject({ email: OAUTH_USER, authType: 'oauth2', oauthProvider: 'google', presetId: 'gmail', imap: { host: 'imap.gmail.com' } })
    // 重放同一个 state 无效
    expect((await server.request('GET', `/oauth/callback?state=${start.json.state}&code=auth-code-1`, { token: null })).status).toBe(400)
  })

  it('XOAUTH2 同步与发送；access token 过期自动刷新', async () => {
    const patched = await api('PATCH', `/api/email/accounts/${oauthAccountId}`, endpoints())
    expect(patched.status, patched.text).toBe(200)
    const { db } = await import('../src/db.js')
    db.prepare('UPDATE email_accounts SET oauth_expires_at = ? WHERE id = ?').run(Date.now() - 1000, oauthAccountId)
    const refreshesBefore = tokenRequests.filter((p) => p.get('grant_type') === 'refresh_token').length
    const sync = await api('POST', `/api/email/accounts/${oauthAccountId}/sync`, { wait: true })
    expect(sync.status, sync.text).toBe(200)
    expect(sync.json.newMessages).toBeGreaterThan(0)
    expect(tokenRequests.filter((p) => p.get('grant_type') === 'refresh_token').length).toBe(refreshesBefore + 1)

    const draft = await api('POST', '/api/email/drafts', { accountId: oauthAccountId, to: ['buyer@example.org'], subject: 'via oauth', text: 'hello' })
    const before = received.length
    const sent = await api('POST', `/api/email/drafts/${draft.json.id}/send`)
    expect(sent.status, sent.text).toBe(200)
    expect(received.length).toBe(before + 1)
    expect(received.at(-1)!.user).toBe(OAUTH_USER)
  })

  it('refresh token 失效 → needs_reauth + 409 EMAIL_REAUTH_REQUIRED', async () => {
    const { db } = await import('../src/db.js')
    const { encryptSecret } = await import('../src/security/secrets.js')
    db.prepare('UPDATE email_accounts SET oauth_expires_at = ?, secret = ? WHERE id = ?').run(Date.now() - 1000, encryptSecret('revoked'), oauthAccountId)
    const res = await api('POST', `/api/email/accounts/${oauthAccountId}/sync`, { wait: true })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('EMAIL_REAUTH_REQUIRED')
    const account = (await server.request('GET', '/api/email/accounts')).json.find((a: { id: string }) => a.id === oauthAccountId)
    expect(account.status.state).toBe('needs_reauth')
  })
})

describe('删除账户', () => {
  it('删除后邮件与草稿一并清理', async () => {
    expect((await api('DELETE', `/api/email/accounts/${accountId}`)).status).toBe(204)
    expect((await server.request('GET', `/api/email/messages?accountId=${accountId}`)).status).toBe(404)
    const { db } = await import('../src/db.js')
    expect((db.prepare('SELECT COUNT(*) AS n FROM email_messages WHERE account_id = ?').get(accountId) as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM email_drafts WHERE account_id = ?').get(accountId) as { n: number }).n).toBe(0)
  })
})
