<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import ShippingDocsModal from '../components/ShippingDocsModal.vue'
import { t } from '../i18n'
import { trashConfirmMessage } from '../lib/trash'
import {
  ORDER_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  formatMoneyMap,
  nextOrderStatus,
  orderSteps,
  parseAmount,
  todayIso,
} from '../lib/crm'
import { formatDate } from '../lib/labels'
import { formatMoney } from '../lib/quote'
import { can } from '../lib/session'
import { confirmDialog, errorText, toast, toastError } from '../stores/ui'

/** 订单：列表 + 详情（状态步骤、出运信息、收款记录、余额 / 逾期；契约 §10.8） */
const route = useRoute()
const router = useRouter()
const routeId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const canWrite = computed(() => can('data:write'))

/* ── 列表 ── */
const orders = ref<api.Order[]>([])
const summary = ref<api.ReceivablesSummary | null>(null)
const listLoading = ref(true)
const listError = ref('')
const filter = reactive({ q: '', status: 'all' })

async function loadList(): Promise<void> {
  listLoading.value = true
  listError.value = ''
  try {
    const query: Record<string, string> = {}
    if (filter.status === 'receivable') query.receivable = 'open'
    else if (filter.status === 'overdue') query.receivable = 'overdue'
    else query.status = filter.status
    const [list, rec] = await Promise.all([
      api.ordersApi.list({ ...query, limit: 500 }),
      api.ordersApi.receivables({ limit: 1 }),
    ])
    orders.value = list.items
    summary.value = rec.summary
  } catch (e) {
    listError.value = errorText(e)
  } finally {
    listLoading.value = false
  }
}
onMounted(loadList)
watch(() => filter.status, loadList)

const filtered = computed(() => {
  const q = filter.q.trim().toLowerCase()
  if (!q) return orders.value
  return orders.value.filter((o) => `${o.number} ${o.customerName} ${o.quoteNumber}`.toLowerCase().includes(q))
})

/* ── 详情 ── */
const current = ref<api.Order | null>(null)
const docsOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const ship = reactive<api.Shipment>({
  containerType: '',
  containerNo: '',
  blNo: '',
  vessel: '',
  portOfLoading: '',
  portOfDischarge: '',
  etd: '',
  eta: '',
})
const meta = reactive({ dueDate: '', depositAmount: '', paymentTerms: '', notes: '' })

function fillForms(o: api.Order): void {
  Object.assign(ship, o.shipment)
  meta.dueDate = o.dueDate || ''
  meta.depositAmount = o.depositAmount ? String(o.depositAmount) : ''
  meta.paymentTerms = o.paymentTerms || ''
  meta.notes = o.notes || ''
}

async function loadDetail(): Promise<void> {
  current.value = null
  if (!routeId.value) return
  detailLoading.value = true
  detailError.value = ''
  try {
    current.value = await api.ordersApi.get(routeId.value)
    fillForms(current.value)
  } catch (e) {
    detailError.value = errorText(e)
  } finally {
    detailLoading.value = false
  }
}
onMounted(loadDetail)
watch(routeId, loadDetail)

function applyOrder(o: api.Order): void {
  const payments = o.payments ?? current.value?.payments
  current.value = { ...o, payments }
  const i = orders.value.findIndex((x) => x.id === o.id)
  if (i >= 0) orders.value.splice(i, 1, o)
}

const steps = computed(() => (current.value ? orderSteps(current.value.status) : []))
const next = computed(() => (current.value ? nextOrderStatus(current.value.status) : null))
const busy = ref(false)

async function setStatus(status: api.OrderStatus): Promise<void> {
  if (!current.value) return
  if (status === 'cancelled') {
    const ok = await confirmDialog({
      title: t('crm.cancelOrderTitle', [current.value.number]),
      message: t('crm.cancelOrderMsg'),
      confirmText: t('crm.cancelOrder'),
      danger: true,
    })
    if (!ok) return
  }
  busy.value = true
  try {
    applyOrder(await api.ordersApi.update(current.value.id, { status }))
    toast.success(t('crm.orderStatusChanged', [ORDER_STATUS_LABEL[status]]))
    void loadList()
  } finally {
    busy.value = false
  }
}

const shipDirty = computed(() => {
  const o = current.value
  if (!o) return false
  return (Object.keys(ship) as (keyof api.Shipment)[]).some((k) => (ship[k] || '') !== (o.shipment[k] || ''))
})
const shipError = computed(() => (ship.etd && ship.eta && ship.eta < ship.etd ? t('crm.errEtaBeforeEtd') : ''))
async function saveShipment(): Promise<void> {
  if (!current.value || shipError.value) return
  busy.value = true
  try {
    applyOrder(await api.ordersApi.update(current.value.id, { ...ship }))
    toast.success(t('crm.shipmentSaved'))
  } finally {
    busy.value = false
  }
}

const metaDirty = computed(() => {
  const o = current.value
  if (!o) return false
  return (
    meta.dueDate !== (o.dueDate || '') ||
    meta.paymentTerms !== (o.paymentTerms || '') ||
    meta.notes !== (o.notes || '') ||
    parseAmount(meta.depositAmount || '0') !== (o.depositAmount || 0)
  )
})
async function saveMeta(): Promise<void> {
  if (!current.value) return
  const deposit = parseAmount(meta.depositAmount || '0')
  if (!Number.isFinite(deposit) || deposit < 0) {
    toast.error(t('crm.errAmount'))
    return
  }
  busy.value = true
  try {
    applyOrder(
      await api.ordersApi.update(current.value.id, {
        dueDate: meta.dueDate,
        depositAmount: deposit,
        paymentTerms: meta.paymentTerms,
        notes: meta.notes,
      }),
    )
    toast.success(t('crm.orderSaved'))
  } finally {
    busy.value = false
  }
}

async function removeOrder(): Promise<void> {
  if (!current.value) return
  const ok = await confirmDialog({
    title: t('crm.deleteOrderTitle', [current.value.number]),
    message: trashConfirmMessage('crm.deleteOrderMsg'),
    confirmText: t('crm.delete'),
    danger: true,
  })
  if (!ok) return
  await api.ordersApi.remove(current.value.id)
  toast.success(t('crm.orderDeleted'))
  orders.value = orders.value.filter((o) => o.id !== current.value?.id)
  await router.replace('/orders')
}

/* ── 收款 ── */
const payOpen = ref(false)
const pay = reactive({ amount: '', receivedAt: todayIso(), method: '', reference: '', notes: '' })
const payTried = ref(false)
const payError = computed(() => {
  const o = current.value
  const n = parseAmount(pay.amount)
  if (!Number.isFinite(n) || n <= 0) return t('crm.errPayAmount')
  if (o && n > o.balance + 1e-9) return t('crm.errPayExceeds', [formatMoney(o.balance, o.currency)])
  return ''
})
function openPay(): void {
  pay.amount = current.value ? String(current.value.balance) : ''
  pay.receivedAt = todayIso()
  pay.method = ''
  pay.reference = ''
  pay.notes = ''
  payTried.value = false
  payOpen.value = true
}
async function submitPay(): Promise<void> {
  payTried.value = true
  if (!current.value || payError.value) return
  busy.value = true
  try {
    const res = await api.ordersApi.addPayment(current.value.id, {
      amount: parseAmount(pay.amount),
      currency: current.value.currency,
      receivedAt: pay.receivedAt,
      method: pay.method.trim(),
      reference: pay.reference.trim(),
      notes: pay.notes.trim(),
    })
    applyOrder({ ...res.order, payments: [res.payment, ...(current.value.payments ?? [])] })
    payOpen.value = false
    toast.success(t('crm.paymentRecorded', [formatMoney(res.payment.amount, res.payment.currency)]))
    void loadList()
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = false
  }
}
async function removePayment(p: api.Payment): Promise<void> {
  if (!current.value) return
  const ok = await confirmDialog({
    title: t('crm.deletePaymentTitle'),
    message: t('crm.deletePaymentMsg', [formatMoney(p.amount, p.currency), p.receivedAt]),
    confirmText: t('crm.delete'),
    danger: true,
  })
  if (!ok) return
  await api.ordersApi.removePayment(current.value.id, p.id)
  current.value = await api.ordersApi.get(current.value.id)
  void loadList()
  toast.success(t('crm.paymentDeleted'))
}

const statusOptions = computed(() => [
  { v: 'all', l: t('crm.filterAll') },
  { v: 'open', l: t('crm.filterOpen') },
  { v: 'receivable', l: t('crm.filterReceivable') },
  { v: 'overdue', l: t('crm.filterOverdue') },
  ...(['pending_production', 'in_production', 'shipped', 'completed', 'cancelled'] as api.OrderStatus[]).map((s) => ({
    v: s,
    l: ORDER_STATUS_LABEL[s],
  })),
])
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('crm.orders')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('crm.orders') }}</h2>
      </div>
      <label class="side-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span class="sr-only">{{ $t('crm.searchOrders') }}</span>
        <input v-model="filter.q" :placeholder="$t('crm.searchOrdersPh')" spellcheck="false" />
      </label>
      <div class="status-filter">
        <select v-model="filter.status" class="select" :aria-label="$t('crm.filterStatus')" data-testid="order-filter">
          <option v-for="o in statusOptions" :key="o.v" :value="o.v">{{ o.l }}</option>
        </select>
      </div>
      <nav class="side-body">
        <StateBlock v-if="listLoading && !orders.length" state="loading" compact />
        <StateBlock v-else-if="listError" state="error" :message="listError" compact @retry="loadList" />
        <StateBlock
          v-else-if="!filtered.length"
          state="empty"
          :title="orders.length ? $t('crm.noMatch') : $t('crm.noOrders')"
          compact
        />
        <template v-else>
          <RouterLink
            v-for="o in filtered"
            :key="o.id"
            class="oitem"
            :class="{ on: o.id === routeId }"
            :to="`/orders/${o.id}`"
            data-testid="order-item"
          >
            <span class="on-row">
              <span class="on-num">{{ o.number }}</span>
              <span class="os" :class="{ bad: o.overdue }">{{
                o.overdue ? $t('crm.overdueDays', [o.overdueDays]) : ORDER_STATUS_LABEL[o.status]
              }}</span>
            </span>
            <span class="oc" :title="o.customerName">{{ o.customerName }}</span>
            <span class="oa">
              {{ formatMoney(o.amount, o.currency) }}
              <span v-if="o.balance > 0 && o.status !== 'cancelled'" class="ob">{{
                $t('crm.balanceShort', [formatMoney(o.balance, o.currency)])
              }}</span>
            </span>
          </RouterLink>
        </template>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('crm.orders')" :sub="orders.length ? $t('orderx.tbSub', [orders.length]) : ''" />

    <div class="doc">
      <div v-if="current && routeId && !detailLoading" class="profile">
        <div class="p-main">
          <div class="p-name">
            <h2>{{ current.number }}</h2>
            <span
              class="stage-pill"
              :class="{
                's-won': current.status === 'completed',
                's-quoted': current.status !== 'completed' && current.status !== 'cancelled',
                's-lost': current.status === 'cancelled',
              }"
              >{{ ORDER_STATUS_LABEL[current.status] }}</span
            >
          </div>
          <div class="p-meta">
            <RouterLink :to="`/customers/${current.customerId}`">{{ current.customerName }}</RouterLink>
            <template v-if="current.quoteId">
              <i></i
              ><RouterLink :to="`/quotation/${current.quoteId}`">{{
                $t('orderx.fromQuote', [current.quoteNumber || $t('crm.quote')])
              }}</RouterLink>
            </template>
            <template v-if="current.incoterm">
              <i></i><span>{{ current.incoterm }}</span>
            </template>
            <template v-if="current.paymentTerms">
              <i></i><span>{{ current.paymentTerms }}</span>
            </template>
          </div>
        </div>
        <div v-if="canWrite" class="p-actions">
          <button
            v-if="current.status !== 'cancelled' && current.status !== 'completed'"
            type="button"
            class="btn"
            :disabled="busy"
            @click="setStatus('cancelled')"
          >
            {{ $t('crm.cancelOrder') }}
          </button>
          <button
            v-perm="['data:write', 'order:delete']"
            type="button"
            class="btn danger"
            :disabled="busy"
            data-testid="order-delete"
            @click="removeOrder"
          >
            {{ $t('crm.delete') }}
          </button>
          <button
            v-if="next"
            type="button"
            class="btn dark"
            :disabled="busy"
            data-testid="order-advance"
            @click="setStatus(next)"
          >
            {{ $t('crm.advanceTo', [ORDER_STATUS_LABEL[next]]) }}
          </button>
        </div>
      </div>
      <template v-if="!routeId">
        <div class="page-greet">
          <div>
            <h2>{{ $t('orderx.overview') }}</h2>
            <p>{{ $t('orderx.overviewSub', [orders.length]) }}</p>
          </div>
        </div>
        <div v-if="summary" class="stat-row two" data-testid="receivables-summary">
          <div class="stat">
            <span class="k">{{ $t('crm.outstanding') }}</span>
            <span v-if="!formatMoneyMap(summary.outstandingByCurrency).length" class="v">—</span>
            <span v-for="m in formatMoneyMap(summary.outstandingByCurrency)" :key="m" class="v money">{{ m }}</span>
            <span class="s">{{ $t('crm.openOrders', [summary.openCount]) }}</span>
          </div>
          <div class="stat" :class="{ bad: summary.overdueCount > 0 }">
            <span class="k">{{ $t('crm.overdue') }}</span>
            <span v-if="!formatMoneyMap(summary.overdueByCurrency).length" class="v">—</span>
            <span v-for="m in formatMoneyMap(summary.overdueByCurrency)" :key="m" class="v money">{{ m }}</span>
            <span class="s">{{ $t('crm.overdueOrders', [summary.overdueCount]) }}</span>
          </div>
        </div>
        <StateBlock state="empty" :title="$t('crm.pickOrder')" :message="$t('crm.pickOrderMsg')">
          <RouterLink class="kbtn" to="/quotation">{{ $t('crm.goQuotes') }}</RouterLink>
        </StateBlock>
      </template>
      <StateBlock v-else-if="detailLoading" state="loading" />
      <StateBlock v-else-if="detailError" state="error" :message="detailError" @retry="loadDetail" />

      <div v-else-if="current" class="order">
        <!-- 状态步骤 -->
        <section class="panel">
          <div class="panel-body">
            <div v-if="current.status === 'cancelled'" class="cancelled" role="status">
              {{ $t('crm.orderIsCancelled') }}
            </div>
            <ol v-else class="steps" data-testid="order-steps">
              <li
                v-for="(s, i) in steps"
                :key="s.status"
                :class="s.state"
                :aria-current="s.state === 'current' ? 'step' : undefined"
              >
                <span class="dot">
                  <svg v-if="s.state === 'done'" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6 12.5 4 4 8-9" />
                  </svg>
                  <template v-else>{{ i + 1 }}</template>
                </span>
                <span class="lbl">{{ ORDER_STATUS_LABEL[s.status] }}</span>
              </li>
            </ol>
          </div>
        </section>

        <!-- 金额 -->
        <div class="stat-row four">
          <div class="stat">
            <span class="k">{{ $t('crm.orderAmount') }}</span>
            <span class="v money">{{ formatMoney(current.amount, current.currency) }}</span>
            <span class="s">{{ current.incoterm || '—' }}</span>
          </div>
          <div class="stat">
            <span class="k">{{ $t('crm.paid') }}</span>
            <span class="v money" data-testid="order-paid">{{ formatMoney(current.paid, current.currency) }}</span>
            <span class="s">{{ PAYMENT_STATUS_LABEL[current.paymentStatus] }}</span>
          </div>
          <div class="stat" :class="{ bad: current.overdue }">
            <span class="k">{{ $t('crm.balance') }}</span>
            <span class="v money" data-testid="order-balance">{{
              formatMoney(current.balance, current.currency)
            }}</span>
            <span class="s">{{
              current.overdue
                ? $t('crm.overdueDays', [current.overdueDays])
                : current.dueDate
                  ? $t('crm.dueOn', [formatDate(current.dueDate)])
                  : $t('crm.noDueDate')
            }}</span>
          </div>
          <div class="stat">
            <span class="k">{{ $t('crm.source') }}</span>
            <RouterLink
              v-if="current.quoteId"
              class="v money link-v"
              :title="current.quoteNumber || undefined"
              :to="`/quotation/${current.quoteId}`"
              >{{ current.quoteNumber || $t('crm.quote') }}</RouterLink
            >
            <span v-else class="v">—</span>
            <RouterLink class="s link-s" :to="`/customers/${current.customerId}`">{{
              current.customerName
            }}</RouterLink>
          </div>
        </div>

        <div class="two">
          <!-- 收款 -->
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('crm.payments') }}</h2>
              </div>
              <button
                v-if="canWrite && current.status !== 'cancelled' && current.balance > 0"
                type="button"
                class="kbtn sm primary"
                data-testid="record-payment"
                @click="openPay"
              >
                {{ $t('crm.recordPayment') }}
              </button>
            </div>
            <StateBlock v-if="!current.payments?.length" state="empty" :title="$t('crm.noPayments')" compact />
            <div v-else class="table-scroll">
              <table class="data-table" data-testid="payment-table">
                <thead>
                  <tr>
                    <th>{{ $t('crm.receivedAt') }}</th>
                    <th class="num">{{ $t('crm.amount') }}</th>
                    <th>{{ $t('crm.method') }}</th>
                    <th>{{ $t('crm.reference') }}</th>
                    <th v-if="canWrite">
                      <span class="sr-only">{{ $t('crm.actions') }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="p in current.payments" :key="p.id">
                    <td>{{ p.receivedAt }}</td>
                    <td class="num">{{ formatMoney(p.amount, p.currency) }}</td>
                    <td>{{ p.method || '—' }}</td>
                    <td class="ellipsis" :title="p.reference">{{ p.reference || '—' }}</td>
                    <td v-if="canWrite" class="act">
                      <button
                        v-perm="['data:write', 'order:delete']"
                        type="button"
                        class="link danger-link"
                        @click="removePayment(p)"
                      >
                        {{ $t('crm.delete') }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- 收款条件 -->
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('crm.terms') }}</h2>
              </div>
            </div>
            <form class="panel-body stack" @submit.prevent="saveMeta">
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">{{ $t('crm.depositAmount') }}</span>
                  <input v-model="meta.depositAmount" class="input" inputmode="decimal" :disabled="!canWrite" />
                </label>
                <label class="field">
                  <span class="field-label">{{ $t('crm.dueDate') }}</span>
                  <input v-model="meta.dueDate" class="input" type="date" :disabled="!canWrite" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">{{ $t('crm.paymentTerms') }}</span>
                <input v-model="meta.paymentTerms" class="input" maxlength="200" :disabled="!canWrite" />
              </label>
              <label class="field">
                <span class="field-label">{{ $t('crm.notes') }}</span>
                <textarea
                  v-model="meta.notes"
                  class="textarea"
                  rows="2"
                  maxlength="2000"
                  :disabled="!canWrite"
                ></textarea>
              </label>
              <div v-if="canWrite" class="form-actions">
                <button type="submit" class="kbtn" :disabled="busy || !metaDirty">{{ $t('crm.save') }}</button>
              </div>
            </form>
          </section>
        </div>

        <!-- 出运 -->
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('crm.shipment') }}</h2>
              <p class="panel-sub">{{ $t('crm.shipmentSub') }}</p>
            </div>
          </div>
          <form class="panel-body stack" data-testid="shipment-form" @submit.prevent="saveShipment">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">{{ $t('crm.containerType') }}</span>
                <select v-model="ship.containerType" class="select" name="containerType" :disabled="!canWrite">
                  <option v-for="c in api.CONTAINER_TYPES" :key="c" :value="c">{{ c || '—' }}</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">{{ $t('crm.containerNo') }}</span>
                <input
                  v-model="ship.containerNo"
                  class="input"
                  name="containerNo"
                  maxlength="40"
                  :disabled="!canWrite"
                />
              </label>
              <label class="field">
                <span class="field-label">{{ $t('crm.blNo') }}</span>
                <input v-model="ship.blNo" class="input" name="blNo" maxlength="60" :disabled="!canWrite" />
              </label>
              <label class="field">
                <span class="field-label">{{ $t('crm.vessel') }}</span>
                <input v-model="ship.vessel" class="input" name="vessel" maxlength="80" :disabled="!canWrite" />
              </label>
              <label class="field">
                <span class="field-label">{{ $t('crm.pol') }}</span>
                <input
                  v-model="ship.portOfLoading"
                  class="input"
                  name="portOfLoading"
                  maxlength="80"
                  :disabled="!canWrite"
                />
              </label>
              <label class="field">
                <span class="field-label">{{ $t('crm.pod') }}</span>
                <input
                  v-model="ship.portOfDischarge"
                  class="input"
                  name="portOfDischarge"
                  maxlength="80"
                  :disabled="!canWrite"
                />
              </label>
              <label class="field">
                <span class="field-label">ETD</span>
                <input v-model="ship.etd" class="input" type="date" name="etd" :disabled="!canWrite" />
              </label>
              <label class="field">
                <span class="field-label">ETA</span>
                <input v-model="ship.eta" class="input" type="date" name="eta" :disabled="!canWrite" />
                <span v-if="shipError" class="field-error">{{ shipError }}</span>
              </label>
            </div>
            <div v-if="canWrite" class="form-actions">
              <button type="submit" class="kbtn primary" :disabled="busy || !shipDirty || !!shipError">
                {{ $t('crm.saveShipment') }}
              </button>
            </div>
          </form>
        </section>

        <!-- 出货单证 -->
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('docs.panelTitle') }}</h2>
              <p class="panel-sub">{{ $t('docs.panelSub') }}</p>
            </div>
            <button type="button" class="kbtn sm primary" data-testid="open-docs" @click="docsOpen = true">
              {{ $t('docs.open') }}
            </button>
          </div>
        </section>
      </div>
    </div>

    <ShippingDocsModal
      v-if="docsOpen && current"
      :order-id="current.id"
      :can-write="canWrite"
      @close="docsOpen = false"
    />

    <UiModal
      v-if="payOpen && current"
      :title="$t('crm.recordPayment')"
      :subtitle="$t('crm.recordPaymentSub', [current.number, formatMoney(current.balance, current.currency)])"
      :width="460"
      @close="payOpen = false"
    >
      <form id="pay-form" class="stack" novalidate @submit.prevent="submitPay">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ $t('fmt.paren', [$t('crm.amount'), current.currency]) }}</span>
            <input v-model="pay.amount" class="input" name="amount" inputmode="decimal" autofocus />
            <span v-if="payTried && payError" class="field-error">{{ payError }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ $t('crm.receivedAt') }}</span>
            <input v-model="pay.receivedAt" class="input" type="date" name="receivedAt" />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('crm.method') }}</span>
            <input v-model="pay.method" class="input" name="method" maxlength="40" :placeholder="$t('crm.methodPh')" />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('crm.reference') }}</span>
            <input v-model="pay.reference" class="input" name="reference" maxlength="80" />
          </label>
        </div>
        <label class="field">
          <span class="field-label">{{ $t('crm.notes') }}</span>
          <input v-model="pay.notes" class="input" name="notes" maxlength="500" />
        </label>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="payOpen = false">{{ $t('crm.cancel') }}</button>
        <button type="submit" form="pay-form" class="kbtn primary" :disabled="busy">
          {{ $t('crm.recordPayment') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.profile {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 0 0 18px;
}
.p-main {
  flex: 1;
  min-width: 0;
}
.p-name {
  display: flex;
  align-items: center;
  gap: 10px;
}
.p-name h2 {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.p-meta {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  margin-top: 7px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  flex-wrap: wrap;
}
.p-meta a {
  color: inherit;
}
.p-meta a:hover {
  color: var(--text);
  text-decoration: underline;
}
.p-meta i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--switch-off);
}
.p-actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.btn.dark {
  border-color: var(--bubble-user);
  background: var(--bubble-user);
  color: var(--on-strong);
  font-weight: 600;
}
.btn.danger {
  color: var(--danger-text);
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.stat .link-v {
  margin-top: 7px;
}
.stat .link-s {
  margin-top: 8px;
}
.stat-row.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.status-filter {
  padding: 0 var(--space-4) var(--space-2);
}
.oitem {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
}
.oitem:hover {
  background: var(--surface-hover);
}
.oitem.on {
  background: var(--surface-active);
}
.on-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-sm);
  font-weight: 600;
}
.on-num {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.os {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}
.os.bad {
  color: var(--danger-text);
}
.oc {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oa {
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ob {
  /* 选中行是灰底，tertiary 只有 4.1:1 */
  color: var(--text-secondary);
}
.order {
  max-width: 1120px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.order > .panel,
.two > .panel {
  margin: 0;
}
.stat-row {
  grid-template-columns: repeat(2, minmax(0, 280px));
}
.stat-row.four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
}
.link-v,
.link-s {
  /* 来源卡里的报价号 / 客户链接：点击区域至少 24px 高 */
  align-self: flex-start;
  display: inline-block;
  padding-block: 3px;
  margin-block: -3px;
}
.link-v:hover,
.link-s:hover {
  text-decoration: underline;
}
.two {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
}
.steps li {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: var(--fs-sm);
  min-width: 0;
}
.steps li:not(:last-child)::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line-strong);
  margin: 0 8px;
  min-width: 12px;
}
.steps li.done:not(:last-child)::after {
  background: var(--good);
}
.steps .dot {
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--line-strong);
  background: var(--surface);
}
.steps li.done .dot {
  background: var(--good);
  border-color: var(--good);
  color: var(--surface);
}
.steps li.current {
  color: var(--text);
  font-weight: 600;
}
.steps li.current .dot {
  background: var(--text);
  border-color: var(--text);
  color: var(--on-strong);
}
.steps .dot svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.steps .lbl {
  white-space: nowrap;
}
.cancelled {
  padding: 4px 0;
  color: var(--danger-text);
  font-weight: 600;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ellipsis {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.act {
  text-align: right;
}
.danger-link {
  color: var(--danger-text);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 1180px) {
  .stat-row.four {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .two {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
