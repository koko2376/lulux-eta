import type { DealStage, Money, Order, OrderStatus } from '../api/crm'
import { localized, t } from '../i18n'
import { formatMoney } from './quote'

/** 商机阶段（契约 §10.7）及默认赢单概率 */
export const DEAL_STAGE_LABEL: Record<DealStage, string> = localized(() => ({
  prospecting: t('crm.stageProspecting'),
  qualified: t('crm.stageQualified'),
  proposal: t('crm.stageProposal'),
  negotiation: t('crm.stageNegotiation'),
  won: t('crm.stageWon'),
  lost: t('crm.stageLost'),
}))
export const DEFAULT_PROBABILITY: Record<DealStage, number> = {
  prospecting: 10,
  qualified: 25,
  proposal: 50,
  negotiation: 75,
  won: 100,
  lost: 0,
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = localized(() => ({
  pending_production: t('crm.orderPending'),
  in_production: t('crm.orderInProduction'),
  shipped: t('crm.orderShipped'),
  completed: t('crm.orderCompleted'),
  cancelled: t('crm.orderCancelled'),
}))

export const PAYMENT_STATUS_LABEL: Record<Order['paymentStatus'], string> = localized(() => ({
  unpaid: t('crm.payUnpaid'),
  partial: t('crm.payPartial'),
  paid: t('crm.payPaid'),
}))

/** 多币种金额：按币种分别显示，不做汇率折算；空则 “—” */
export function formatMoneyMap(map: Money | undefined | null): string[] {
  const entries = Object.entries(map ?? {}).filter(([, v]) => Number.isFinite(v) && v !== 0)
  if (!entries.length) return []
  return entries.sort((a, b) => b[1] - a[1]).map(([cur, v]) => formatMoney(v, cur))
}

/** 订单状态步骤条：已取消时没有“当前步”，其余为 done / current / todo */
export function orderSteps(status: OrderStatus): { status: OrderStatus; state: 'done' | 'current' | 'todo' }[] {
  const flow: OrderStatus[] = ['pending_production', 'in_production', 'shipped', 'completed']
  const index = flow.indexOf(status)
  return flow.map((s, i) => ({
    status: s,
    state:
      status === 'cancelled'
        ? 'todo'
        : i < index
          ? 'done'
          : i === index
            ? s === 'completed'
              ? 'done'
              : 'current'
            : 'todo',
  }))
}

/** 下一步可推进到的状态（按顺序，一次一步） */
export function nextOrderStatus(status: OrderStatus): OrderStatus | null {
  const flow: OrderStatus[] = ['pending_production', 'in_production', 'shipped', 'completed']
  const index = flow.indexOf(status)
  return index >= 0 && index < flow.length - 1 ? flow[index + 1] : null
}

/** 本地日期 YYYY-MM-DD（收款日默认今天） */
export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 金额输入：去掉千分位逗号与空白，非法返回 NaN */
export function parseAmount(raw: string | number): number {
  if (typeof raw === 'number') return raw
  const cleaned = raw.replace(/[,\s]/g, '')
  if (!cleaned) return NaN
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}
