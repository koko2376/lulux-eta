#!/usr/bin/env node
/**
 * 开发期本地 mock：按 docs/API-CONTRACT.md 在内存里实现全部 /api 接口。
 * 用法：LULUX_DATA_DIR=/tmp/lulux-mock node mock/server.mjs [port]
 *   - 启动时生成 token 写入 <dataDir>/api-token，所有 /api 请求校验 Bearer（同真服务）
 *   - vite dev 设 LULUX_API_TARGET=http://127.0.0.1:<port> 与相同的 LULUX_DATA_DIR 即可接上
 * 仅用于开发与截图，不参与打包。
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const port = Number(process.argv[2] || process.env.PORT || 51789)
const dataDir = process.env.LULUX_DATA_DIR || process.env.LULUX_ETA_HOME || join(homedir(), '.lulux-eta-mock')
const seed = process.env.MOCK_EMPTY !== '1'
mkdirSync(dataDir, { recursive: true })
const token = process.env.LULUX_API_TOKEN || randomBytes(32).toString('hex')
writeFileSync(join(dataDir, 'api-token'), token, { mode: 0o600 })

const now = () => Date.now()
const id = (p) => `${p}_${randomUUID().slice(0, 8)}`

/* ───────────── 数据 ───────────── */
const db = {
  settings: {
    defaultProviderId: '',
    toolApproval: 'ask',
    theme: 'light',
    density: 'standard',
    fontScale: '100',
    proxyUrl: '',
    webhookUrl: '',
    webhookEnabled: '0',
    allowMcpWithoutNativeConfirm: '0',
    language: 'zh-CN',
  },
  providers: [],
  sessions: [],
  messages: [],
  mcp: [],
  customers: [],
  activities: [],
  products: [],
  quotes: [],
  rules: [],
  templates: [],
  lock: { enabled: false, pin: '' },
  kernels: [
    {
      id: 'builtin',
      name: 'LULUX',
      vendor: 'LULUX',
      npmPackage: '',
      description: '直接使用你配置的模型 Provider',
      sizeHint: '',
      installed: true,
      version: '0.1.1',
      latestVersion: '0.1.1',
      status: 'idle',
      progress: null,
      error: null,
      requiresLogin: false,
      loginHint: '',
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      vendor: 'Anthropic',
      npmPackage: '@anthropic-ai/claude-code',
      description: '命令行编码 Agent',
      sizeHint: '约 40 MB',
      installed: false,
      version: null,
      latestVersion: '2.0.14',
      status: 'idle',
      progress: null,
      error: null,
      requiresLogin: true,
      loginHint: '安装后在终端运行 claude 并完成登录',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      vendor: 'OpenAI',
      npmPackage: '@openai/codex',
      description: '命令行编码 Agent',
      sizeHint: '约 28 MB',
      installed: false,
      version: null,
      latestVersion: '0.46.0',
      status: 'idle',
      progress: null,
      error: null,
      requiresLogin: true,
      loginHint: '安装后运行 codex login',
    },
  ],
  kernelLogs: {},
}

/** 内置内核：只有一个，显示名 LULUX（id 仍为 builtin） */
const personas = [
  {
    id: 'builtin',
    name: 'LULUX',
    description: '直接使用你配置的模型 Provider',
    avatar: '/icon.png',
    accent: '#2f6b5e',
    kind: 'builtin',
    kernelId: null,
  },
]

function agents() {
  const list = personas.map((p) => ({
    ...p,
    available: db.providers.length > 0,
    unavailableReason: db.providers.length ? null : '未配置模型 Provider',
  }))
  for (const k of db.kernels) {
    if (k.id === 'builtin') continue
    list.push({
      id: `kernel-${k.id}`,
      name: k.name,
      description: `${k.vendor} · 第三方内核`,
      avatar: '/icon.png',
      accent: '#777',
      kind: 'kernel',
      kernelId: k.id,
      available: k.installed && !k.requiresLogin,
      unavailableReason: !k.installed ? '未安装' : k.requiresLogin ? '需要登录' : null,
    })
  }
  return list
}

function preview(key) {
  if (!key) return null
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}
const publicProvider = (p) => {
  const { apiKey, ...rest } = p
  return { ...rest, hasApiKey: Boolean(apiKey), apiKeyPreview: preview(apiKey) }
}

if (seed) {
  const c1 = {
    id: id('cus'),
    company: 'Nordic Build AB',
    country: '瑞典',
    website: 'nordic.example.com',
    stage: 'quoted',
    tags: ['户外家具'],
    source: '展会',
    notes: '',
    contacts: [
      {
        id: id('ct'),
        name: 'Erik Lindqvist',
        title: '采购经理',
        email: 'erik@nordic.example.com',
        phone: '+46 8 123 456',
        whatsapp: '',
        isPrimary: true,
      },
    ],
    createdAt: now() - 86400000 * 5,
    updatedAt: now() - 3600000,
  }
  const c2 = {
    id: id('cus'),
    company: 'Alpine Living GmbH',
    country: '德国',
    website: 'alpine.example.com',
    stage: 'contacted',
    tags: ['家纺'],
    source: '官网询盘',
    notes: '',
    contacts: [
      {
        id: id('ct'),
        name: 'Anna Weber',
        title: 'Buyer',
        email: 'anna@alpine.example.com',
        phone: '',
        whatsapp: '',
        isPrimary: true,
      },
    ],
    createdAt: now() - 86400000 * 3,
    updatedAt: now() - 7200000,
  }
  db.customers.push(c1, c2)
  db.activities.push({
    id: id('act'),
    customerId: c1.id,
    type: 'note',
    content: '展会上交换名片，对藤编椅感兴趣',
    createdAt: now() - 86400000 * 4,
  })
  db.products.push({
    id: id('prd'),
    sku: 'RC-001',
    name: '户外藤编椅',
    spec: '铝框 + PE 藤',
    unit: 'pcs',
    price: 42,
    currency: 'USD',
    moq: 100,
    hsCode: '9401790000',
  })
  db.rules.push({
    id: id('rul'),
    name: '常见询盘关键词',
    enabled: true,
    conditions: [{ field: 'subject', op: 'contains', value: 'quotation' }],
    action: 'inquiry',
    priority: 10,
  })
  db.templates.push({
    id: id('tpl'),
    name: '默认模板',
    isDefault: true,
    company: {
      name: 'Example Trading Co., Ltd.',
      address: 'Wenzhou, Zhejiang, China',
      phone: '+86 577 0000 0000',
      email: 'sales@example.com',
      logoDataUrl: '',
    },
    defaultIncoterm: 'FOB',
    defaultCurrency: 'USD',
    defaultPaymentTerms: '30% T/T 预付，70% 见提单副本',
    footer: '报价有效期 30 天',
  })
}

/* ───────────── 工具 ───────────── */
function send(res, status, body) {
  if (status === 204) {
    res.writeHead(204)
    return res.end()
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
const fail = (res, status, code, message) => send(res, status, { error: { code, message } })
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}
const subtotal = (items) =>
  Math.round(items.reduce((s, i) => s + Number(i.qty || 0) * Number(i.unitPrice || 0), 0) * 100) / 100
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

function crud(list, prefix, normalize = (x) => x) {
  return {
    list: () => list(),
    create: (body) => {
      const item = normalize({ ...body, id: id(prefix) })
      list().push(item)
      return item
    },
    get: (iid) => list().find((x) => x.id === iid),
    patch: (iid, body) => {
      const item = list().find((x) => x.id === iid)
      if (!item) return null
      Object.assign(item, body, { id: iid })
      normalize(item)
      return item
    },
    remove: (iid) => {
      const arr = list()
      const i = arr.findIndex((x) => x.id === iid)
      if (i < 0) return false
      arr.splice(i, 1)
      return true
    },
  }
}

function startKernelJob(k, action) {
  k.status = action === 'uninstall' ? 'uninstalling' : 'installing'
  k.progress = 0
  k.error = null
  const log = (db.kernelLogs[k.id] ||= [])
  log.push(`[${new Date().toISOString()}] ${action} ${k.npmPackage} --registry https://registry.npmmirror.com`)
  const timer = setInterval(() => {
    k.progress = Math.min(100, (k.progress || 0) + 25)
    log.push(`progress ${k.progress}%`)
    if (k.progress >= 100) {
      clearInterval(timer)
      k.status = 'idle'
      k.progress = null
      if (action === 'uninstall') {
        k.installed = false
        k.version = null
      } else {
        k.installed = true
        k.version = k.latestVersion
      }
      log.push(`${action} done`)
    }
  }, 600)
}

/* ───────────── 路由 ───────────── */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method
  if (!path.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND', '仅提供 /api')
  if (process.env.MOCK_NO_AUTH !== '1' && req.headers.authorization !== `Bearer ${token}`)
    return fail(res, 401, 'UNAUTHORIZED', '缺少或错误的访问令牌')
  if (
    ['POST', 'PATCH', 'PUT'].includes(method) &&
    req.headers['content-length'] !== '0' &&
    req.headers['content-type'] &&
    !String(req.headers['content-type']).includes('application/json')
  ) {
    return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '只接受 application/json')
  }
  let body = {}
  try {
    body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readBody(req) : {}
  } catch {
    return fail(res, 400, 'BAD_JSON', '请求体不是合法 JSON')
  }
  const seg = path.split('/').filter(Boolean).slice(1) // 去掉 api
  const [a, b, c] = seg
  const M = (m, p) => method === m && p

  if (M('GET', a === 'health')) return send(res, 200, { ok: true })

  /* settings */
  if (a === 'settings' && !b) {
    if (method === 'GET') return send(res, 200, { settings: db.settings })
    if (method === 'PATCH') {
      for (const k of Object.keys(body))
        if (!(k in db.settings)) return fail(res, 400, 'UNKNOWN_SETTING', `未知设置项：${k}`)
      Object.assign(db.settings, Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])))
      return send(res, 200, { settings: db.settings })
    }
  }
  if (M('GET', a === 'settings' && b === 'schema'))
    return send(
      res,
      200,
      Object.keys(db.settings).map((key) => ({ key, type: 'string', default: '' })),
    )

  /* lock */
  if (a === 'lock') {
    if (!b && method === 'GET') return send(res, 200, { enabled: db.lock.enabled })
    const pin = String(body.pin ?? '')
    if (b === 'setup') {
      if (!/^\d{4,12}$/.test(pin)) return fail(res, 400, 'INVALID_PIN', 'PIN 需为 4–12 位数字')
      db.lock = { enabled: true, pin }
      return send(res, 200, { enabled: true })
    }
    if (b === 'verify') return send(res, 200, { ok: db.lock.enabled && pin === db.lock.pin })
    if (b === 'disable') {
      if (pin !== db.lock.pin) return fail(res, 403, 'WRONG_PIN', 'PIN 不正确')
      db.lock = { enabled: false, pin: '' }
      return send(res, 200, { enabled: false })
    }
  }

  /* agents / providers */
  if (M('GET', a === 'agents')) return send(res, 200, { agents: agents() })
  if (a === 'providers') {
    if (!b && method === 'GET') return send(res, 200, { providers: db.providers.map(publicProvider) })
    if (!b && method === 'POST') {
      if (!body.name?.trim() || !body.baseUrl?.trim()) return fail(res, 400, 'VALIDATION', '名称和 Base URL 必填')
      const p = {
        id: id('prv'),
        name: body.name,
        kind: body.kind || 'openai',
        baseUrl: body.baseUrl,
        apiKey: body.apiKey || '',
        model: body.model || '',
        models: body.models || (body.model ? [body.model] : []),
        createdAt: now(),
      }
      db.providers.push(p)
      return send(res, 201, { provider: publicProvider(p) })
    }
    const p = db.providers.find((x) => x.id === b)
    if (!p) return fail(res, 404, 'NOT_FOUND', 'Provider 不存在')
    if (method === 'PATCH') {
      Object.assign(p, body)
      return send(res, 200, { provider: publicProvider(p) })
    }
    if (method === 'DELETE') {
      db.providers.splice(db.providers.indexOf(p), 1)
      if (db.settings.defaultProviderId === p.id) db.settings.defaultProviderId = ''
      return send(res, 204)
    }
    if (c === 'discover-models' && method === 'POST') {
      if (p.baseUrl.includes('invalid')) return fail(res, 502, 'UPSTREAM_ERROR', '连接失败：getaddrinfo ENOTFOUND')
      p.models = Array.from(new Set([...(p.models || []), 'mock-chat', 'mock-reasoner']))
      if (!p.model) p.model = p.models[0]
      return send(res, 200, { provider: publicProvider(p), models: p.models })
    }
  }

  /* sessions */
  if (a === 'sessions') {
    const summary = (s) => {
      const ms = db.messages.filter((m) => m.sessionId === s.id)
      return { ...s, messageCount: ms.length, preview: ms.at(-1)?.content.slice(0, 60) || '' }
    }
    if (!b && method === 'GET')
      return send(res, 200, { sessions: [...db.sessions].sort((x, y) => y.updatedAt - x.updatedAt).map(summary) })
    if (!b && method === 'POST') {
      const s = {
        id: id('ses'),
        title: body.title || '新会话',
        groupName: null,
        providerId: body.providerId || null,
        agentIds: body.agentIds?.length ? body.agentIds : ['builtin'],
        createdAt: now(),
        updatedAt: now(),
      }
      db.sessions.push(s)
      return send(res, 201, { session: summary(s) })
    }
    const s = db.sessions.find((x) => x.id === b)
    if (!s) return fail(res, 404, 'NOT_FOUND', '会话不存在')
    if (method === 'GET')
      return send(res, 200, { session: summary(s), messages: db.messages.filter((m) => m.sessionId === s.id) })
    if (method === 'PATCH') {
      Object.assign(s, body, { updatedAt: now() })
      return send(res, 200, { session: summary(s) })
    }
    if (method === 'DELETE') {
      db.sessions.splice(db.sessions.indexOf(s), 1)
      db.messages = db.messages.filter((m) => m.sessionId !== s.id)
      return send(res, 204)
    }
  }

  /* chat */
  if (M('POST', a === 'chat' && b === 'tool-decision')) return send(res, 200, { ok: true })
  if (M('POST', a === 'chat' && !b)) {
    const s = db.sessions.find((x) => x.id === body.sessionId)
    if (!s) return fail(res, 404, 'NOT_FOUND', '会话不存在')
    const agent = agents().find((x) => x.id === s.agentIds[0])
    if (agent && agent.available === false)
      return fail(res, 409, 'KERNEL_UNAVAILABLE', `${agent.name} 不可用：${agent.unavailableReason}`)
    const provider = db.providers.find((x) => x.id === db.settings.defaultProviderId) || db.providers[0]
    if (!provider) return fail(res, 400, 'NO_PROVIDER', '还没有配置模型 Provider')
    db.messages.push({
      id: id('msg'),
      sessionId: s.id,
      role: 'user',
      content: String(body.content),
      senderAgentId: null,
      toolTrace: [],
      createdAt: now(),
    })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    const runtime = { kind: 'provider', providerName: provider.name, model: provider.model || 'mock-chat' }
    ev('start', {
      sessionId: s.id,
      group: s.agentIds.length > 1,
      provider: { id: provider.id, name: provider.name, model: runtime.model },
      members: [],
    })
    ev('agent', { agentId: s.agentIds[0], name: agent?.name || 'Agent', avatar: '', index: 0, total: 1, runtime })
    const reply = `收到：「${String(body.content).slice(0, 40)}」。这是本地 mock 的流式回复。`
    let i = 0
    const timer = setInterval(() => {
      if (i < reply.length) {
        ev('delta', { text: reply.slice(i, i + 6) })
        i += 6
        return
      }
      clearInterval(timer)
      const msg = {
        id: id('msg'),
        sessionId: s.id,
        role: 'assistant',
        content: reply,
        senderAgentId: s.agentIds[0],
        toolTrace: [],
        createdAt: now(),
        runtime,
      }
      db.messages.push(msg)
      s.updatedAt = now()
      if (s.title === '新会话') s.title = String(body.content).slice(0, 18)
      ev('done', { message: msg })
      res.end()
    }, 40)
    req.on('close', () => clearInterval(timer))
    return
  }

  /* mcp */
  if (a === 'mcp' && b === 'servers') {
    const sid = c
    const confirmOk = db.settings.allowMcpWithoutNativeConfirm === '1'
    if (!sid && method === 'GET') return send(res, 200, { servers: db.mcp })
    if (!sid && method === 'POST') {
      if (!confirmOk)
        return fail(
          res,
          403,
          'MCP_COMMAND_REJECTED',
          '浏览器开发态没有系统确认框，已拒绝新增 MCP 命令（可在设置中开启 allowMcpWithoutNativeConfirm）',
        )
      const m = {
        id: id('mcp'),
        ...body,
        approved: true,
        createdAt: now(),
        state: { status: 'connected', error: '', tools: ['echo'] },
      }
      db.mcp.push(m)
      return send(res, 201, { server: m })
    }
    const m = db.mcp.find((x) => x.id === sid)
    if (!m) return fail(res, 404, 'NOT_FOUND', 'MCP 服务不存在')
    if (seg[3] === 'refresh') return send(res, 200, { state: m.state })
    if (method === 'PATCH') {
      if ((body.command || body.args || body.env) && !confirmOk)
        return fail(res, 403, 'MCP_COMMAND_REJECTED', '修改命令需要系统确认')
      Object.assign(m, body)
      return send(res, 200, { server: m })
    }
    if (method === 'DELETE') {
      db.mcp.splice(db.mcp.indexOf(m), 1)
      return send(res, 204)
    }
  }

  if (M('POST', a === 'proxy' && b === 'test'))
    return body.proxyUrl || db.settings.proxyUrl
      ? send(res, 200, { ok: true, status: 200 })
      : fail(res, 400, 'VALIDATION', '请先填写代理地址')
  if (M('POST', a === 'webhook' && b === 'test'))
    return body.url || db.settings.webhookUrl
      ? send(res, 200, { ok: true, status: 200 })
      : fail(res, 400, 'VALIDATION', '请先填写 Webhook 地址')

  /* kernels */
  if (a === 'kernels') {
    if (!b) return send(res, 200, db.kernels)
    const k = db.kernels.find((x) => x.id === b)
    if (!k) return fail(res, 404, 'NOT_FOUND', '内核不存在')
    if (c === 'log') return send(res, 200, { lines: (db.kernelLogs[k.id] || []).slice(-500) })
    if (['install', 'update', 'uninstall'].includes(c) && method === 'POST') {
      if (k.id === 'builtin') return fail(res, 400, 'BUILTIN', '内置内核不能卸载或更新')
      if (k.status !== 'idle' && k.status !== 'error') return fail(res, 409, 'BUSY', '该内核正在处理中')
      startKernelJob(k, c)
      return send(res, 202, k)
    }
  }

  /* customers */
  if (a === 'customers') {
    if (b === 'import' && method === 'POST') {
      const { rows = [], mapping = {}, dedupeBy = 'email', onDuplicate = 'skip' } = body
      const result = { created: 0, merged: 0, skipped: 0, errors: [] }
      rows.forEach((row, i) => {
        const get = (f) => (mapping[f] ? String(row[mapping[f]] ?? '').trim() : '')
        const company = get('company')
        if (!company) {
          result.errors.push({ row: i + 1, message: '缺少公司名称' })
          return
        }
        const key =
          dedupeBy === 'email'
            ? get('contactEmail').toLowerCase()
            : dedupeBy === 'website'
              ? get('website').toLowerCase()
              : company.toLowerCase()
        const dup =
          key &&
          db.customers.find((cu) =>
            dedupeBy === 'email'
              ? cu.contacts.some((ct) => ct.email.toLowerCase() === key)
              : (cu[dedupeBy] || '').toLowerCase() === key,
          )
        if (dup) {
          if (onDuplicate === 'skip') result.skipped++
          else {
            dup.notes = [dup.notes, get('notes')].filter(Boolean).join('\n')
            result.merged++
          }
          return
        }
        db.customers.push({
          id: id('cus'),
          company,
          country: get('country'),
          website: get('website'),
          stage: 'lead',
          tags: get('tags')
            ? get('tags')
                .split(/[,，;]/)
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
          source: get('source') || '导入',
          notes: get('notes'),
          contacts:
            get('contactName') || get('contactEmail')
              ? [
                  {
                    id: id('ct'),
                    name: get('contactName'),
                    title: get('contactTitle'),
                    email: get('contactEmail'),
                    phone: get('contactPhone'),
                    whatsapp: get('contactWhatsapp'),
                    isPrimary: true,
                  },
                ]
              : [],
          createdAt: now(),
          updatedAt: now(),
        })
        result.created++
      })
      return send(res, 200, result)
    }
    if (!b && method === 'GET') {
      const q = (url.searchParams.get('query') || '').toLowerCase()
      const stage = url.searchParams.get('stage')
      const tag = url.searchParams.get('tag')
      const page = Number(url.searchParams.get('page') || 1)
      const size = Number(url.searchParams.get('pageSize') || 20)
      let items = db.customers.filter(
        (cu) =>
          (!q || JSON.stringify(cu).toLowerCase().includes(q)) &&
          (!stage || cu.stage === stage) &&
          (!tag || cu.tags.includes(tag)),
      )
      items = items.sort((x, y) => y.updatedAt - x.updatedAt)
      return send(res, 200, { items: items.slice((page - 1) * size, page * size), total: items.length })
    }
    if (!b && method === 'POST') {
      if (!body.company?.trim()) return fail(res, 400, 'VALIDATION', '公司名称必填')
      const cu = {
        stage: 'lead',
        tags: [],
        country: '',
        website: '',
        source: '',
        notes: '',
        ...body,
        contacts: (body.contacts || []).map((ct) => ({ ...ct, id: ct.id || id('ct') })),
        id: id('cus'),
        createdAt: now(),
        updatedAt: now(),
      }
      db.customers.push(cu)
      return send(res, 201, cu)
    }
    const cu = db.customers.find((x) => x.id === b)
    if (!cu) return fail(res, 404, 'NOT_FOUND', '客户不存在')
    if (c === 'activities') {
      if (method === 'GET')
        return send(
          res,
          200,
          db.activities.filter((x) => x.customerId === cu.id).sort((x, y) => y.createdAt - x.createdAt),
        )
      const act = {
        id: id('act'),
        customerId: cu.id,
        type: body.type || 'note',
        content: String(body.content || ''),
        createdAt: now(),
      }
      db.activities.push(act)
      return send(res, 201, act)
    }
    if (method === 'GET') return send(res, 200, cu)
    if (method === 'PATCH') {
      Object.assign(cu, body, { id: cu.id, updatedAt: now() })
      if (body.contacts) cu.contacts = body.contacts.map((ct) => ({ ...ct, id: ct.id || id('ct') }))
      return send(res, 200, cu)
    }
    if (method === 'DELETE') {
      db.customers.splice(db.customers.indexOf(cu), 1)
      return send(res, 204)
    }
  }

  /* products */
  if (a === 'products') {
    const r = crud(() => db.products, 'prd')
    if (!b && method === 'GET') return send(res, 200, r.list())
    if (!b && method === 'POST') return send(res, 201, r.create(body))
    if (method === 'PATCH') {
      const x = r.patch(b, body)
      return x ? send(res, 200, x) : fail(res, 404, 'NOT_FOUND', '产品不存在')
    }
    if (method === 'DELETE') return r.remove(b) ? send(res, 204) : fail(res, 404, 'NOT_FOUND', '产品不存在')
  }

  /* quotes */
  if (a === 'quotes') {
    const norm = (q) => {
      q.subtotal = subtotal(q.items || [])
      q.updatedAt = now()
      return q
    }
    if (!b && method === 'GET') {
      const cid = url.searchParams.get('customerId')
      return send(res, 200, cid ? db.quotes.filter((q) => q.customerId === cid) : db.quotes)
    }
    if (!b && method === 'POST') {
      if (!body.customerId) return fail(res, 400, 'VALIDATION', '请选择客户')
      const q = norm({
        status: 'draft',
        items: [],
        notes: '',
        ...body,
        id: id('quo'),
        number: body.number || `QT-${new Date().getFullYear()}-${String(db.quotes.length + 1).padStart(4, '0')}`,
        createdAt: now(),
      })
      db.quotes.push(q)
      return send(res, 201, q)
    }
    const q = db.quotes.find((x) => x.id === b)
    if (!q) return fail(res, 404, 'NOT_FOUND', '报价单不存在')
    if (c === 'html') {
      const cu = db.customers.find((x) => x.id === q.customerId)
      const rows = q.items
        .map(
          (it, i) =>
            `<tr><td>${i + 1}</td><td>${esc(it.name)}<br><small>${esc(it.spec)}</small></td><td>${esc(it.qty)} ${esc(it.unit)}</td><td>${esc(it.unitPrice)}</td><td>${(it.qty * it.unitPrice).toFixed(2)}</td></tr>`,
        )
        .join('')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${esc(q.number)}</title><style>body{font-family:sans-serif;padding:32px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}</style></head><body><h1>QUOTATION ${esc(q.number)}</h1><p>To: ${esc(cu?.company || '')}</p><p>${esc(q.incoterm)} ${esc(q.port)} · ${esc(q.currency)} · Valid until ${esc(q.validUntil)}</p><table><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr>${rows}</table><h3>Total: ${esc(q.currency)} ${q.subtotal.toFixed(2)}</h3><p>${esc(q.paymentTerms)}</p></body></html>`,
      )
    }
    if (method === 'GET') return send(res, 200, q)
    if (method === 'PATCH') {
      Object.assign(q, body, { id: q.id })
      norm(q)
      return send(res, 200, q)
    }
    if (method === 'DELETE') {
      db.quotes.splice(db.quotes.indexOf(q), 1)
      return send(res, 204)
    }
  }

  /* rules / templates */
  if (a === 'inquiry-rules') {
    if (b === 'test' && method === 'POST') {
      const rules = db.rules.filter((r) => r.enabled).sort((x, y) => y.priority - x.priority)
      const domain = String(body.from || '').split('@')[1] || ''
      for (const r of rules) {
        const ok = r.conditions.every((cond) => {
          const v = cond.field === 'domain' ? domain : String(body[cond.field] || '')
          if (cond.op === 'contains') return v.toLowerCase().includes(cond.value.toLowerCase())
          if (cond.op === 'not_contains') return !v.toLowerCase().includes(cond.value.toLowerCase())
          try {
            return new RegExp(cond.value, 'i').test(v)
          } catch {
            return false
          }
        })
        if (ok) return send(res, 200, { verdict: r.action, matchedRuleId: r.id })
      }
      return send(res, 200, { verdict: 'review', matchedRuleId: null })
    }
    const r = crud(() => db.rules, 'rul')
    if (!b && method === 'GET') return send(res, 200, r.list())
    if (!b && method === 'POST') return send(res, 201, r.create(body))
    if (method === 'PATCH') {
      const x = r.patch(b, body)
      return x ? send(res, 200, x) : fail(res, 404, 'NOT_FOUND', '规则不存在')
    }
    if (method === 'DELETE') return r.remove(b) ? send(res, 204) : fail(res, 404, 'NOT_FOUND', '规则不存在')
  }
  if (a === 'quote-templates') {
    const r = crud(
      () => db.templates,
      'tpl',
      (t) => {
        if (t.isDefault)
          db.templates.forEach((o) => {
            if (o.id !== t.id) o.isDefault = false
          })
        return t
      },
    )
    if (!b && method === 'GET') return send(res, 200, r.list())
    if (!b && method === 'POST') return send(res, 201, r.create(body))
    if (method === 'PATCH') {
      const x = r.patch(b, body)
      return x ? send(res, 200, x) : fail(res, 404, 'NOT_FOUND', '模板不存在')
    }
    if (method === 'DELETE') return r.remove(b) ? send(res, 204) : fail(res, 404, 'NOT_FOUND', '模板不存在')
  }

  /* workbench */
  if (M('GET', a === 'workbench' && b === 'summary')) {
    const byStage = {}
    for (const cu of db.customers) byStage[cu.stage] = (byStage[cu.stage] || 0) + 1
    const amountByCurrency = {}
    for (const q of db.quotes) amountByCurrency[q.currency] = (amountByCurrency[q.currency] || 0) + q.subtotal
    return send(res, 200, {
      customers: { total: db.customers.length, byStage },
      quotes: {
        total: db.quotes.length,
        draft: db.quotes.filter((q) => q.status === 'draft').length,
        sent: db.quotes.filter((q) => q.status === 'sent').length,
        accepted: db.quotes.filter((q) => q.status === 'accepted').length,
        amountByCurrency,
      },
      recentActivities: [...db.activities].sort((x, y) => y.createdAt - x.createdAt).slice(0, 8),
      recentSessions: [...db.sessions]
        .sort((x, y) => y.updatedAt - x.updatedAt)
        .slice(0, 5)
        .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })),
    })
  }

  /* data */
  if (a === 'data') {
    if (b === 'summary')
      return send(res, 200, {
        sessions: db.sessions.length,
        messages: db.messages.length,
        providers: db.providers.length,
        mcpServers: db.mcp.length,
        databaseBytes: 123456,
      })
    if (b === 'export')
      return send(res, 200, {
        app: 'LULUX ETA',
        version: '0.1.1',
        exportedAt: new Date().toISOString(),
        settings: db.settings,
        customers: db.customers,
        quotes: db.quotes,
        sessions: db.sessions,
      })
    if (b === 'import' && method === 'POST') {
      const imported = {}
      for (const key of ['customers', 'quotes', 'sessions'])
        if (Array.isArray(body[key])) {
          imported[key] = body[key].length
        }
      if (!Object.keys(imported).length) return fail(res, 400, 'INVALID_BACKUP', '备份文件格式不正确')
      return send(res, 200, { imported })
    }
    if (b === 'sessions' && method === 'DELETE') {
      const n = db.sessions.length
      db.sessions = []
      db.messages = []
      return send(res, 200, { removed: n })
    }
  }

  return fail(res, 404, 'NOT_FOUND', `未实现：${method} ${path}`)
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error)
    if (!res.headersSent) fail(res, 500, 'INTERNAL', String(error))
  })
}).listen(port, '127.0.0.1', () => {
  console.log(`[mock] http://127.0.0.1:${port}  dataDir=${dataDir}`)
})
