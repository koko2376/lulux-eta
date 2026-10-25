// 端到端测试用的本机邮件服务：IMAP（hoodiecrow-imap，MIT）+ SMTP（smtp-server，MIT）。
// 用法：node e2e/fixtures/mail-server.mjs [imapPort=52143] [smtpPort=52025]
// - 账号 sales@lulux-demo.example.com / 授权码 demo-app-pass
// - 收件箱预置 4 封虚构来信（example.com 域名），SMTP 收到的邮件写入 <out>/sent.jsonl
// - GET http://127.0.0.1:<imapPort+1>/sent 查看 SMTP 已收到的邮件（测试断言用）
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { SMTPServer } from 'smtp-server'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')

const IMAP_PORT = Number(process.argv[2] || 52143)
const SMTP_PORT = Number(process.argv[3] || 52025)
export const USER = 'sales@lulux-demo.example.com'
export const PASS = 'demo-app-pass'

const crlf = (t) => t.replace(/\r?\n/g, '\r\n')
const date = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600_000).toUTCString()

const MAILS = [
  {
    h: 2,
    raw: `From: Hans Becker <hans.becker@nordlicht-armaturen.example.com>
To: Koko Chen <${USER}>
Subject: RFQ: Brass ball valves DN25 PN16 – 2,000 pcs, FOB Ningbo
Message-ID: <rfq-2031@nordlicht-armaturen.example.com>
Date: ${date(2)}
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

Dear Koko,

We are a valve distributor in Hamburg supplying installers across northern Germany.
Please quote your best price for:

- Brass ball valve DN25 PN16, full bore, lever handle – 2,000 pcs
- Brass ball valve DN32 PN16, full bore – 800 pcs

Terms: FOB Ningbo, delivery within 30 days after deposit. Please also confirm
CE / DVGW certification and your MOQ. Our drawing is attached.

Best regards,
Hans Becker
Purchasing Manager · Nordlicht Armaturen GmbH
--b1
Content-Type: text/plain; name="valve-spec-DN25.txt"
Content-Disposition: attachment; filename="valve-spec-DN25.txt"
Content-Transfer-Encoding: base64

${Buffer.from('DN25 PN16 brass CW617N, full bore, lever handle, thread ISO 228\n').toString('base64')}
--b1--
`,
  },
  {
    h: 5,
    raw: `From: Sofia Marquez <sofia@costa-import.example.com>
To: ${USER}
Subject: Catalogue and price list request
Message-ID: <cat-77@costa-import.example.com>
Date: ${date(5)}
Content-Type: text/plain; charset=utf-8

Hello,

We are an importer of plumbing fittings in Valencia, Spain. Could you share your
latest catalogue and price list? We are interested in PEX fittings and manifolds.

Gracias,
Sofia Marquez
`,
  },
  {
    h: 9,
    raw: `From: Growth Hacker <promo@rank-boost.example.com>
To: ${USER}
Subject: Rank #1 on Google in 7 days – guaranteed!!!
Message-ID: <promo-1@rank-boost.example.com>
Date: ${date(9)}
Content-Type: text/html; charset=utf-8

<html><body><h1>Cheap SEO backlinks</h1><p>Unsubscribe anytime.</p><script>alert(1)</script><img src="http://tracker.example.com/p.png"></body></html>
`,
  },
  {
    h: 26,
    raw: `From: Liam O'Connor <liam@harbourline.example.com>
To: ${USER}
Subject: Re: Sample shipment tracking
Message-ID: <hl-5@harbourline.example.com>
Date: ${date(26)}
Content-Type: text/plain; charset=utf-8

Hi Koko, the samples arrived in Dublin today. Our engineer will test them next week.
Liam
`,
  },
]

// 长文本用例：超长主题与发件人名，用于 UI 审计
MAILS.push({
  h: 50,
  raw: `From: "Maximilian-Alexander von Hohenzollern-Sigmaringen (Procurement Department, Central Europe)" <m.hohenzollern@very-long-company-name-international-holdings.example.com>
To: ${USER}
Subject: Request for quotation – stainless steel 316L sanitary butterfly valves DN50/DN65/DN80/DN100 with pneumatic actuators, limit switch boxes and EPDM/PTFE seats for a brewery expansion project in Bavaria (phase 2, tender ref. BRW-2026-0042-EXT)
Message-ID: <long-1@very-long-company-name-international-holdings.example.com>
Date: ${date(50)}
Content-Type: text/plain; charset=utf-8

Supercalifragilisticexpialidocious_part_numbers_without_spaces_SS316L-DN50-DN65-DN80-DN100-PNEUMATIC-ACTUATOR-LSB-EPDM-PTFE-0000000001
Please quote for the attached list.
`,
})

const imap = hoodiecrow({
  plugins: ['IDLE', 'CONDSTORE', 'UIDPLUS', 'SPECIAL-USE', 'ENABLE', 'SASL-IR', 'ID', 'LITERALPLUS', 'MOVE'],
  users: { [USER]: { password: PASS } },
  storage: {
    INBOX: { messages: MAILS.map((m) => ({ raw: crlf(m.raw), internaldate: new Date(Date.now() - m.h * 3600_000) })) },
    '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] } } },
  },
})
imap.listen(IMAP_PORT, '127.0.0.1', () => console.log(`[mail] IMAP on ${IMAP_PORT}`))

const sent = []
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  authMethods: ['PLAIN', 'LOGIN'],
  onAuth(auth, _s, cb) {
    if (auth.username === USER && auth.password === PASS) return cb(null, { user: auth.username })
    return cb(new Error('535 Authentication failed: invalid username or app password'))
  },
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', (c) => chunks.push(c))
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      sent.push({
        from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
        to: session.envelope.rcptTo.map((r) => r.address),
        subject: (raw.match(/^Subject: (.*)$/m) || [])[1] || '',
        size: raw.length,
        hasPdf: /application\/pdf/i.test(raw),
      })
      cb()
    })
  },
})
smtp.listen(SMTP_PORT, '127.0.0.1', () => console.log(`[mail] SMTP on ${SMTP_PORT}`))

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(req.url === '/sent' ? sent : { ok: true }))
}).listen(IMAP_PORT + 1, '127.0.0.1')
