import { z } from 'zod'
import { describeInstant } from '../tools/time.js'
import { sequenceService, type Enrollment, type Sequence, type SequenceSend } from '../email/sequence-service.js'
import type { CrmTool } from './crm-tools.js'

/**
 * 开发信序列工具：建序列、加联系人、看待确认、确认发送、停发、退订。
 * 序列到点只生成草稿进“待确认”；Agent 不能开启自动发送（只能用户在界面上开）。
 */

function when(instant: number | null, zone: string): string | null {
  if (!instant) return null
  const d = describeInstant(instant, zone)
  return `${d.local.slice(0, 16)} ${zone} (${d.utcOffset})`
}

function sequenceSummary(s: Sequence) {
  return {
    id: s.id,
    name: s.name,
    from: s.accountEmail,
    status: s.status,
    steps: s.steps.map((step, index) => ({ step: index + 1, delayDays: step.delayDays, subject: step.subject })),
    sendWindow: `${s.windowStart}:00–${s.windowEnd}:00（对方当地时间${s.skipWeekends ? '，跳过周末' : ''}）`,
    autoSend: s.autoSend,
    dailyLimit: s.dailyLimit,
    stats: s.stats,
  }
}

function enrollmentSummary(e: Enrollment) {
  return {
    id: e.id,
    email: e.email,
    name: e.name,
    company: e.company,
    timezone: e.timezone,
    status: e.status,
    step: e.currentStep + 1,
    nextSendAt: when(e.nextSendAt, e.timezone),
    stopReason: e.stopReason || undefined,
  }
}

function sendSummary(s: SequenceSend) {
  return {
    id: s.id,
    sequence: s.sequenceName,
    to: s.email,
    name: s.name,
    company: s.company,
    step: s.stepIndex + 1,
    subject: s.subject,
    preview: s.preview,
    status: s.status,
    error: s.error || undefined,
    warning: s.missingVars.length ? `模板变量 ${s.missingVars.join('、')} 没有值，已留空，发送前建议修改草稿` : undefined,
    draftId: s.draftId,
  }
}

const stepSchema = {
  type: 'object',
  properties: {
    delayDays: { type: 'integer', minimum: 0, maximum: 90, description: '第 1 封：加入后几天发（0=尽快，在对方工作时间）；之后每封：距上一封发出几天（第 1/4/10 天 → 0/3/6）' },
    subject: { type: 'string', description: '主题；跟进步骤可用 "Re: 第一封主题"' },
    body: { type: 'string', description: '纯文本正文；可用变量 {{firstName|there}} {{name}} {{company}} {{country}} {{senderName}}' },
  },
  required: ['delayDays', 'subject', 'body'],
}

const stepZ = z.object({ delayDays: z.number().int().min(0).max(90), subject: z.string(), body: z.string() }).strict()

export const SEQUENCE_TOOLS: CrmTool[] = [
  {
    name: 'sequence_list',
    description: '列出开发信序列及进度统计（联系人数、已回信、退订、退信、待确认、已发）。',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} },
    run() {
      return { sequences: sequenceService.list().map(sequenceSummary) }
    },
  },
  {
    name: 'sequence_get',
    description: '查看一个序列的步骤全文和联系人进度（每人当前第几步、下一封对方当地几点发、停发原因）。',
    risk: 'read',
    inputSchema: { type: 'object', properties: { sequenceId: { type: 'string' } }, required: ['sequenceId'] },
    run(args) {
      const { sequenceId } = z.object({ sequenceId: z.string().trim().min(1).max(80) }).parse(args)
      const sequence = sequenceService.get(sequenceId)
      return { ...sequenceSummary(sequence), steps: sequence.steps, enrollments: sequenceService.enrollments(sequenceId).slice(0, 100).map(enrollmentSummary) }
    },
  },
  {
    name: 'sequence_create',
    description:
      '新建开发信序列（多步跟进，按对方时区工作时间排期；对方回信、同公司回信、退订、退信自动停发）。' +
      '到点只生成草稿进“待确认”，由用户确认后才发出；不能开启自动发送。' +
      'delayDays 是距上一封的间隔：例如“第 1、4、10 天发”= delayDays 0、3、6。' +
      '系统会在每封末尾自动加退订说明，正文里不要再写。用对方语种写，卖点具体、不夸大；' +
      '不要编造用户的公司名、认证、客户案例等事实——不知道的先问用户，或用 {{senderName}} 等变量。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        accountId: { type: 'string', description: '发信邮箱账户 id，默认用户的默认邮箱' },
        steps: { type: 'array', items: stepSchema, minItems: 1, maxItems: 10 },
        windowStart: { type: 'integer', minimum: 0, maximum: 23, description: '对方当地几点开始发，默认 9' },
        windowEnd: { type: 'integer', minimum: 1, maximum: 24, description: '对方当地几点后不发，默认 17' },
        skipWeekends: { type: 'boolean', description: '默认 true' },
        dailyLimit: { type: 'integer', minimum: 1, maximum: 500, description: '每天最多生成 / 发送多少封，默认 50' },
      },
      required: ['name', 'steps'],
    },
    run(args) {
      const input = z
        .object({
          name: z.string(),
          accountId: z.string().optional(),
          steps: z.array(stepZ),
          windowStart: z.number().int().optional(),
          windowEnd: z.number().int().optional(),
          skipWeekends: z.boolean().optional(),
          dailyLimit: z.number().int().optional(),
        })
        .strict()
        .parse(args)
      return { sequence: sequenceSummary(sequenceService.create(input, { allowAutoSend: false })), note: '序列已建好，用 sequence_enroll 加联系人；到点生成的草稿会进待确认，用户确认后才发。' }
    },
  },
  {
    name: 'sequence_update',
    description: '修改序列：名称、步骤、发送时段、跳过周末、每日上限、暂停 / 恢复（status）。不能开启自动发送。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string' },
        name: { type: 'string' },
        steps: { type: 'array', items: stepSchema, minItems: 1, maxItems: 10 },
        windowStart: { type: 'integer' },
        windowEnd: { type: 'integer' },
        skipWeekends: { type: 'boolean' },
        dailyLimit: { type: 'integer' },
        status: { type: 'string', enum: ['active', 'paused'] },
      },
      required: ['sequenceId'],
    },
    run(args) {
      const { sequenceId, ...patch } = z
        .object({
          sequenceId: z.string().trim().min(1).max(80),
          name: z.string().optional(),
          steps: z.array(stepZ).optional(),
          windowStart: z.number().int().optional(),
          windowEnd: z.number().int().optional(),
          skipWeekends: z.boolean().optional(),
          dailyLimit: z.number().int().optional(),
          status: z.enum(['active', 'paused']).optional(),
        })
        .strict()
        .parse(args)
      return { sequence: sequenceSummary(sequenceService.update(sequenceId, patch, { allowAutoSend: false })) }
    },
  },
  {
    name: 'sequence_enroll',
    description:
      '把联系人加入序列：直接给邮箱（可带姓名、公司、国家、时区），或给客户 id / 潜客 id（取主联系人邮箱）。' +
      '时区不给就按国家推断。退订名单里的、已在别的进行中序列里的、制裁初筛命中的会跳过并说明原因（制裁命中经用户核实后可 force）。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string' },
        contacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              email: { type: 'string' },
              name: { type: 'string' },
              company: { type: 'string' },
              country: { type: 'string', description: 'ISO2 或国家名' },
              timezone: { type: 'string', description: 'IANA 时区，如 Europe/Berlin' },
            },
            required: ['email'],
          },
          maxItems: 500,
        },
        customerIds: { type: 'array', items: { type: 'string' }, maxItems: 500 },
        prospectIds: { type: 'array', items: { type: 'string' }, maxItems: 500 },
        force: { type: 'boolean', description: '仅在用户核实过制裁初筛命中后使用' },
      },
      required: ['sequenceId'],
    },
    run(args) {
      const { sequenceId, ...input } = z
        .object({
          sequenceId: z.string().trim().min(1).max(80),
          contacts: z.array(z.record(z.string(), z.unknown())).optional(),
          customerIds: z.array(z.string()).optional(),
          prospectIds: z.array(z.string()).optional(),
          force: z.boolean().optional(),
        })
        .strict()
        .parse(args)
      const result = sequenceService.enroll(sequenceId, input)
      return { enrolled: result.enrolled.map(enrollmentSummary), skipped: result.skipped }
    },
  },
  {
    name: 'sequence_queue',
    description: '列出待确认的开发信（已按步骤生成的草稿，等用户确认发送），含收件人、主题、正文开头。也可查已发 / 失败 / 跳过。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'sent', 'failed', 'skipped'], description: '默认 pending' },
        sequenceId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    run(args) {
      const input = z
        .object({ status: z.enum(['pending', 'sent', 'failed', 'skipped']).default('pending'), sequenceId: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) })
        .parse(args)
      const items = sequenceService.sends(input)
      return { total: items.length, items: items.map(sendSummary) }
    },
  },
  {
    name: 'sequence_approve',
    description: '确认发送待确认的开发信（会真的发出邮件）。只在用户明确同意发送这些邮件时调用；需要用户批准。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { sendIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } },
      required: ['sendIds'],
    },
    async run(args) {
      const { sendIds } = z.object({ sendIds: z.array(z.string().trim().min(1).max(80)).min(1).max(50) }).strict().parse(args)
      const result = await sequenceService.approve(sendIds)
      return { sent: result.sent.map(sendSummary), failed: result.failed }
    },
  },
  {
    name: 'sequence_skip',
    description: '跳过一封待确认的开发信（删除草稿，联系人进入下一步）。',
    risk: 'write',
    inputSchema: { type: 'object', properties: { sendId: { type: 'string' } }, required: ['sendId'] },
    run(args) {
      const { sendId } = z.object({ sendId: z.string().trim().min(1).max(80) }).strict().parse(args)
      return { send: sendSummary(sequenceService.skip(sendId)) }
    },
  },
  {
    name: 'sequence_stop',
    description: '停止 / 暂停 / 恢复某个联系人的序列（enrollmentId 从 sequence_get 获取）。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { enrollmentId: { type: 'string' }, action: { type: 'string', enum: ['stop', 'pause', 'resume'] } },
      required: ['enrollmentId', 'action'],
    },
    run(args) {
      const { enrollmentId, action } = z.object({ enrollmentId: z.string().trim().min(1).max(80), action: z.enum(['stop', 'pause', 'resume']) }).strict().parse(args)
      const status = action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'active'
      return { enrollment: enrollmentSummary(sequenceService.setEnrollmentStatus(enrollmentId, status)) }
    },
  },
  {
    name: 'email_unsubscribe',
    description: '把邮箱加入退订名单（以后不会再被加入任何序列，进行中的序列立即停发）。对方要求不要再联系时使用。',
    risk: 'write',
    inputSchema: { type: 'object', properties: { email: { type: 'string' }, reason: { type: 'string' } }, required: ['email'] },
    run(args) {
      const input = z.object({ email: z.string(), reason: z.string().optional() }).strict().parse(args)
      return sequenceService.addSuppression(input)
    },
  },
]
