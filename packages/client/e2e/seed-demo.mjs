// 为截图 / UI 审计准备真实感但虚构的数据（全部 example.com 域名）。
// 用法：node e2e/seed-demo.mjs desktop <apiBase> <dataDir> <mailLlmPort> <imapPort> <smtpPort>
//      node e2e/seed-demo.mjs team <apiBase> <dataDir>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, apiBase, dataDir, llmPort = '52999', imapPort = '52143', smtpPort = '52025'] = process.argv.slice(2)
let token = mode === 'desktop' ? readFileSync(join(dataDir, 'api-token'), 'utf8').trim() : ''

async function call(method, path, body) {
  const res = await fetch(apiBase + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
  return text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : undefined
}
const post = (p, b) => call('POST', p, b ?? {})
const patch = (p, b) => call('PATCH', p, b)

const CUSTOMERS = [
  [
    'Nordlicht Armaturen GmbH',
    'Germany',
    'negotiating',
    ['阀门', '分销商'],
    'Hans Becker',
    'Purchasing Manager',
    'hans.becker@nordlicht-armaturen.example.com',
  ],
  [
    'Costa Import S.L.',
    'Spain',
    'contacted',
    ['PEX', '进口商'],
    'Sofia Marquez',
    'Owner',
    'sofia@costa-import.example.com',
  ],
  ['Harbourline Imports Ltd', 'Ireland', 'quoted', ['样品'], "Liam O'Connor", 'Buyer', 'liam@harbourline.example.com'],
  [
    'Atlas Bouw B.V.',
    'Netherlands',
    'won',
    ['工程商', '老客户'],
    'Daan de Vries',
    'Project Lead',
    'daan@atlasbouw.example.com',
  ],
  [
    'Kiwi Plumb Supplies',
    'New Zealand',
    'lead',
    ['展会'],
    'Aroha Ngata',
    'Category Manager',
    'aroha@kiwiplumb.example.com',
  ],
  [
    'Maple Ridge Hardware Inc.',
    'Canada',
    'quoted',
    ['五金'],
    'Ethan Clarke',
    'Sourcing',
    'ethan@mapleridge.example.com',
  ],
  ['Sahara Trading FZE', 'UAE', 'contacted', ['中东'], 'Omar Haddad', 'GM', 'omar@sahara-trading.example.com'],
  [
    'Pampas Agro S.A.',
    'Argentina',
    'lost',
    ['价格敏感'],
    'Lucía Fernández',
    'Compras',
    'lucia@pampas-agro.example.com',
  ],
  [
    'Fjord Marine AS',
    'Norway',
    'negotiating',
    ['船用', '认证'],
    'Ingrid Solberg',
    'Technical Buyer',
    'ingrid@fjordmarine.example.com',
  ],
  ['Sakura Living K.K.', 'Japan', 'lead', ['零售'], 'Yuki Tanaka', 'Merchandiser', 'yuki@sakura-living.example.com'],
  [
    'Maximilian-Alexander von Hohenzollern-Sigmaringen International Industrial Valve & Fluid Control Holdings GmbH & Co. KG',
    'Germany',
    'lead',
    ['超长名称测试', '啤酒厂项目', '不锈钢', '气动执行器', '招标'],
    'Maximilian-Alexander von Hohenzollern-Sigmaringen',
    'Head of Procurement, Central Europe',
    'm.hohenzollern@very-long-company-name-international-holdings.example.com',
  ],
]

async function seedDesktop() {
  const { provider } = await post('/api/providers', {
    name: 'LULUX 演示模型',
    kind: 'openai',
    baseUrl: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: 'sk-demo-00000000abcd',
    model: 'lulux-demo-model',
    models: ['lulux-demo-model', 'lulux-demo-model-mini'],
  })
  await post('/api/providers', {
    name: 'Demo Provider With An Unusually Long Display Name For Layout Testing',
    kind: 'openai',
    baseUrl: 'https://llm-gateway.example.com/v1',
    apiKey: 'sk-demo-11111111wxyz',
    model: 'demo-provider-with-an-extraordinarily-long-model-identifier-2026-10-20-preview-instruct',
    models: ['demo-provider-with-an-extraordinarily-long-model-identifier-2026-10-20-preview-instruct'],
  })
  await patch('/api/settings', {
    defaultProviderId: provider.id,
    emailSyncIntervalMinutes: 0,
    allowMcpWithoutNativeConfirm: true,
  })

  for (const rule of [
    {
      name: 'RFQ / 询价',
      action: 'inquiry',
      priority: 30,
      conditions: [{ field: 'subject', op: 'regex', value: '(?i)(rfq|request for quotation|询价)' }],
    },
    {
      name: '索要目录与价格表',
      action: 'inquiry',
      priority: 20,
      conditions: [{ field: 'body', op: 'regex', value: '(?i)(price list|catalogue|catalog)' }],
    },
    {
      name: 'SEO / 推广',
      action: 'spam',
      priority: 10,
      conditions: [{ field: 'domain', op: 'contains', value: 'rank-boost' }],
    },
  ]) {
    await post('/api/inquiry-rules', { enabled: true, ...rule }).catch(async () => {
      // 服务端不支持 (?i) 时退化为不区分大小写的包含
      await post('/api/inquiry-rules', {
        enabled: true,
        ...rule,
        conditions: [
          {
            ...rule.conditions[0],
            op: 'contains',
            value: rule.name.includes('RFQ')
              ? 'RFQ'
              : rule.conditions[0].value.includes('price')
                ? 'price list'
                : 'rank-boost',
          },
        ],
      })
    })
  }
  await post('/api/quote-templates', {
    name: '明川外贸 · 标准英文报价',
    isDefault: true,
    company: {
      name: 'Mingchuan Trading Co., Ltd.',
      address: 'No. 88 Binhai Road, Ningbo, China',
      phone: '+86 574 0000 0000',
      email: 'sales@lulux-demo.example.com',
      logoDataUrl: '',
    },
    defaultIncoterm: 'FOB',
    defaultCurrency: 'USD',
    defaultPaymentTerms: '30% T/T deposit, 70% against B/L copy',
    footer: 'Prices valid for 30 days. Bank: Example Bank Ningbo Branch.',
  }).catch(() => undefined)
  const products = []
  for (const p of [
    ['BV-DN25', 'Brass ball valve DN25 PN16', 'Full bore, lever handle, CW617N', 'pcs', 3.85, 500, '8481803190'],
    ['BV-DN32', 'Brass ball valve DN32 PN16', 'Full bore, lever handle', 'pcs', 5.6, 500, '8481803190'],
    ['PEX-M4', 'PEX manifold 4-way', 'Brass, 1" × 1/2"', 'set', 18.4, 100, '7412200000'],
  ]) {
    products.push(
      await post('/api/products', {
        sku: p[0],
        name: p[1],
        spec: p[2],
        unit: p[3],
        price: p[4],
        currency: 'USD',
        moq: p[5],
        hsCode: p[6],
      }).catch(() => null),
    )
  }
  const ids = {}
  for (const [company, country, stage, tags, name, title, email] of CUSTOMERS) {
    const c = await post('/api/customers', {
      company,
      country,
      stage,
      tags,
      source: tags.includes('展会') ? 'Canton Fair' : 'Inbound email',
      website: `https://${email.split('@')[1]}`,
      notes: '',
      contacts: [{ name, title, email, phone: '', whatsapp: '', isPrimary: true }],
    })
    ids[company] = c.id ?? c.customer?.id
  }
  const nord = ids['Nordlicht Armaturen GmbH']
  for (const content of [
    '电话沟通：对方年采购量约 3 万只，关注 DVGW 认证',
    '已寄 DN25 样品 2 只，DHL 运单 0000000000',
  ]) {
    await post(`/api/customers/${nord}/activities`, { type: 'note', content })
  }
  const items = [
    {
      productId: null,
      name: 'Brass ball valve DN25 PN16',
      spec: 'Full bore, lever handle',
      qty: 2000,
      unit: 'pcs',
      unitPrice: 3.85,
    },
    { productId: null, name: 'Brass ball valve DN32 PN16', spec: 'Full bore', qty: 800, unit: 'pcs', unitPrice: 5.6 },
  ]
  const q = await post('/api/quotes', {
    customerId: nord,
    currency: 'USD',
    incoterm: 'FOB',
    port: 'Ningbo',
    validUntil: '2026-11-20',
    paymentTerms: '30% T/T deposit, 70% against B/L copy',
    leadTime: '25 days after deposit',
    items,
    notes: 'CE marked. DVGW certificate on request.',
    status: 'sent',
  })
  for (const [name, status] of [
    ['Atlas Bouw B.V.', 'accepted'],
    ['Maple Ridge Hardware Inc.', 'draft'],
    ['Harbourline Imports Ltd', 'sent'],
  ]) {
    await post('/api/quotes', {
      customerId: ids[name],
      currency: name.includes('Maple') ? 'CAD' : 'EUR',
      incoterm: 'CIF',
      port: 'Rotterdam',
      validUntil: '2026-11-30',
      paymentTerms: 'T/T',
      leadTime: '30 days',
      items: [items[0]],
      notes: '',
      status,
    })
  }

  // 邮箱
  const acc = await post('/api/email/accounts', {
    email: 'sales@lulux-demo.example.com',
    displayName: 'Koko Chen',
    presetId: null,
    imap: { host: '127.0.0.1', port: Number(imapPort), secure: false },
    smtp: { host: '127.0.0.1', port: Number(smtpPort), secure: false },
    password: 'demo-app-pass',
    signature: 'Koko Chen\nSales Manager · Mingchuan Trading Co., Ltd.\nsales@lulux-demo.example.com',
  })
  await post(`/api/email/accounts/${acc.id}/sync`, { wait: true })
  const { items: mails } = await call('GET', '/api/email/messages?folder=inbox&pageSize=50')
  const rfq = mails.find((m) => m.subject.startsWith('RFQ'))
  const liam = mails.find((m) => m.subject.includes('Sample shipment'))
  if (rfq && !rfq.customerId) await post(`/api/email/messages/${rfq.id}/link`, { customerId: nord })
  if (liam && !liam.customerId)
    await post(`/api/email/messages/${liam.id}/link`, { customerId: ids['Harbourline Imports Ltd'] }).catch(
      () => undefined,
    )
  const cat = mails.find((m) => m.subject.startsWith('Catalogue'))
  if (cat && cat.verdict === 'review')
    await post(`/api/email/messages/${cat.id}/classify`, { useModel: true }).catch(() => undefined)
  if (rfq)
    await post('/api/email/drafts/generate', {
      messageId: rfq.id,
      quoteId: q.id,
      instructions: '报 FOB 宁波价，强调 25 天交期',
    }).catch((e) => console.warn(String(e)))

  // 会话：单 Agent + 群聊（演示模型带推理过程、工具调用与用量；单价为演示值）
  await patch('/api/settings', {
    modelPricing: JSON.stringify({ 'lulux-demo-model': { input: 2, output: 8, cacheRead: 0.5, currency: 'CNY' } }),
  }).catch((e) => console.warn(String(e)))
  const s1 = await post('/api/sessions', { title: 'Nordlicht 球阀报价', agentIds: ['builtin'] })
  await call('PUT', `/api/chat/sessions/${s1.session?.id ?? s1.id}/context`, { customerId: nord, quoteId: q.id }).catch(
    (e) => console.warn(String(e)),
  )
  await chat(s1.session?.id ?? s1.id, '按 Nordlicht 的询价帮我做一版报价，FOB 宁波')
  // 群聊：LULUX + Claude Code 内核（演示环境未安装 Claude Code 时 @ 内置内核，只有它发言）
  // 群聊总是新建（kind: group），不由单聊转换
  const s2 = await post('/api/sessions', {
    kind: 'group',
    title: 'Nordlicht 投标小组',
    groupName: 'Nordlicht 投标小组',
    agentIds: ['builtin', 'kernel-claude-code'],
  })
  await chat(
    s2.session?.id ?? s2.id,
    '@LULUX 德国客户 Nordlicht 询价 DN25/DN32 球阀共 2,800 只，给个整体意见：怎么报价、竞品行情、下一步安排、回信怎么写。',
  )
  await post('/api/sessions', { title: '哥斯达黎加 PEX 市场调研', agentIds: ['builtin'] })
  console.log('desktop seeded')
}

async function chat(sessionId, content) {
  const res = await fetch(apiBase + '/api/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, content }),
  })
  await res.text()
}

async function seedTeam() {
  const setupToken = readFileSync(join(dataDir, 'setup-token'), 'utf8').trim()
  const owner = await post('/api/auth/setup', {
    setupToken,
    email: 'koko@mingchuan.example.com',
    password: 'Owner-pass-2026',
    name: 'Koko Chen',
    orgName: '明川外贸',
  })
  token = owner.token
  const team = await post('/api/team/teams', { name: '欧洲业务组' })
  const people = [
    ['admin', 'Wang Lei', 'wang.lei@mingchuan.example.com'],
    ['member', 'Lin Yu', 'lin.yu@mingchuan.example.com'],
    ['member', 'Zhao Min', 'zhao.min@mingchuan.example.com'],
    ['viewer', 'Chen Jia（财务）', 'chen.jia@mingchuan.example.com'],
  ]
  const ownerToken = token
  const ids = []
  for (const [role, name, email] of people) {
    token = ownerToken
    const inv = await post('/api/team/invites', { role, email, teamId: role === 'member' ? team.id : undefined })
    const res = await post('/api/auth/invites/accept', { code: inv.code, email, password: 'Member-pass-2026', name })
    ids.push(res.user.id)
    if (role === 'member') {
      token = res.token
      await post('/api/customers', {
        company: name === 'Lin Yu' ? 'Fjord Marine AS' : 'Sahara Trading FZE',
        country: name === 'Lin Yu' ? 'Norway' : 'UAE',
        stage: 'contacted',
        tags: [],
        contacts: [],
      })
    }
  }
  token = ownerToken
  await patch(`/api/team/teams/${team.id}`, { memberIds: [ids[1], ids[2]] })
  await post('/api/team/invites', { role: 'member', email: 'new.hire@mingchuan.example.com', expiresInHours: 168 })
  await post('/api/team/invites', { role: 'viewer', maxUses: 5 })
  await post('/api/customers', {
    company: 'Nordlicht Armaturen GmbH',
    country: 'Germany',
    stage: 'negotiating',
    tags: ['阀门'],
    contacts: [],
    visibility: 'org',
  })
  await call('PATCH', `/api/team/members/${ids[2]}`, { disabled: true }).catch(() => undefined)
  console.log('team seeded')
}

await (mode === 'team' ? seedTeam() : seedDesktop())
