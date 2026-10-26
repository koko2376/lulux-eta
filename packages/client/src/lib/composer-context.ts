import type { Customer, Quote } from '../api'
import type { Deal, Order } from '../api/crm'
import type { EmailAddress, EmailMessage } from '../api/email'
import { t } from '../i18n'
import { DEAL_STAGE_LABEL, ORDER_STATUS_LABEL } from './crm'
import { QUOTE_STATUS_LABEL, STAGE_LABEL } from './labels'

/**
 * 输入框“+”添加的一次性上下文（客户 / 报价 / 邮件 / 商机 / 订单）：只随下一条消息发送一次，
 * 以 <context> 块附在消息正文后面，Agent 当作数据读取；发送后清空。
 * 与会话绑定（标题栏插头，每轮都进系统提示）不同。
 */
export type RefKind = 'customer' | 'quote' | 'email' | 'deal' | 'order'

export interface RefContext {
  kind: RefKind
  id: string
  /** 输入框标签与气泡里显示的简短名称 */
  label: string
  /** 发给 Agent 的文字摘要 */
  summary: string
}

/** 邮件正文最多带多少字符 */
export const REF_BODY_LIMIT = 4000

/** 标签里不能出现的字符（双引号、换行）替换掉，保证能被解析回来 */
function attr(value: string): string {
  return value.replace(/["\r\n]+/g, ' ').trim()
}

/** 正文里的结束标记改写掉，引用内容不能提前结束上下文块 */
function body(value: string): string {
  return value.replace(/<\/context>/gi, '</ context>')
}

export function truncate(text: string, limit = REF_BODY_LIMIT): string {
  const clean = text.replace(/\r\n/g, '\n').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…${t('composerContext.truncated', [clean.length])}` : clean
}

function addr(a: EmailAddress): string {
  return a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address
}

function day(ms: number | null | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

const line = (key: string, value: string | number | null | undefined): string | null =>
  value === '' || value === null || value === undefined ? null : t(key, [value])

export function customerContext(c: Customer): RefContext {
  const contacts = (c.contacts ?? [])
    .slice(0, 5)
    .map((p) => [p.name, p.title, p.email, p.phone || p.whatsapp].filter(Boolean).join(' · '))
    .filter(Boolean)
  const lines = [
    line('composerContext.fCompany', c.company),
    line('composerContext.fCountry', c.country),
    line('composerContext.fStage', STAGE_LABEL[c.stage] ?? c.stage),
    line('composerContext.fWebsite', c.website),
    line('composerContext.fSource', c.source),
    line('composerContext.fTags', (c.tags ?? []).join(', ')),
    line('composerContext.fOwner', c.ownerName),
    contacts.length ? `${t('composerContext.fContacts')}\n${contacts.map((x) => `- ${x}`).join('\n')}` : null,
    line('composerContext.fNotes', c.notes ? truncate(c.notes, 1500) : ''),
  ]
  return { kind: 'customer', id: c.id, label: c.company, summary: lines.filter(Boolean).join('\n') }
}

export function quoteContext(q: Quote, customerName = ''): RefContext {
  const items = (q.items ?? [])
    .slice(0, 30)
    .map(
      (i) =>
        `- ${[i.name, i.spec].filter(Boolean).join(' / ')} · ${i.qty} ${i.unit} × ${money(q.currency, i.unitPrice)}`,
    )
  const lines = [
    line('composerContext.fNumber', q.number),
    line('composerContext.fCustomer', customerName),
    line('composerContext.fStatus', QUOTE_STATUS_LABEL[q.status] ?? q.status),
    line('composerContext.fAmount', money(q.currency, q.subtotal)),
    line('composerContext.fIncoterm', [q.incoterm, q.port, q.paymentTerms].filter(Boolean).join(' · ')),
    line('composerContext.fLeadTime', q.leadTime),
    line('composerContext.fValidUntil', q.validUntil),
    items.length
      ? `${t('composerContext.fItems')}\n${items.join('\n')}${q.items.length > 30 ? `\n- …(+${q.items.length - 30})` : ''}`
      : null,
    line('composerContext.fNotes', q.notes ? truncate(q.notes, 1000) : ''),
  ]
  return { kind: 'quote', id: q.id, label: q.number, summary: lines.filter(Boolean).join('\n') }
}

export function emailContext(m: EmailMessage): RefContext {
  const subject = m.subject || t('composerContext.noSubject')
  const lines = [
    line('composerContext.fSubject', subject),
    line('composerContext.fFrom', addr(m.from)),
    line('composerContext.fTo', m.to.map(addr).join(', ')),
    m.cc.length ? line('composerContext.fCc', m.cc.map(addr).join(', ')) : null,
    line('composerContext.fDate', day(m.date)),
    line('composerContext.fCustomer', m.customerName),
    m.attachments?.length
      ? line('composerContext.fAttachments', m.attachments.map((a) => a.filename).join(', '))
      : null,
    t('composerContext.fBody'),
    truncate(m.text || m.snippet || ''),
  ]
  return { kind: 'email', id: m.id, label: subject, summary: lines.filter(Boolean).join('\n') }
}

export function dealContext(d: Deal): RefContext {
  const lines = [
    line('composerContext.fTitle', d.title),
    line('composerContext.fCustomer', d.customerName),
    line('composerContext.fStage', DEAL_STAGE_LABEL[d.stage] ?? d.stage),
    line('composerContext.fAmount', money(d.currency, d.amount)),
    line('composerContext.fProbability', `${d.probability}%`),
    line('composerContext.fExpectedClose', d.expectedClose),
    line('composerContext.fOwner', d.ownerName),
    d.stage === 'won' ? line('composerContext.fWonReason', d.wonReason) : null,
    d.stage === 'lost' ? line('composerContext.fLostReason', d.lostReason) : null,
    line('composerContext.fNotes', d.notes ? truncate(d.notes, 1000) : ''),
  ]
  return { kind: 'deal', id: d.id, label: d.title, summary: lines.filter(Boolean).join('\n') }
}

export function orderContext(o: Order): RefContext {
  const s = o.shipment
  const route = [s?.portOfLoading, s?.portOfDischarge].filter(Boolean).join(' → ')
  const lines = [
    line('composerContext.fNumber', o.number),
    line('composerContext.fCustomer', o.customerName),
    line('composerContext.fStatus', ORDER_STATUS_LABEL[o.status] ?? o.status),
    line('composerContext.fAmount', money(o.currency, o.amount)),
    line(
      'composerContext.fPaid',
      `${money(o.currency, o.paid)} / ${t('composerContext.balance', [money(o.currency, o.balance)])}`,
    ),
    line('composerContext.fDueDate', o.dueDate ? `${o.dueDate}${o.overdue ? t('composerContext.overdue') : ''}` : ''),
    line('composerContext.fIncoterm', [o.incoterm, o.paymentTerms].filter(Boolean).join(' · ')),
    line('composerContext.fQuote', o.quoteNumber),
    line(
      'composerContext.fShipping',
      [route, s?.etd && `ETD ${s.etd}`, s?.eta && `ETA ${s.eta}`].filter(Boolean).join(' · '),
    ),
    line('composerContext.fNotes', o.notes ? truncate(o.notes, 1000) : ''),
  ]
  return { kind: 'order', id: o.id, label: o.number, summary: lines.filter(Boolean).join('\n') }
}

/** 发送时：用户输入 + 引用块 */
export function withRefContexts(content: string, refs: RefContext[]): string {
  if (!refs.length) return content
  const blocks = refs.map(
    (r) =>
      `<context kind="${r.kind}" label="${attr(r.label)}">\n${t('composerContext.dataNote')}\n${body(r.summary)}\n</context>`,
  )
  return `${content}\n\n${blocks.join('\n\n')}`
}

const BLOCK_RE = /\n\n<context kind="(customer|quote|email|deal|order)" label="([^"\n]*)">\n[\s\S]*?\n<\/context>/g

/** 气泡里显示的用户消息：引用块折叠成一行名称（原文仍保留在消息内容里，复制、编辑照旧） */
export function stripRefContexts(content: string): string {
  const labels: string[] = []
  const rest = content.replace(BLOCK_RE, (_m, kind: RefKind, label: string) => {
    labels.push(t(`composerContext.chip_${kind}`, [label]))
    return ''
  })
  if (!labels.length) return content
  return `${rest}\n\n${labels.map((l) => `↳ ${l}`).join('\n')}`
}
