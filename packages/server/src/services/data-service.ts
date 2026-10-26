import { statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBackupDir } from '../db/backup-dir.js'
import { z } from 'zod'
import { canonicalAgentId } from '../agents.js'
import { config } from '../config.js'
import { db } from '../db.js'
import { currentActor } from '../context.js'
import { AppError } from '../errors.js'
import { transaction } from '../utils/tx.js'
import { parse } from '../validation.js'
import { customerCreateInput, customerService, ACTIVITY_TYPES } from './customer-service.js'
import { inquiryRuleService, ruleCreateInput } from './inquiry-rule-service.js'
import { productCreateInput, productService } from './product-service.js'
import { prospectCreateInput, prospectService } from './prospect-service.js'
import { providerService } from './provider-service.js'
import { quoteCreateInput, quoteService, subtotalOf, type QuoteItem } from './quote-service.js'
import { quoteTemplateService, templateCreateInput } from './quote-template-service.js'
import { sessionService } from './session-service.js'
import { memberKernelId } from './agent-service.js'
import { settingsService, validateSettingsPatch } from './settings-service.js'
import { taskService, TASK_PRIORITIES, TASK_STATUSES } from './task-service.js'
import { DEAL_STAGES, dealService } from './deal-service.js'
import { memoryService } from './memory/memory-service.js'
import { ORDER_STATUSES, orderService } from './order-service.js'

/**
 * 导出 / 导入都排除的设置：可能带凭据的地址，以及安全相关的开关。
 * 一份别人给的「导出文件」不能借导入静默改掉这些（把对话内容推到外部地址、出站流量走对方代理、
 * 默认完全权限、打开电脑操作、免确认添加 MCP 命令、从对方的源安装内核等）；要改请在设置页里改。
 */
const SECURITY_SENSITIVE_SETTINGS = new Set([
  'proxyUrl',
  'webhookUrl',
  'webhookEnabled',
  'defaultPermissionLevel',
  // 旧键：与 defaultPermissionLevel 双向同步（auto ↔ full），必须一并排除
  'toolApproval',
  'computerUse',
  'allowMcpWithoutNativeConfirm',
  'kernelRegistry',
  'browserDeniedDomains',
])

export function isSecuritySensitiveSetting(key: string): boolean {
  // 内核模式（scoped / global）决定内核是否改用 CLI 自己的登录与配置，同样按安全设置处理
  return SECURITY_SENSITIVE_SETTINGS.has(key) || key.startsWith('kernelMode')
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as { count: number }
  return Number(row.count ?? 0)
}

function databaseBytes(): number {
  const file = join(config.home, 'lulux-eta.db')
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(file + suffix).size
    } catch {
      // 文件不存在时跳过
    }
  }
  return total
}

const idField = z.string().regex(/^[\w-]{1,80}$/, 'id 格式不正确')
const stamp = z.number().int().nonnegative()

const optId = z.string().max(80).nullable().optional()
const dateStr = z.string().max(10).default('')
const taskImport = z.object({
  id: idField,
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(5000).default(''),
  customerId: optId,
  quoteId: optId,
  dueAt: stamp.nullable().optional(),
  status: z.enum(TASK_STATUSES).default('open'),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  source: z.string().max(40).default('user'),
  createdAt: stamp.optional(),
  doneAt: stamp.nullable().optional(),
})
const dealImport = z.object({
  id: idField,
  title: z.string().trim().min(1).max(300),
  customerId: idField,
  quoteId: optId,
  amount: z.number().finite().min(0).max(1e12).default(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  stage: z.enum(DEAL_STAGES).default('prospecting'),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  probabilityOverridden: z.boolean().optional(),
  expectedClose: dateStr,
  wonReason: z.string().max(1000).default(''),
  lostReason: z.string().max(1000).default(''),
  notes: z.string().max(10_000).default(''),
  source: z.string().max(40).default('user'),
  createdAt: stamp.optional(),
  closedAt: stamp.nullable().optional(),
})
const paymentImport = z.object({
  id: idField,
  amount: z.number().finite().positive().max(1e12),
  currency: z.string().regex(/^[A-Z]{3}$/),
  receivedAt: z.string().max(10),
  method: z.string().max(100).default(''),
  reference: z.string().max(200).default(''),
  notes: z.string().max(2000).default(''),
  source: z.string().max(40).default('user'),
  createdAt: stamp.optional(),
})
const orderImport = z.object({
  id: idField,
  number: z.string().trim().min(1).max(64),
  customerId: idField,
  quoteId: optId,
  dealId: optId,
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  amount: z.number().finite().min(0).max(1e12),
  items: z.array(z.unknown()).max(500).default([]),
  incoterm: z.string().max(10).default(''),
  paymentTerms: z.string().max(1000).default(''),
  depositAmount: z.number().finite().min(0).max(1e12).default(0),
  dueDate: dateStr,
  status: z.enum(ORDER_STATUSES).default('pending_production'),
  notes: z.string().max(10_000).default(''),
  shipment: z
    .object({
      containerType: z.string().max(30).default(''),
      containerNo: z.string().max(200).default(''),
      blNo: z.string().max(100).default(''),
      vessel: z.string().max(200).default(''),
      portOfLoading: z.string().max(200).default(''),
      portOfDischarge: z.string().max(200).default(''),
      etd: dateStr,
      eta: dateStr,
    })
    .default({ containerType: '', containerNo: '', blNo: '', vessel: '', portOfLoading: '', portOfDischarge: '', etd: '', eta: '' }),
  payments: z.array(paymentImport).max(1000).default([]),
  createdAt: stamp.optional(),
  shippedAt: stamp.nullable().optional(),
  completedAt: stamp.nullable().optional(),
})

const importSchema = z.object({
  tasks: z.array(z.unknown()).max(100_000).default([]),
  deals: z.array(z.unknown()).max(100_000).default([]),
  orders: z.array(z.unknown()).max(100_000).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  providers: z
    .array(
      z.object({
        id: idField,
        name: z.string().min(1).max(200),
        kind: z.enum(['openai', 'anthropic']),
        baseUrl: z.string().max(2000),
        model: z.string().max(200).default(''),
        models: z.array(z.string().max(200)).max(500).default([]),
        modelCaps: z.record(z.string().max(200), z.unknown()).optional(),
        createdAt: stamp.optional(),
      }),
    )
    .default([]),
  sessions: z
    .array(
      z.object({
        id: idField,
        title: z.string().max(500).default('导入的会话'),
        kind: z.enum(['single', 'group']).optional(),
        groupName: z.string().max(200).nullable().default(null),
        providerId: z.string().max(80).nullable().default(null),
        agentIds: z.array(z.string().max(84)).max(20).default([]),
        /** 群成员资料（群头衔 / 职责 / 模型），按成员 id */
        memberProfiles: z
          .record(
            z.string().max(84),
            z.object({
              role: z.string().max(40).default(''),
              instructions: z.string().max(4000).default(''),
              model: z.string().max(200).nullable().default(null),
            }),
          )
          .optional(),
        supervisorId: z.string().max(84).optional(),
        createdAt: stamp.optional(),
        updatedAt: stamp.optional(),
        messages: z
          .array(
            z.object({
              id: idField,
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string().max(2_000_000),
              senderAgentId: z.string().max(80).nullable().default(null),
              toolTrace: z.array(z.unknown()).max(200).default([]),
              runtime: z.unknown().optional(),
              createdAt: stamp.optional(),
            }),
          )
          .max(100_000)
          .default([]),
      }),
    )
    .default([]),
  customers: z.array(z.object({ id: idField, createdAt: stamp.optional(), updatedAt: stamp.optional() }).passthrough()).default([]),
  prospects: z.array(z.object({ id: idField, createdAt: stamp.optional(), updatedAt: stamp.optional() }).passthrough()).default([]),
  activities: z
    .array(
      z.object({
        id: idField,
        customerId: idField,
        type: z.enum(ACTIVITY_TYPES),
        content: z.string().max(20_000),
        createdAt: stamp.optional(),
      }),
    )
    .default([]),
  products: z.array(z.object({ id: idField }).passthrough()).default([]),
  quotes: z.array(z.object({ id: idField }).passthrough()).default([]),
  inquiryRules: z.array(z.object({ id: idField }).passthrough()).default([]),
  quoteTemplates: z.array(z.object({ id: idField }).passthrough()).default([]),
  memory: z.unknown().optional(),
})


export const dataService = {
  summary() {
    return {
      sessions: countRows('sessions'),
      messages: countRows('messages'),
      providers: countRows('providers'),
      mcpServers: countRows('mcp_servers'),
      customers: countRows('customers'),
      prospects: countRows('prospects'),
      products: countRows('products'),
      quotes: countRows('quotes'),
      databaseBytes: databaseBytes(),
    }
  },

  export() {
    const customers = customerService.list({ page: 1, pageSize: 200 }).total > 0 ? allCustomers() : []
    const settings = { ...settingsService.all() }
    for (const key of Object.keys(settings)) if (isSecuritySensitiveSetting(key)) delete settings[key]
    return {
      app: 'LULUX ETA',
      version: config.version,
      exportedAt: new Date().toISOString(),
      settings,
      // 不含 API Key 及其预览
      providers: providerService.list().map((provider) => ({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        models: provider.models,
        modelCaps: provider.modelCaps,
        createdAt: provider.createdAt,
      })),
      // 只导出自己的会话（含自己建的群聊）；别人建的群、别人的会话不导出（契约 §5.6a）
      sessions: sessionService
        .list()
        .filter((session) => session.ownerId === currentActor().id)
        .map((session) => ({
        ...session,
        messages: sessionService.messages(session.id),
      })),
      customers,
      prospects: prospectService.list({ limit: 200 }).total > 0 ? allProspects() : [],
      // 只导出自己可见的客户的跟进记录（不按组织整表取：别人的私有客户既不可见、也不该导出）
      activities: customers.flatMap((customer) => customerService.activities(customer.id)),
      products: productService.list(),
      quotes: quoteService.list(),
      inquiryRules: inquiryRuleService.list(),
      quoteTemplates: quoteTemplateService.list(),
      // CRM 扩展（契约 §10）：任务、商机、订单（含收款）。导入时按 id 覆盖
      tasks: taskService.list({ status: 'all', limit: 500 }).total > 0 ? allTasks() : [],
      deals: allDeals(),
      orders: allOrders(),
      // 长期记忆（契约 §6.11）：只导出自己的
      memory: memoryService.exportOwn(),
    }
  },

  /** 导入前先用 VACUUM INTO 在备份目录（默认 <dataDir>/backups/）留快照 */
  snapshot(): string {
    const dir = ensureBackupDir(config.home)
    const file = join(dir, `before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
    db.prepare('VACUUM INTO ?').run(file)
    return file
  },

  import(input: unknown): { imported: Record<string, number>; backup: string; appliedSettings: string[]; skippedSettings: string[] } {
    const data = parse(importSchema, input)
    const backup = dataService.snapshot()
    const imported: Record<string, number> = {
      settings: 0,
      providers: 0,
      sessions: 0,
      messages: 0,
      customers: 0,
      prospects: 0,
      activities: 0,
      products: 0,
      quotes: 0,
      inquiryRules: 0,
      quoteTemplates: 0,
      tasks: 0,
      deals: 0,
      orders: 0,
      payments: 0,
      memory: 0,
    }
    const now = Date.now()
    const actor = currentActor()
    const appliedSettings: string[] = []
    const skippedSettings: string[] = []
    const OWNED_TABLES = ['customers', 'sessions', 'quotes', 'tasks', 'deals', 'orders', 'prospects']

    transaction(() => {
      // server 模式：导入前就已是本机标记（org_id='local'）的遗留行不属于这次导入，导入结束后不能顺手划给导入者
      const legacy = new Map<string, Set<string>>()
      if (actor.orgId !== 'local') {
        for (const table of OWNED_TABLES) {
          const rows = db.prepare(`SELECT id FROM ${table} WHERE org_id = 'local'`).all() as unknown as Array<{ id: string }>
          legacy.set(table, new Set(rows.map((row) => row.id)))
        }
      }

      // 设置：逐项校验，不合法的跳过；安全相关设置一律不导入（与导出排除的是同一份名单）
      for (const [key, value] of Object.entries(data.settings)) {
        if (isSecuritySensitiveSetting(key)) {
          skippedSettings.push(key)
          continue
        }
        try {
          settingsService.update(validateSettingsPatch({ [key]: value }))
          imported.settings! += 1
          appliedSettings.push(key)
        } catch {
          // 跳过未知或不合法的设置
        }
      }

      // Provider：只补不存在的（备份里没有 Key，不覆盖本机已有配置）
      const insertProvider = db.prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_key, model, models, model_caps, created_at)
         VALUES (?, ?, ?, ?, '', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      for (const provider of data.providers) {
        let url: URL | null = null
        try {
          url = new URL(provider.baseUrl)
        } catch {
          url = null
        }
        if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) continue
        const result = insertProvider.run(
          provider.id,
          provider.name,
          provider.kind,
          provider.baseUrl,
          provider.model,
          JSON.stringify(provider.models),
          JSON.stringify(provider.modelCaps ?? {}),
          provider.createdAt ?? now,
        )
        imported.providers! += Number(result.changes)
      }

      const upsertSession = db.prepare(
        `INSERT INTO sessions (id, title, provider_id, group_name, created_at, updated_at, avatar_look) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, provider_id = excluded.provider_id,
           group_name = excluded.group_name, updated_at = excluded.updated_at`,
      )
      const upsertMessage = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, sender_agent_id, tool_trace, runtime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, tool_trace = excluded.tool_trace, runtime = excluded.runtime`,
      )
      const importer = currentActor()
      const foreignSession = db.prepare('SELECT org_id, owner_id FROM sessions WHERE id = ?')
      let look = 0
      for (const session of data.sessions) {
        // 导入的会话轮换形象
        look = (look % 6) + 1
        const avatarLook = look
        // 同 id 的会话属于别人：跳过，不覆盖别人的会话（账号隔离）
        const existing = foreignSession.get(session.id) as unknown as { org_id: string; owner_id: string } | undefined
        if (existing && !(existing.org_id === importer.orgId && existing.owner_id === importer.id) && existing.org_id !== 'local') continue
        upsertSession.run(
          session.id,
          session.title,
          session.providerId,
          session.groupName,
          session.createdAt ?? now,
          session.updatedAt ?? now,
          avatarLook,
        )
        // 旧备份没有 kind：成员多于一个视为群聊（与迁移 17 的回填一致）
        const kind = session.kind ?? (new Set(session.agentIds).size > 1 ? 'group' : 'single')
        sessionService.setKind(session.id, kind)
        let restored =
          kind === 'single'
            ? sessionService.setAgents(session.id, session.agentIds.map((id) => memberKernelId(id)).slice(0, 1))
            : sessionService.setAgents(session.id, session.agentIds.map(canonicalAgentId))
        // 群成员资料：按已恢复的成员 id 写回
        if (kind === 'group' && restored && session.memberProfiles && Object.keys(session.memberProfiles).length > 0) {
          // 旧 id（persona 别名等）与成员 id 同样规范化后再对齐
          const profiles = Object.fromEntries(
            Object.entries(session.memberProfiles).map(([id, profile]) => [canonicalAgentId(id), profile]),
          )
          restored =
            sessionService.setMembers(
              session.id,
              restored.agentIds.map((id) => ({ agentId: id, ...(profiles[id] ?? {}) })),
            ) ?? restored
        }
        if (session.supervisorId !== undefined && restored) {
          const sup = session.supervisorId === 'none' ? 'none' : canonicalAgentId(session.supervisorId)
          sessionService.setSupervisor(session.id, sup === 'none' || sup === 'builtin' || restored.agentIds.includes(sup) ? sup : null)
        }
        for (const message of session.messages) {
          const owner = db.prepare('SELECT session_id FROM messages WHERE id = ?').get(message.id) as unknown as
            | { session_id: string }
            | undefined
          if (owner && owner.session_id !== session.id) continue
          upsertMessage.run(
            message.id,
            session.id,
            message.role,
            message.content,
            message.role === 'assistant' && message.senderAgentId ? canonicalAgentId(message.senderAgentId) : null,
            message.toolTrace.length > 0 ? JSON.stringify(message.toolTrace) : null,
            message.runtime ? JSON.stringify(message.runtime) : null,
            message.createdAt ?? now,
          )
          imported.messages! += 1
        }
        imported.sessions! += 1
      }

      for (const raw of data.customers) {
        const parsed = customerCreateInput.safeParse(raw)
        if (!parsed.success) continue
        // 回收站里的同 id 客户：导入即恢复后按导入内容覆盖
        db.prepare('UPDATE customers SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND org_id = ? AND deleted_at IS NOT NULL').run(
          raw.id,
          currentActor().orgId,
        )
        if (customerService.get(raw.id)) {
          customerService.update(raw.id, parsed.data)
        } else {
          customerService.insert(parsed.data, raw.id, raw.createdAt ?? now)
        }
        imported.customers! += 1
      }

      for (const raw of data.prospects) {
        const parsed = prospectCreateInput.safeParse(raw)
        if (!parsed.success) continue
        // 回收站里的同 id 潜客：导入即恢复后按导入内容覆盖（与客户一致）
        db.prepare('UPDATE prospects SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND org_id = ? AND deleted_at IS NOT NULL').run(
          raw.id,
          currentActor().orgId,
        )
        if (prospectService.get(raw.id)) {
          prospectService.update(raw.id, parsed.data)
        } else {
          prospectService.insert(parsed.data, raw.id, raw.createdAt ?? now)
        }
        imported.prospects! += 1
      }

      const upsertActivity = db.prepare(        `INSERT INTO activities (id, customer_id, type, content, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, content = excluded.content`,
      )
      for (const activity of data.activities) {
        if (!customerService.get(activity.customerId)) continue
        upsertActivity.run(activity.id, activity.customerId, activity.type, activity.content, activity.createdAt ?? now)
        imported.activities! += 1
      }

      const upsertProduct = db.prepare(
        `INSERT INTO products (id, org_id, sku, name, spec, unit, price, currency, moq, hs_code, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sku = excluded.sku, name = excluded.name, spec = excluded.spec, unit = excluded.unit,
           price = excluded.price, currency = excluded.currency, moq = excluded.moq, hs_code = excluded.hs_code,
           category = excluded.category, updated_at = excluded.updated_at
         WHERE products.org_id = excluded.org_id`,
      )
      for (const raw of data.products) {
        const parsed = productCreateInput.safeParse(raw)
        if (!parsed.success) continue
        const p = parsed.data
        const result = upsertProduct.run(raw.id, currentActor().orgId, p.sku, p.name, p.spec, p.unit, p.price, p.currency, p.moq, p.hsCode, p.category, now, now)
        if (Number(result.changes) > 0) imported.products! += 1
      }

      const upsertQuote = db.prepare(
        `INSERT INTO quotes (id, number, customer_id, currency, incoterm, port, valid_until, payment_terms, lead_time, items, notes, status, subtotal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET number = excluded.number, customer_id = excluded.customer_id, currency = excluded.currency,
           incoterm = excluded.incoterm, port = excluded.port, valid_until = excluded.valid_until, payment_terms = excluded.payment_terms,
           lead_time = excluded.lead_time, items = excluded.items, notes = excluded.notes, status = excluded.status,
           subtotal = excluded.subtotal, updated_at = excluded.updated_at`,
      )
      for (const raw of data.quotes) {
        const parsed = quoteCreateInput.safeParse(raw)
        if (!parsed.success || !parsed.data.number) continue
        const q = parsed.data
        if (!customerService.get(q.customerId)) continue
        const clash = db.prepare('SELECT id FROM quotes WHERE number = ?').get(q.number!) as unknown as { id: string } | undefined
        if (clash && clash.id !== raw.id) continue
        const items = q.items as QuoteItem[]
        upsertQuote.run(
          raw.id,
          q.number!,
          q.customerId,
          q.currency ?? 'USD',
          q.incoterm ?? 'FOB',
          q.port,
          q.validUntil,
          q.paymentTerms ?? '',
          q.leadTime,
          JSON.stringify(items),
          q.notes,
          q.status,
          subtotalOf(items),
          now,
          now,
        )
        imported.quotes! += 1
      }

      const upsertRule = db.prepare(
        `INSERT INTO inquiry_rules (id, name, enabled, conditions, action, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, conditions = excluded.conditions,
           action = excluded.action, priority = excluded.priority, updated_at = excluded.updated_at`,
      )
      for (const raw of data.inquiryRules) {
        const parsed = ruleCreateInput.safeParse(raw)
        if (!parsed.success) continue
        const r = parsed.data
        upsertRule.run(raw.id, r.name, r.enabled ? 1 : 0, JSON.stringify(r.conditions), r.action, r.priority, now, now)
        imported.inquiryRules! += 1
      }

      const upsertTemplate = db.prepare(
        `INSERT INTO quote_templates (id, name, is_default, company, default_incoterm, default_currency, default_payment_terms, footer, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default, company = excluded.company,
           default_incoterm = excluded.default_incoterm, default_currency = excluded.default_currency,
           default_payment_terms = excluded.default_payment_terms, footer = excluded.footer, updated_at = excluded.updated_at`,
      )
      for (const raw of data.quoteTemplates) {
        const parsed = templateCreateInput.safeParse(raw)
        if (!parsed.success) continue
        const t = parsed.data
        if (t.isDefault) db.prepare('UPDATE quote_templates SET is_default = 0').run()
        upsertTemplate.run(
          raw.id,
          t.name,
          t.isDefault ? 1 : 0,
          JSON.stringify(t.company),
          t.defaultIncoterm,
          t.defaultCurrency,
          t.defaultPaymentTerms,
          t.footer,
          now,
          now,
        )
        imported.quoteTemplates! += 1
      }

      importCrmExtensions(data, imported, now)

      // 长期记忆：导入到导入者自己的账号（去重、过安全检查与预算）
      if (data.memory !== undefined) imported.memory = memoryService.importOwn(data.memory).imported

      // 导入的数据归导入者所有（server 模式）：只改这次新写入的行（按 id），不碰导入前就在的遗留行
      if (actor.orgId !== 'local') {
        for (const table of OWNED_TABLES) {
          const before = legacy.get(table) ?? new Set<string>()
          const rows = db.prepare(`SELECT id FROM ${table} WHERE org_id = 'local'`).all() as unknown as Array<{ id: string }>
          const update = db.prepare(`UPDATE ${table} SET org_id = ?, owner_id = ? WHERE id = ? AND org_id = 'local'`)
          for (const row of rows) if (!before.has(row.id)) update.run(actor.orgId, actor.id, row.id)
        }
      }
    })

    return { imported, backup, appliedSettings, skippedSettings }
  },

  clearSessions(): number {
    return sessionService.clear()
  },
}

function allCustomers() {
  const items = []
  for (let page = 1; ; page += 1) {
    const batch = customerService.list({ page, pageSize: 200 })
    items.push(...batch.items)
    if (batch.items.length < 200) break
  }
  return items
}

function allProspects() {
  const items = []
  for (let offset = 0; ; offset += 200) {
    const batch = prospectService.list({ limit: 200, offset })
    items.push(...batch.items)
    if (batch.items.length < 200) break
  }
  return items
}

export function assertImportPayload(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'VALIDATION_ERROR', '导入内容必须是导出格式的 JSON 对象')
  }
}

/** 导出全部任务（list 单次最多 500 条，按到期分页不方便，直接按创建时间取全部可见行） */
function allTasks() {
  const ids = db.prepare('SELECT id FROM tasks WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at').all(currentActor().orgId) as unknown as Array<{ id: string }>
  const out = []
  for (const row of ids) {
    try {
      out.push(taskService.require(row.id))
    } catch {
      // 不可见的跳过
    }
  }
  return out
}

function allDeals() {
  const ids = db.prepare('SELECT id FROM deals WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at').all(currentActor().orgId) as unknown as Array<{ id: string }>
  return ids.flatMap((row) => {
    try {
      return [dealService.require(row.id)]
    } catch {
      return []
    }
  })
}

function allOrders() {
  const ids = db.prepare('SELECT id FROM orders WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at').all(currentActor().orgId) as unknown as Array<{ id: string }>
  return ids.flatMap((row) => {
    try {
      return [orderService.require(row.id)]
    } catch {
      return []
    }
  })
}

function importCrmExtensions(
  data: { tasks: unknown[]; deals: unknown[]; orders: unknown[] },
  imported: Record<string, number>,
  now: number,
): void {
  const actor = currentActor()
  const customerExists = (id: string | null | undefined): boolean => Boolean(id && db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id))
  const upsertTask = db.prepare(
    `INSERT INTO tasks (id, title, notes, customer_id, quote_id, due_at, status, priority, source, org_id, owner_id, created_at, updated_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, notes = excluded.notes, customer_id = excluded.customer_id, quote_id = excluded.quote_id,
       due_at = excluded.due_at, status = excluded.status, priority = excluded.priority, updated_at = excluded.updated_at, done_at = excluded.done_at`,
  )
  for (const raw of data.tasks) {
    const parsed = taskImport.safeParse(raw)
    if (!parsed.success) continue
    const t = parsed.data
    const customerId = customerExists(t.customerId) ? t.customerId! : null
    upsertTask.run(t.id, t.title, t.notes, customerId, t.quoteId ?? null, t.dueAt ?? null, t.status, t.priority, t.source, actor.orgId, actor.id, t.createdAt ?? now, now, t.doneAt ?? null)
    imported.tasks! += 1
  }
  const upsertDeal = db.prepare(
    `INSERT INTO deals (id, title, customer_id, quote_id, amount, currency, stage, probability, expected_close, won_reason, lost_reason, notes, source,
       org_id, owner_id, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, customer_id = excluded.customer_id, quote_id = excluded.quote_id, amount = excluded.amount,
       currency = excluded.currency, stage = excluded.stage, probability = excluded.probability, expected_close = excluded.expected_close,
       won_reason = excluded.won_reason, lost_reason = excluded.lost_reason, notes = excluded.notes, updated_at = excluded.updated_at, closed_at = excluded.closed_at`,
  )
  for (const raw of data.deals) {
    const parsed = dealImport.safeParse(raw)
    if (!parsed.success || !customerExists(parsed.data.customerId)) continue
    const d = parsed.data
    const probability = d.probabilityOverridden === false ? null : (d.probability ?? null)
    upsertDeal.run(d.id, d.title, d.customerId, d.quoteId ?? null, d.amount, d.currency, d.stage, probability, d.expectedClose, d.wonReason, d.lostReason, d.notes, d.source, actor.orgId, actor.id, d.createdAt ?? now, now, d.closedAt ?? null)
    imported.deals! += 1
  }
  const upsertOrder = db.prepare(
    `INSERT INTO orders (id, number, customer_id, quote_id, deal_id, currency, amount, items, incoterm, payment_terms, deposit_amount, due_date, status, notes,
       container_type, container_no, bl_no, vessel, port_of_loading, port_of_discharge, etd, eta, org_id, owner_id, created_at, updated_at, shipped_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET number = excluded.number, customer_id = excluded.customer_id, quote_id = excluded.quote_id, deal_id = excluded.deal_id,
       currency = excluded.currency, amount = excluded.amount, items = excluded.items, incoterm = excluded.incoterm, payment_terms = excluded.payment_terms,
       deposit_amount = excluded.deposit_amount, due_date = excluded.due_date, status = excluded.status, notes = excluded.notes,
       container_type = excluded.container_type, container_no = excluded.container_no, bl_no = excluded.bl_no, vessel = excluded.vessel,
       port_of_loading = excluded.port_of_loading, port_of_discharge = excluded.port_of_discharge, etd = excluded.etd, eta = excluded.eta,
       updated_at = excluded.updated_at, shipped_at = excluded.shipped_at, completed_at = excluded.completed_at`,
  )
  const upsertPayment = db.prepare(
    `INSERT INTO payments (id, order_id, amount, currency, received_at, method, reference, notes, created_by, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, received_at = excluded.received_at, method = excluded.method,
       reference = excluded.reference, notes = excluded.notes`,
  )
  for (const raw of data.orders) {
    const parsed = orderImport.safeParse(raw)
    if (!parsed.success || !customerExists(parsed.data.customerId)) continue
    const o = parsed.data
    const clash = db.prepare('SELECT id FROM orders WHERE number = ? OR (quote_id IS NOT NULL AND quote_id = ?)').get(o.number, o.quoteId ?? null) as unknown as { id: string } | undefined
    if (clash && clash.id !== o.id) continue
    const sh = o.shipment
    upsertOrder.run(o.id, o.number, o.customerId, o.quoteId ?? null, o.dealId ?? null, o.currency, o.amount, JSON.stringify(o.items), o.incoterm, o.paymentTerms, o.depositAmount, o.dueDate, o.status, o.notes,
      sh.containerType, sh.containerNo, sh.blNo, sh.vessel, sh.portOfLoading, sh.portOfDischarge, sh.etd, sh.eta, actor.orgId, actor.id, o.createdAt ?? now, now, o.shippedAt ?? null, o.completedAt ?? null)
    imported.orders! += 1
    for (const p of o.payments) {
      upsertPayment.run(p.id, o.id, p.amount, p.currency, p.receivedAt, p.method, p.reference, p.notes, actor.id, p.source, p.createdAt ?? now)
      imported.payments! += 1
    }
  }
}
