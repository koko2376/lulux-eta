import { customerService } from '../customer-service.js'
import { quoteService } from '../quote-service.js'
import { defaultTimeZone } from '../tools/core-tools.js'
import { describeInstant } from '../tools/time.js'

/** 今天的日期与用户时区（只精确到天，避免每分钟变化破坏 Provider 的前缀缓存） */
export function dateLine(now = Date.now()): string {
  const zone = defaultTimeZone()
  const info = describeInstant(now, zone)
  return `今天是 ${info.local.slice(0, 10)}（${info.weekday}），用户所在时区 ${zone}（${info.utcOffset}）。涉及具体时刻或跨时区换算时请用 get_time 工具。`
}

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text)

/** 会话绑定的业务上下文（当前客户 / 当前报价）→ 系统提示里的一段文字；看不到的数据直接略过 */
export function businessContext(context: { customerId: string | null; quoteId: string | null }): string {
  const parts: string[] = []
  let customerId = context.customerId
  if (context.quoteId) {
    const quote = quoteService.get(context.quoteId)
    if (quote) {
      customerId = customerId ?? quote.customerId
      const items = quote.items
        .slice(0, 30)
        .map((item, i) => `  ${i + 1}. ${item.name}${item.spec ? `（${clip(item.spec, 80)}）` : ''} × ${item.qty} ${item.unit} @ ${item.unitPrice} ${quote.currency}`)
        .join('\n')
      parts.push(
        [
          `### 当前报价单 ${quote.number}（id=${quote.id}，状态 ${quote.status}）`,
          `币种 ${quote.currency}，贸易术语 ${quote.incoterm}${quote.port ? ` ${quote.port}` : ''}，有效期 ${quote.validUntil || '未填'}，付款 ${quote.paymentTerms || '未填'}，交期 ${quote.leadTime || '未填'}`,
          `明细（小计 ${quote.subtotal} ${quote.currency}）：\n${items || '  （无）'}${quote.items.length > 30 ? `\n  …共 ${quote.items.length} 项` : ''}`,
          quote.notes ? `备注：${clip(quote.notes, 500)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
  }
  if (customerId) {
    const customer = customerService.get(customerId)
    if (customer) {
      const contacts = customer.contacts
        .slice(0, 5)
        .map((c) => `  - ${c.name || '未命名'}${c.title ? `（${c.title}）` : ''}${c.email ? ` ${c.email}` : ''}${c.phone ? ` ${c.phone}` : ''}${c.isPrimary ? ' [主联系人]' : ''}`)
        .join('\n')
      const activities = customerService
        .activities(customer.id)
        .slice(0, 5)
        .map((a) => `  - ${new Date(a.createdAt).toISOString().slice(0, 10)} [${a.type}] ${clip(a.content.replace(/\s+/g, ' '), 160)}`)
        .join('\n')
      const quotes = quoteService
        .list({ customerId: customer.id })
        .slice(0, 5)
        .map((q) => `  - ${q.number}（id=${q.id}）${q.status} ${q.subtotal} ${q.currency} ${q.incoterm}`)
        .join('\n')
      parts.unshift(
        [
          `### 当前客户：${customer.company}（id=${customer.id}）`,
          `国家 ${customer.country || '未知'}，阶段 ${customer.stage}，网站 ${customer.website || '无'}，标签 ${customer.tags.join('、') || '无'}，负责人 ${customer.ownerName}`,
          customer.notes ? `备注：${clip(customer.notes, 500)}` : '',
          contacts ? `联系人：\n${contacts}` : '',
          activities ? `最近跟进：\n${activities}` : '',
          quotes ? `报价单：\n${quotes}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
  }
  return parts.join('\n\n')
}
