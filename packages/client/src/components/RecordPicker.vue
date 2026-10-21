<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import * as api from '../api'
import { dealsApi, ordersApi, type Deal, type Order } from '../api/crm'
import { listEmailMessages, type EmailMessageSummary } from '../api/email'
import { DEAL_STAGE_LABEL, ORDER_STATUS_LABEL } from '../lib/crm'
import { STAGE_LABEL } from '../lib/labels'
import StateBlock from './ui/StateBlock.vue'
import UiModal from './ui/UiModal.vue'
import { t } from '../i18n'

/**
 * 输入框“+”添加上下文里的记录选择器：客户 / 报价 / 邮件 / 商机 / 订单（样式同 CustomerPicker）。
 * 列表都来自已按可见性过滤的接口，只会出现当前用户能看到的记录。
 * 客户、邮件在服务端搜索；商机、订单、报价取最近的一批在本地筛选。
 */
export type RecordKind = 'customer' | 'quote' | 'email' | 'deal' | 'order'
export type PickedRecord =
  | { kind: 'customer'; item: api.Customer }
  | { kind: 'email'; item: EmailMessageSummary }
  | { kind: 'deal'; item: Deal }
  | { kind: 'order'; item: Order }
  | { kind: 'quote'; item: api.Quote }

const props = defineProps<{ kind: RecordKind; customerId?: string | null }>()
const emit = defineEmits<{ close: []; pick: [picked: PickedRecord] }>()

interface Row {
  id: string
  title: string
  sub: string
  meta: string
  picked: PickedRecord
}

const query = ref('')
const rows = ref<Row[]>([])
/** 不带搜索词时的总数：为 0 显示“还没有…”，否则显示“没有匹配” */
const total = ref<number | null>(null)
const loading = ref(false)
const error = ref('')
let cached: Row[] | null = null
let timer = 0
let seq = 0

const money = (currency: string, amount: number) =>
  `${currency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const day = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function emailRow(m: EmailMessageSummary): Row {
  const who = m.folder === 'sent' ? m.to.map((a) => a.name || a.address).join(', ') : m.from.name || m.from.address
  return {
    id: m.id,
    title: m.subject || t('composerContext.noSubject'),
    sub: [m.folder === 'sent' ? t('composerContext.toWho', [who]) : who, m.customerName].filter(Boolean).join(' · '),
    meta: day(m.date),
    picked: { kind: 'email', item: m },
  }
}

async function loadAll(): Promise<Row[]> {
  if (cached) return cached
  if (props.kind === 'deal') {
    const res = await dealsApi.list({ limit: 200 })
    cached = res.items.map((d) => ({
      id: d.id,
      title: d.title,
      sub: [d.customerName, DEAL_STAGE_LABEL[d.stage] ?? d.stage].join(' · '),
      meta: money(d.currency, d.amount),
      picked: { kind: 'deal', item: d },
    }))
  } else if (props.kind === 'order') {
    const res = await ordersApi.list({ limit: 200 })
    cached = res.items.map((o) => ({
      id: o.id,
      title: o.number,
      sub: [o.customerName, ORDER_STATUS_LABEL[o.status] ?? o.status].join(' · '),
      meta: money(o.currency, o.amount),
      picked: { kind: 'order', item: o },
    }))
  } else {
    const [quotes, customers] = await Promise.all([
      props.customerId ? api.listQuotesForCustomer(props.customerId) : api.listQuotes(),
      api.listCustomers({ pageSize: 200 }).catch(() => ({ items: [] as api.Customer[], total: 0 })),
    ])
    const company = new Map(customers.items.map((c) => [c.id, c.company]))
    cached = quotes.map((q) => ({
      id: q.id,
      title: q.number,
      sub: [company.get(q.customerId), q.incoterm, q.validUntil && t('composerContext.validUntil', [q.validUntil])]
        .filter(Boolean)
        .join(' · '),
      meta: money(q.currency, q.subtotal),
      picked: { kind: 'quote', item: q },
    }))
  }
  return cached
}

async function search(): Promise<void> {
  const mine = ++seq
  loading.value = true
  error.value = ''
  const q = query.value.trim()
  try {
    let next: Row[]
    if (props.kind === 'customer') {
      const res = await api.listCustomers({ query: q || undefined, pageSize: 30 })
      next = res.items.map((c) => ({
        id: c.id,
        title: c.company,
        sub: [c.country, c.contacts?.[0]?.email].filter(Boolean).join(' · '),
        meta: STAGE_LABEL[c.stage] ?? c.stage,
        picked: { kind: 'customer', item: c },
      }))
      if (!q) total.value = res.total
    } else if (props.kind === 'email') {
      const res = await listEmailMessages({ folder: 'all', query: q || undefined, pageSize: 30 })
      next = res.items.map(emailRow)
      if (!q) total.value = res.total
    } else {
      const all = await loadAll()
      total.value = all.length
      const needle = q.toLowerCase()
      next = needle ? all.filter((r) => `${r.title} ${r.sub}`.toLowerCase().includes(needle)) : all
    }
    if (mine === seq) rows.value = next
  } catch (e) {
    if (mine === seq) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === seq) loading.value = false
  }
}

onMounted(search)
watch(query, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(search, props.kind === 'email' || props.kind === 'customer' ? 250 : 80)
})

const title = computed(() => t(`composerContext.pick_${props.kind}`))
const placeholder = computed(() => t(`composerContext.search_${props.kind}`))
/** 一条都没有（不是搜不到）：给出更具体的空状态 */
const nothingYet = computed(() => total.value === 0 && !query.value.trim())
</script>

<template>
  <UiModal :title="title" :width="520" @close="emit('close')">
    <div class="stack" :data-testid="`record-picker-${kind}`">
      <input v-model="query" class="input" :placeholder="placeholder" :aria-label="placeholder" autofocus />
      <StateBlock v-if="loading && !rows.length" state="loading" compact />
      <StateBlock v-else-if="error" state="error" :message="error" compact @retry="search" />
      <StateBlock
        v-else-if="!rows.length"
        state="empty"
        :title="nothingYet ? $t(`composerContext.none_${kind}`) : $t('composerContext.noMatch')"
        :message="nothingYet && kind === 'email' ? $t('composerContext.noneEmailHint') : undefined"
        compact
      />
      <ul v-else class="pick-list" role="listbox" :aria-label="title">
        <li v-for="r in rows" :key="r.id">
          <button type="button" class="pick" role="option" :aria-selected="false" @click="emit('pick', r.picked)">
            <span class="pick-main">
              <b :title="r.title">{{ r.title }}</b>
              <span class="muted" :title="r.sub">{{ r.sub }}</span>
            </span>
            <span class="pick-meta muted">{{ r.meta }}</span>
          </button>
        </li>
      </ul>
    </div>
  </UiModal>
</template>

<style scoped>
.pick-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 360px;
  overflow: auto;
}
.pick {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: left;
  font-size: 13px;
}
.pick-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pick-main b,
.pick-main span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick-main span,
.pick-meta {
  font-size: 12px;
}
.pick-meta {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.pick:hover,
.pick:focus-visible {
  background: var(--surface-hover);
}
</style>
