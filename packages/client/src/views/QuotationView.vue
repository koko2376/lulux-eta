<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import PermNote from '../components/ui/PermNote.vue'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import { downloadBlob } from '../lib/download'
import { QUOTE_STATUS_LABEL, formatDate } from '../lib/labels'
import { formatMoney, lineAmount, quoteSubtotal, totalQty, validateItems } from '../lib/quote'
import QuoteSheet from '../components/QuoteSheet.vue'
import PricingDialog from '../components/PricingDialog.vue'
import { confirmDialog, errorText, toast, toastError } from '../stores/ui'
import { todayIso } from '../lib/crm'
import { t } from '../i18n'
import { trashConfirmMessage } from '../lib/trash'
import { can } from '../lib/session'

const route = useRoute()
const router = useRouter()
const routeId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))

/* ── 列表 ── */
const quotes = ref<api.Quote[]>([])
const listLoading = ref(true)
const listError = ref('')
const filter = reactive({ q: '', status: '' })
const customers = ref<api.Customer[]>([])
const products = ref<api.Product[]>([])
const templates = ref<api.QuoteTemplate[]>([])

const customerName = (id: string) => customers.value.find((c) => c.id === id)?.company ?? t('quotation.k1c07rhc')
const isExpired = (q: Pick<api.Quote, 'status' | 'validUntil'>) =>
  (q.status === 'draft' || q.status === 'sent') && !!q.validUntil && q.validUntil < todayIso()
const matchStatus = (q: api.Quote, status: string) =>
  !status || (status === 'expired' ? isExpired(q) : q.status === status)
const statusCount = (status: string) => quotes.value.filter((q) => matchStatus(q, status)).length
const STATUS_NAV = computed(() => [
  { value: '', label: t('quox.all') },
  ...api.QUOTE_STATUSES.map((s) => ({ value: s as string, label: QUOTE_STATUS_LABEL[s] })),
  { value: 'expired', label: t('quox.expired') },
])
const filtered = computed(() =>
  quotes.value
    .filter(
      (q) =>
        matchStatus(q, filter.status) &&
        (!filter.q || `${q.number} ${customerName(q.customerId)}`.toLowerCase().includes(filter.q.toLowerCase())),
    )
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt), undefined, { numeric: true })),
)

async function loadList(): Promise<void> {
  listLoading.value = true
  listError.value = ''
  try {
    quotes.value = await api.listQuotes()
  } catch (error) {
    listError.value = errorText(error)
  } finally {
    listLoading.value = false
  }
}

async function loadRefs(): Promise<void> {
  const [c, p, t] = await Promise.allSettled([api.listAllCustomers(), api.listProducts(), api.listQuoteTemplates()])
  if (c.status === 'fulfilled') customers.value = c.value
  if (p.status === 'fulfilled') products.value = p.value
  if (t.status === 'fulfilled') templates.value = t.value
}

/* ── 编辑器 ── */
const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const blankItem = (): api.QuoteItem => ({ productId: null, name: '', spec: '', qty: 1, unit: 'pcs', unitPrice: 0 })

function blankQuote(): api.QuoteInput {
  const tpl = templates.value.find((t) => t.isDefault) ?? templates.value[0]
  return {
    customerId: typeof route.query.customer === 'string' ? route.query.customer : '',
    currency: tpl?.defaultCurrency || 'USD',
    incoterm: tpl?.defaultIncoterm || 'FOB',
    port: '',
    validUntil: plusDays(30),
    paymentTerms: tpl?.defaultPaymentTerms || '',
    leadTime: '',
    items: [blankItem()],
    notes: tpl?.footer || '',
    status: 'draft',
  }
}

const current = ref<api.Quote | null>(null)
const form = reactive<api.QuoteInput>(blankQuote())
const editorLoading = ref(false)
const editorError = ref('')
const customerMissing = ref(false)
const saving = ref(false)
const dirty = ref(false)
const isNew = computed(() => routeId.value === 'new')
/** 选中报价默认展示“成品文档”，编辑是一个切换 */
const editing = ref(false)
const showEditor = computed(() => isNew.value || editing.value)

async function openEditor(): Promise<void> {
  editorError.value = ''
  dirty.value = false
  editing.value = false
  if (!routeId.value) {
    current.value = null
    return
  }
  if (isNew.value) {
    current.value = null
    Object.assign(form, blankQuote())
    dirty.value = false
    return
  }
  editorLoading.value = true
  try {
    const q = await api.getQuote(routeId.value)
    current.value = q
    Object.assign(form, {
      customerId: q.customerId,
      currency: q.currency,
      incoterm: q.incoterm,
      port: q.port,
      validUntil: q.validUntil,
      paymentTerms: q.paymentTerms,
      leadTime: q.leadTime,
      items: q.items.map((i) => ({ ...i })),
      notes: q.notes,
      status: q.status,
    })
    setTimeout(() => (dirty.value = false))
  } catch (error) {
    editorError.value = errorText(error)
  } finally {
    editorLoading.value = false
  }
}

watch(form, () => (dirty.value = true), { deep: true })
watch(routeId, openEditor)

/* ── 转为订单（契约 §10.8 POST /api/quotes/:id/order） ── */
const linkedOrder = ref<api.Order | null>(null)
async function findLinkedOrder(): Promise<void> {
  linkedOrder.value = null
  const q = current.value
  if (!q) return
  try {
    const list = await api.ordersApi.list({ status: 'all', customerId: q.customerId, limit: 500 })
    if (current.value?.id === q.id) linkedOrder.value = list.items.find((o) => o.quoteId === q.id) ?? null
  } catch {
    /* 没有订单权限或旧服务端：按钮照常显示，提交时再报错 */
  }
}
watch(() => current.value?.id, findLinkedOrder)

const orderOpen = ref(false)
const orderForm = reactive({ depositAmount: '', dueDate: '', notes: '' })
const ordering = ref(false)
function openOrder(): void {
  orderForm.depositAmount = ''
  orderForm.dueDate = ''
  orderForm.notes = ''
  orderOpen.value = true
}
async function submitOrder(): Promise<void> {
  const q = current.value
  if (!q) return
  if (dirty.value) {
    toast.error(t('quotation.saveBeforeOrder'))
    return
  }
  const deposit = orderForm.depositAmount.trim() ? Number(orderForm.depositAmount.replace(/[,\s]/g, '')) : 0
  if (!Number.isFinite(deposit) || deposit < 0 || deposit > q.subtotal) {
    toast.error(t('quotation.depositInvalid'))
    return
  }
  ordering.value = true
  try {
    const order = await api.ordersApi.fromQuote(
      q.id,
      {
        depositAmount: deposit || undefined,
        dueDate: orderForm.dueDate || undefined,
        notes: orderForm.notes.trim() || undefined,
      },
      true,
    )
    orderOpen.value = false
    toast.success(t('quotation.orderCreated', [order.number]))
    await router.push(`/orders/${order.id}`)
  } catch (error) {
    if (error instanceof api.ApiError && error.code === 'ORDER_EXISTS') {
      orderOpen.value = false
      await findLinkedOrder()
    }
    toastError(error)
  } finally {
    ordering.value = false
  }
}
const minDue = todayIso()
onMounted(async () => {
  await Promise.all([loadList(), loadRefs()])
  await openEditor()
})

const subtotal = computed(() => quoteSubtotal(form.items, form.currency))
const qtySum = computed(() => totalQty(form.items))
const issues = computed(() => validateItems(form.items))

function pickProduct(item: api.QuoteItem, productId: string): void {
  const p = products.value.find((x) => x.id === productId)
  item.productId = p?.id ?? null
  if (!p) return
  item.name = p.name
  item.spec = p.spec
  item.unit = p.unit || item.unit
  item.unitPrice = p.price
  if (p.currency && p.currency !== form.currency) toast.info(t('quotation.kqlw12k', [p.currency, form.currency]))
  if (p.moq && item.qty < p.moq) item.qty = p.moq
}

async function save(): Promise<void> {
  editorError.value = ''
  customerMissing.value = !form.customerId
  if (customerMissing.value) {
    void nextTick(() => document.querySelector<HTMLElement>('#quote-editor [data-field="customer"]')?.focus())
    return
  }
  const cleanItems = form.items.filter((i) => i.name.trim() || i.unitPrice)
  if (!cleanItems.length) return void (editorError.value = t('quotation.k168yklq'))
  const problems = validateItems(cleanItems)
  if (problems.length) return void (editorError.value = problems.map((p) => p.message).join(t('fmt.clauseSep')))
  const payload: api.QuoteInput = {
    ...form,
    items: cleanItems.map((i) => ({ ...i, qty: Number(i.qty), unitPrice: Number(i.unitPrice) })),
  }
  saving.value = true
  try {
    if (current.value) {
      current.value = await api.updateQuote(current.value.id, payload)
      toast.success(t('quotation.k1l5gy27'))
      editing.value = false
    } else {
      const created = await api.createQuote(payload)
      toast.success(t('quotation.k1fq70e6', [created.number]))
      await loadList()
      await router.replace(`/quotation/${created.id}`)
      return
    }
    dirty.value = false
    await loadList()
  } catch (error) {
    editorError.value = errorText(error)
  } finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  if (!current.value) return
  if (
    !(await confirmDialog({
      title: t('quotation.k8t1ghu', [current.value.number]),
      message: trashConfirmMessage('quotation.deleteMsg'),
      confirmText: t('quotation.kfcqesv'),
      danger: true,
    }))
  )
    return
  await api.deleteQuote(current.value.id)
  toast.success(t('quotation.k1xqwrmq'))
  await loadList()
  await router.replace('/quotation')
}

/* ── 文档视图 + 右栏（核价提示 / 报价信息 / 导出与发送） ── */
const currentCustomer = computed(() =>
  current.value ? (customers.value.find((c) => c.id === current.value?.customerId) ?? null) : null,
)
const template = computed(() => templates.value.find((x) => x.isDefault) ?? templates.value[0] ?? null)
const customerEmail = computed(() => {
  const c = currentCustomer.value
  const contact = c?.contacts.find((x) => x.isPrimary && x.email) ?? c?.contacts.find((x) => x.email)
  return contact ? { name: contact.name, address: contact.email } : null
})

interface Check {
  level: 'warn' | 'ok' | 'info'
  text: string
}
/** 确定性核价检查：只用真实数据（产品库价格 / 起订量 / 币种、缺失字段、有效期、联系人邮箱） */
const checks = computed<Check[]>(() => {
  const q = current.value
  if (!q) return []
  const out: Check[] = []
  const below: number[] = []
  const underMoq: number[] = []
  const otherCurrency = new Set<string>()
  q.items.forEach((item, i) => {
    const p = item.productId ? products.value.find((x) => x.id === item.productId) : null
    if (!p) return
    if (p.currency && p.currency !== q.currency) otherCurrency.add(p.currency)
    else if (p.price > 0 && item.unitPrice < p.price) below.push(i + 1)
    if (p.moq && item.qty < p.moq) underMoq.push(i + 1)
  })
  if (below.length) out.push({ level: 'warn', text: t('quox.chkBelowList', [below.join(t('fmt.listSep'))]) })
  if (underMoq.length) out.push({ level: 'warn', text: t('quox.chkMoq', [underMoq.join(t('fmt.listSep'))]) })
  if (otherCurrency.size)
    out.push({ level: 'warn', text: t('quox.chkCurrency', [[...otherCurrency].join('/'), q.currency]) })
  const missing = [
    !q.port && t('quotation.k1h3nz1c'),
    !q.paymentTerms && t('quotation.ks34jb'),
    !q.leadTime && t('quotation.kf4ncr7'),
    !q.validUntil && t('quotation.kfik5j4'),
  ].filter(Boolean) as string[]
  if (missing.length) out.push({ level: 'warn', text: t('quox.chkMissing', [missing.join(t('fmt.listSep'))]) })
  if (q.items.some((i) => !i.spec.trim())) out.push({ level: 'info', text: t('quox.chkNoSpec') })
  if (q.validUntil) {
    const days = Math.round((new Date(q.validUntil).getTime() - new Date(todayIso()).getTime()) / 86400000)
    if (days < 0 && q.status !== 'accepted') out.push({ level: 'warn', text: t('quox.chkExpired', [q.validUntil]) })
    else if (days <= 7 && q.status !== 'accepted') out.push({ level: 'info', text: t('quox.chkExpiring', [days]) })
  }
  if (!customerEmail.value) out.push({ level: 'info', text: t('quox.chkNoEmail') })
  if (!out.some((c) => c.level === 'warn')) out.unshift({ level: 'ok', text: t('quox.chkOk', [q.items.length]) })
  return out
})

function askLulux(): void {
  const q = current.value
  if (!q) return
  void router.push({
    path: '/agent',
    query: {
      prompt: t('quox.auditPrompt', [q.number]),
      quote: q.id,
      ...(q.customerId ? { customer: q.customerId } : {}),
    },
  })
}

const pricingOpen = ref(false)
function applyPricing(payload: { unitPrices: number[]; incoterm: api.PricingIncoterm }): void {
  payload.unitPrices.forEach((price, i) => {
    const item = form.items[i]
    if (item) item.unitPrice = price
  })
  form.incoterm = payload.incoterm
  pricingOpen.value = false
  toast.success(t('pricing.applied'))
}

const exporting = ref(false)
async function exportPdf(): Promise<void> {
  const q = current.value
  if (!q) return
  exporting.value = true
  try {
    downloadBlob(await api.quotePdf(q.id), `${q.number}.pdf`)
  } catch (error) {
    toastError(error)
  } finally {
    exporting.value = false
  }
}
function exportCsv(): void {
  const q = current.value
  if (!q) return
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = [
    [
      '#',
      t('quotation.k1726lpq').replace(' *', ''),
      t('quotation.kn7w4bl'),
      t('quotation.k1fiq1pt'),
      t('quotation.k13m8dl3'),
      t('quotation.k340tg1'),
      t('quotation.kel73uo'),
    ],
    ...q.items.map((i, n) => [n + 1, i.name, i.spec, i.qty, i.unit, i.unitPrice, lineAmount(i, q.currency)]),
    ['', '', '', totalQty(q.items), '', q.currency, q.subtotal],
  ]
  const csv = '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${q.number}.csv`)
}

const mailing = ref(false)
/** 邮件发送给客户：建一封带报价 PDF 的草稿，到邮箱里确认后再发 */
async function sendByMail(): Promise<void> {
  const q = current.value
  if (!q) return
  mailing.value = true
  try {
    const accounts = await api.listEmailAccounts()
    const acc = accounts[0]
    if (!acc) {
      toast.error(t('quox.noMailAccount'))
      await router.push('/settings/mailbox')
      return
    }
    const draft = await api.createEmailDraft({
      accountId: acc.id,
      customerId: q.customerId || null,
      quoteId: q.id,
      to: customerEmail.value ? [customerEmail.value] : [],
      subject: `Quotation ${q.number}`,
      attachQuotePdf: true,
    })
    await router.push({ path: '/mailbox', query: { draft: draft.id } })
  } catch (error) {
    toastError(error)
  } finally {
    mailing.value = false
  }
}
async function markSent(): Promise<void> {
  const q = current.value
  if (!q || q.status === 'sent') return
  try {
    current.value = await api.updateQuote(q.id, { status: 'sent' })
    form.status = 'sent'
    setTimeout(() => (dirty.value = false))
    toast.success(t('quox.markedSent'))
    await loadList()
  } catch (error) {
    toastError(error)
  }
}

/* ── 预览 / 打印 ── */
const previewHtml = ref('')
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const frame = ref<HTMLIFrameElement | null>(null)

async function openPreview(): Promise<void> {
  if (!current.value) return
  if (dirty.value) {
    const ok = await confirmDialog({
      title: t('quotation.k1cw4874'),
      message: t('quotation.k1dp4oq8'),
      confirmText: t('quotation.kv6dmu3'),
    })
    if (!ok) return
    await save()
    if (dirty.value) return
  }
  previewOpen.value = true
  previewLoading.value = true
  previewError.value = ''
  try {
    previewHtml.value = await api.quoteHtml(current.value.id)
  } catch (error) {
    previewError.value = errorText(error)
  } finally {
    previewLoading.value = false
  }
}

function printPreview(): void {
  const win = frame.value?.contentWindow
  if (!win) return
  win.focus()
  win.print()
}

function downloadHtml(): void {
  if (!current.value) return
  downloadBlob(new Blob([previewHtml.value], { type: 'text/html' }), `${current.value.number}.html`)
}
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('quotation.kyl66oz')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('quox.sideTitle') }}</h2>
        <RouterLink class="link" to="/quotation/new">{{ $t('quotation.k3ke49o') }}</RouterLink>
      </div>
      <label class="side-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span class="sr-only">{{ $t('quotation.kg3oht7') }}</span>
        <input v-model="filter.q" :placeholder="$t('quox.searchPh')" spellcheck="false" />
      </label>
      <nav class="side-body">
        <div role="group" :aria-label="$t('quotation.k1yj2bn5')">
          <button
            v-for="s in STATUS_NAV"
            :key="s.value"
            type="button"
            class="nav-row"
            :class="{ on: filter.status === s.value }"
            :aria-pressed="filter.status === s.value"
            @click="filter.status = s.value"
          >
            {{ s.label }}<span class="count">{{ statusCount(s.value) }}</span>
          </button>
        </div>
        <div class="side-label">{{ filter.status || filter.q ? $t('quox.results') : $t('quox.recent') }}</div>
        <StateBlock v-if="listLoading" state="loading" compact />
        <StateBlock v-else-if="listError" state="error" :message="listError" compact @retry="loadList" />
        <StateBlock
          v-else-if="!filtered.length"
          state="empty"
          :title="quotes.length ? $t('quotation.knroj05') : $t('quotation.k1rif8gv')"
          compact
        />
        <template v-else>
          <RouterLink
            v-for="q in filtered"
            :key="q.id"
            class="nav-row qitem"
            :class="{ on: q.id === routeId }"
            :to="`/quotation/${q.id}`"
            :title="`${q.number} · ${QUOTE_STATUS_LABEL[q.status]} · ${formatMoney(q.subtotal, q.currency)}`"
          >
            <span class="qn">{{ q.number.split('-').pop() }}</span>
            <span class="qc">{{ customerName(q.customerId) }}</span>
            <span class="qa sr-only">{{ formatMoney(q.subtotal, q.currency) }}</span>
          </RouterLink>
        </template>
        <div class="side-label">{{ $t('crm.related') }}</div>
        <RouterLink class="nav-row" to="/products" data-testid="quote-products-link"
          >{{ $t('products.title') }}<span class="count">{{ products.length }}</span></RouterLink
        >
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar
      :title="isNew ? $t('quotation.k1o6w1ye') : current ? current.number : $t('quotation.kxbx0dt')"
      :sub="
        current
          ? `${customerName(current.customerId)} · ${QUOTE_STATUS_LABEL[current.status]}${isExpired(current) ? ` · ${$t('quox.expired')}` : ''}`
          : ''
      "
    >
      <template v-if="routeId">
        <span v-if="dirty && showEditor" class="unsaved">{{ $t('quotation.ki2o3ju') }}</span>
        <template v-if="current && !showEditor">
          <RouterLink v-if="linkedOrder" class="kbtn" :to="`/orders/${linkedOrder.id}`" data-testid="view-order">{{
            $t('quotation.viewOrder', [linkedOrder.number])
          }}</RouterLink>
          <button
            v-else-if="current.status !== 'rejected'"
            v-perm="'data:write'"
            type="button"
            class="kbtn"
            data-testid="convert-order"
            @click="openOrder"
          >
            {{ $t('quotation.toOrder') }}
          </button>
          <button
            v-perm="'data:write'"
            type="button"
            class="kbtn primary"
            data-testid="quote-edit"
            @click="editing = true"
          >
            {{ $t('quox.edit') }}
          </button>
        </template>
        <template v-else>
          <button v-if="current" type="button" class="kbtn" :disabled="saving" @click="openEditor">
            {{ $t('quox.cancelEdit') }}
          </button>
          <button
            v-if="current"
            v-perm="['data:write', 'quote:delete']"
            type="button"
            class="kbtn danger"
            data-testid="quote-delete"
            @click="remove"
          >
            {{ $t('quotation.kfcqesv') }}
          </button>
          <button
            v-perm="'data:write'"
            type="button"
            class="kbtn primary"
            :disabled="saving || editorLoading"
            @click="save"
          >
            {{ saving ? $t('quotation.ksdjf4x') : $t('quotation.k1xlvxln') }}
          </button>
        </template>
      </template>
      <RouterLink v-else class="kbtn primary" to="/quotation/new">{{ $t('quotation.k1o6w1ye') }}</RouterLink>
    </PageTopbar>

    <div class="doc">
      <PermNote perm="data:write" :text="$t('quotation.k7k8fyx')" />
      <StateBlock v-if="!routeId" state="empty" :title="$t('quotation.k1ihp9zq')" :message="$t('quotation.koik1la')">
        <RouterLink class="kbtn primary" to="/quotation/new">{{ $t('quotation.k1o6w1ye') }}</RouterLink>
      </StateBlock>
      <StateBlock v-else-if="editorLoading" state="loading" />
      <StateBlock
        v-else-if="editorError && !isNew && !current"
        state="error"
        :message="editorError"
        @retry="openEditor"
      />

      <div v-else-if="current && !showEditor" class="quote-cols">
        <QuoteSheet :quote="current" :customer="currentCustomer" :template="template" :products="products" />

        <div class="qstack">
          <section class="card ai-card" data-testid="quote-audit">
            <div class="qc-head">
              <span class="qc-title">{{ $t('quox.auditTitle') }}</span>
            </div>
            <ul class="checks">
              <li v-for="(c, i) in checks" :key="i" :class="c.level">
                <span class="dot" aria-hidden="true"></span>{{ c.text }}
              </li>
            </ul>
            <p class="ai-foot">{{ $t('quox.noCost') }}</p>
            <div class="ai-actions">
              <button type="button" class="expbtn sm" data-testid="quote-ask-lulux" @click="askLulux">
                {{ $t('quox.askLulux') }}
              </button>
              <button v-perm="'data:write'" type="button" class="expbtn sm" @click="editing = true">
                {{ $t('quox.edit') }}
              </button>
            </div>
          </section>

          <section class="card">
            <div class="qc-head">
              <span class="qc-title">{{ $t('quox.infoTitle') }}</span>
            </div>
            <div class="meta-list">
              <div class="meta-row">
                <span class="k">{{ $t('quotation.krfzxye') }}</span
                ><span class="v strong">{{ QUOTE_STATUS_LABEL[current.status] }}</span>
              </div>
              <div class="meta-row">
                <span class="k">{{ $t('quox.customer') }}</span>
                <RouterLink v-if="current.customerId" class="v u-hover" :to="`/customers/${current.customerId}`">{{
                  customerName(current.customerId)
                }}</RouterLink>
              </div>
              <div class="meta-row">
                <span class="k">{{ $t('quotation.k1an5azl') }}</span
                ><span class="v">{{ current.currency }}</span>
              </div>
              <div class="meta-row">
                <span class="k">{{ $t('quotation.kysbjhu') }}</span
                ><span class="v">{{ [current.incoterm, current.port].filter(Boolean).join(' ') || '—' }}</span>
              </div>
              <div class="meta-row">
                <span class="k">{{ $t('quox.payShort') }}</span
                ><span class="v">{{ current.paymentTerms || '—' }}</span>
              </div>
              <div class="meta-row">
                <span class="k">{{ $t('quotation.kfik5j4') }}</span
                ><span class="v">{{ current.validUntil || '—' }}</span>
              </div>
              <div class="meta-row">
                <span class="k">{{ $t('quox.updated') }}</span
                ><span class="v">{{ formatDate(current.updatedAt) }}</span>
              </div>
              <div v-if="linkedOrder" class="meta-row">
                <span class="k">{{ $t('quox.order') }}</span>
                <RouterLink class="v u-hover" :to="`/orders/${linkedOrder.id}`">{{ linkedOrder.number }}</RouterLink>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="qc-head">
              <span class="qc-title">{{ $t('quox.exportTitle') }}</span>
            </div>
            <div class="export">
              <button
                type="button"
                class="expbtn primary"
                :disabled="exporting"
                data-testid="quote-pdf"
                @click="exportPdf"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3.8v10.4" />
                  <path d="m7.6 10.4 4.4 4.4 4.4-4.4" />
                  <path d="M4.5 18.2v1.4a1.6 1.6 0 0 0 1.6 1.6h11.8a1.6 1.6 0 0 0 1.6-1.6v-1.4" />
                </svg>
                {{ exporting ? $t('quox.exporting') : $t('quox.exportPdf') }}
                <span class="sub">{{ $t('quox.pdfSub') }}</span>
              </button>
              <button type="button" class="expbtn" @click="openPreview">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.8 12s3.3-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.3 6.2-9.2 6.2S2.8 12 2.8 12z" />
                  <circle cx="12" cy="12" r="2.6" />
                </svg>
                {{ $t('quotation.kh29z2r') }}
                <span class="sub">{{ $t('quox.previewSub') }}</span>
              </button>
              <button type="button" class="expbtn" @click="exportCsv">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 3.5H7.2A2.2 2.2 0 0 0 5 5.7v12.6a2.2 2.2 0 0 0 2.2 2.2h9.6a2.2 2.2 0 0 0 2.2-2.2V8.5z" />
                  <path d="M14 3.5v5h5" />
                </svg>
                {{ $t('quox.exportCsv') }}
                <span class="sub">{{ $t('quox.csvSub') }}</span>
              </button>
              <button v-perm="'data:write'" type="button" class="expbtn" :disabled="mailing" @click="sendByMail">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="5.2" width="18" height="13.6" rx="2.4" />
                  <path d="m3.8 7 7.3 5.3a1.5 1.5 0 0 0 1.8 0L20.2 7" />
                </svg>
                {{ $t('quox.sendMail') }}
              </button>
              <button
                v-perm="'data:write'"
                type="button"
                class="expbtn"
                :disabled="current.status !== 'draft'"
                @click="markSent"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8.5 12.5 12 16l8-8.4" />
                  <path d="M20 12v6.4A1.6 1.6 0 0 1 18.4 20H5.6A1.6 1.6 0 0 1 4 18.4V5.6A1.6 1.6 0 0 1 5.6 4H14" />
                </svg>
                {{ $t('quox.markSent') }}
              </button>
            </div>
          </section>
        </div>
      </div>

      <form v-else id="quote-editor" class="editor" novalidate @submit.prevent="save">
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('quotation.k1d5d91v') }}</h2>
            </div>
          </div>
          <div class="panel-body form-grid">
            <label class="field span-2">
              <span class="field-label">{{ $t('quotation.k1dlechr') }}</span>
              <select
                v-model="form.customerId"
                class="select"
                :class="{ invalid: customerMissing }"
                data-field="customer"
                required
                @change="customerMissing = false"
              >
                <option value="" disabled>{{ $t('quotation.kdcse20') }}</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">
                  {{ c.company }}{{ c.country ? ` · ${c.country}` : '' }}
                </option>
              </select>
              <span v-if="customerMissing" class="field-error" role="alert">{{ $t('quotation.ktxc7h2') }}</span>
              <span v-if="!customers.length" class="field-hint"
                >{{ $t('quotation.k1h45645')
                }}<RouterLink to="/customers?new=1" class="u">{{ $t('quotation.k8sx6wf') }}</RouterLink
                >{{ $t('fmt.period') }}</span
              >
            </label>
            <label class="field"
              ><span class="field-label">{{ $t('quotation.krfzxye') }}</span>
              <select v-model="form.status" class="select">
                <option v-for="s in api.QUOTE_STATUSES" :key="s" :value="s">{{ QUOTE_STATUS_LABEL[s] }}</option>
              </select>
            </label>
            <label class="field"
              ><span class="field-label">{{ $t('quotation.k1an5azl') }}</span>
              <select v-model="form.currency" class="select">
                <option v-for="c in api.CURRENCIES" :key="c">{{ c }}</option>
              </select>
            </label>
            <label class="field"
              ><span class="field-label">{{ $t('quotation.kysbjhu') }}</span>
              <select v-model="form.incoterm" class="select">
                <option v-for="it in api.INCOTERMS" :key="it">{{ it }}</option>
              </select>
            </label>
            <label class="field"
              ><span class="field-label">{{ $t('quotation.k1h3nz1c') }}</span
              ><input v-model="form.port" class="input" placeholder="Ningbo / Shanghai"
            /></label>
            <label class="field"
              ><span class="field-label">{{ $t('quotation.kfik5j4') }}</span
              ><input v-model="form.validUntil" class="input" type="date" :min="today()"
            /></label>
            <label class="field"
              ><span class="field-label">{{ $t('quotation.kf4ncr7') }}</span
              ><input v-model="form.leadTime" class="input" placeholder="30 days after deposit"
            /></label>
            <label class="field span-all"
              ><span class="field-label">{{ $t('quotation.ks34jb') }}</span
              ><input v-model="form.paymentTerms" class="input" placeholder="30% T/T deposit, 70% against B/L copy"
            /></label>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('quotation.k14n6zs3') }}</h2>
              <div class="panel-sub">{{ $t('quotation.k1dwg2i9', [form.currency]) }}</div>
            </div>
            <RouterLink class="kbtn ghost" to="/products" data-testid="quote-manage-products">{{
              $t('products.manage')
            }}</RouterLink>
            <button type="button" class="kbtn" data-testid="quote-pricing" @click="pricingOpen = true">
              {{ $t('pricing.open') }}
            </button>
            <button type="button" class="kbtn" @click="form.items.push(blankItem())">
              {{ $t('quotation.k6qyv7o') }}
            </button>
          </div>
          <p v-if="!products.length" class="prod-empty" data-testid="quote-products-empty">
            {{ $t('products.quoteEmpty') }}
            <RouterLink v-if="can('catalog:write')" to="/products">{{ $t('products.quoteEmptyAction') }}</RouterLink>
          </p>
          <div class="items-scroll" data-hscroll-ok>
            <table class="data-table items">
              <thead>
                <tr>
                  <th class="c-idx">#</th>
                  <th v-if="products.length" class="c-prod">{{ $t('quotation.kagbr5a') }}</th>
                  <th>{{ $t('quotation.k1726lpq') }}</th>
                  <th>{{ $t('quotation.kn7w4bl') }}</th>
                  <th class="c-qty">{{ $t('quotation.k1fiq1pt') }}</th>
                  <th class="c-unit">{{ $t('quotation.k13m8dl3') }}</th>
                  <th class="c-price">{{ $t('quotation.k340tg1') }}</th>
                  <th class="c-amt num">{{ $t('quotation.kel73uo') }}</th>
                  <th class="c-x">
                    <span class="sr-only">{{ $t('quotation.k1voemgk') }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(item, i) in form.items" :key="i" :class="{ bad: issues.some((x) => x.index === i) }">
                  <td class="dim">{{ i + 1 }}</td>
                  <td v-if="products.length">
                    <select
                      class="select"
                      :value="item.productId ?? ''"
                      :aria-label="$t('quotation.kv0iexs', [i + 1])"
                      @change="pickProduct(item, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">{{ $t('quotation.k115xvxb') }}</option>
                      <option v-for="p in products" :key="p.id" :value="p.id">
                        {{ p.sku ? `${p.sku} ` : '' }}{{ p.name }}
                      </option>
                    </select>
                  </td>
                  <td><input v-model="item.name" class="input" :aria-label="$t('quotation.k18rk40c', [i + 1])" /></td>
                  <td><input v-model="item.spec" class="input" :aria-label="$t('quotation.kgzk9w4', [i + 1])" /></td>
                  <td>
                    <input
                      v-model.number="item.qty"
                      class="input num-in"
                      type="number"
                      min="0"
                      step="any"
                      :aria-label="$t('quotation.kkwuc35', [i + 1])"
                    />
                  </td>
                  <td><input v-model="item.unit" class="input" :aria-label="$t('quotation.k1uz29mi', [i + 1])" /></td>
                  <td>
                    <input
                      v-model.number="item.unitPrice"
                      class="input num-in"
                      type="number"
                      min="0"
                      step="any"
                      :aria-label="$t('quotation.k1eekt9r', [i + 1])"
                    />
                  </td>
                  <td class="num">{{ formatMoney(lineAmount(item, form.currency), form.currency) }}</td>
                  <td>
                    <button
                      type="button"
                      class="kbtn sm ghost"
                      :disabled="form.items.length === 1"
                      :aria-label="$t('quotation.k110mutn', [i + 1])"
                      @click="form.items.splice(i, 1)"
                    >
                      {{ $t('quotation.kfcqesv') }}
                    </button>
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td :colspan="products.length ? 4 : 3" class="dim">
                    {{ $t('quotation.k19r7qqr', [form.items.length]) }}
                  </td>
                  <td class="num">{{ qtySum }}</td>
                  <td colspan="2" class="num dim">{{ $t('quotation.k1u0zp0v', [form.incoterm, form.port]) }}</td>
                  <td class="num total">{{ formatMoney(subtotal, form.currency) }}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section class="panel">
          <div class="panel-body">
            <label class="field"
              ><span class="field-label">{{ $t('quotation.k38yy31') }}</span
              ><textarea v-model="form.notes" class="textarea" rows="3"></textarea>
            </label>
          </div>
        </section>
        <p v-if="editorError" class="field-error" role="alert">{{ editorError }}</p>
      </form>
    </div>

    <PricingDialog
      v-if="pricingOpen"
      :items="form.items"
      :currency="form.currency"
      :incoterm="form.incoterm"
      :port="form.port"
      @close="pricingOpen = false"
      @apply="applyPricing"
    />
    <UiModal
      v-if="previewOpen"
      :title="$t('quotation.kdeigov', [current?.number ?? ''])"
      :subtitle="$t('quotation.k1h91piz')"
      :width="900"
      @close="previewOpen = false"
    >
      <StateBlock v-if="previewLoading" state="loading" compact />
      <StateBlock v-else-if="previewError" state="error" :message="previewError" compact @retry="openPreview" />
      <iframe
        v-else
        ref="frame"
        class="preview-frame"
        :srcdoc="previewHtml"
        sandbox="allow-same-origin allow-modals"
        :title="$t('quotation.kpbvvh9')"
      ></iframe>
      <template #footer>
        <button type="button" class="kbtn" :disabled="!previewHtml" @click="downloadHtml">
          {{ $t('quotation.kpwdyx8') }}
        </button>
        <button type="button" class="kbtn primary" :disabled="!previewHtml || previewLoading" @click="printPreview">
          {{ $t('quotation.k6bmjfc') }}
        </button>
      </template>
    </UiModal>
    <UiModal
      v-if="orderOpen && current"
      :title="$t('quotation.toOrderTitle', [current.number])"
      :subtitle="$t('quotation.toOrderSub', [formatMoney(current.subtotal, current.currency)])"
      :width="460"
      @close="orderOpen = false"
    >
      <form id="order-form" class="stack" @submit.prevent="submitOrder">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ $t('fmt.paren', [$t('quotation.deposit'), current.currency]) }}</span>
            <input
              v-model="orderForm.depositAmount"
              class="input"
              name="depositAmount"
              inputmode="decimal"
              placeholder="0"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('quotation.balanceDue') }}</span>
            <input v-model="orderForm.dueDate" class="input" type="date" name="dueDate" :min="minDue" />
          </label>
        </div>
        <label class="field">
          <span class="field-label">{{ $t('quotation.orderNotes') }}</span>
          <textarea v-model="orderForm.notes" class="textarea" name="notes" rows="2" maxlength="2000"></textarea>
        </label>
        <p class="field-hint">{{ $t('quotation.toOrderHint') }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="orderOpen = false">{{ $t('crm.cancel') }}</button>
        <button type="submit" form="order-form" class="kbtn primary" :disabled="ordering">
          {{ ordering ? $t('quotation.creatingOrder') : $t('quotation.toOrder') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.prod-empty {
  margin: 0 0 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--info-soft);
  color: var(--info-text);
  font-size: 12.5px;
}
.prod-empty a {
  color: inherit;
  font-weight: 500;
  margin-left: 6px;
}
.unsaved {
  font-size: 12px;
  color: var(--text-secondary);
}
.editor {
  max-width: 1120px;
}
.items-scroll {
  /* 表头里的 .sr-only 是 absolute：没有定位祖先时会以页面为准撑出整页横向滚动（1024 宽下 1190px） */
  position: relative;
  overflow-x: auto;
}
.items {
  min-width: 860px;
}
.items td {
  padding: 6px 8px;
}
.items .input,
.items .select {
  height: 32px;
}
.c-idx {
  width: 34px;
}
.c-prod {
  width: 120px;
}
.c-qty {
  width: 92px;
}
.c-unit {
  width: 72px;
}
.c-price {
  width: 100px;
}
.c-amt {
  width: 124px;
}
.c-x {
  width: 52px;
}
.num-in {
  text-align: right;
}
.items tr.bad td {
  background: var(--danger-soft);
}
tfoot td {
  padding: 12px 8px !important;
  border-top: 1px solid var(--line);
  font-size: 13px;
}
.total {
  font-weight: 700;
  font-size: 14px !important;
}
.u {
  text-decoration: underline;
}
.preview-frame {
  width: 100%;
  height: min(70vh, 900px);
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}
/* ── 文档视图 + 右栏 ── */
.quote-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 14px;
  align-items: start;
  max-width: 1240px;
}
.qstack {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.ai-card {
  background: var(--surface-soft);
}
.qc-head {
  padding: 16px 18px 4px;
}
.qc-title {
  font-size: 13.5px;
  font-weight: 600;
}
.checks {
  list-style: none;
  margin: 0;
  padding: 6px 18px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-secondary);
}
.checks li {
  display: flex;
  gap: 8px;
}
.checks .dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-top: 8px;
  background: var(--text-tertiary);
}
.checks .warn {
  color: var(--text);
}
.checks .warn .dot {
  background: var(--warn-text);
}
.checks .ok .dot {
  background: var(--good);
}
.ai-foot {
  margin: 8px 18px 0;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.ai-actions {
  display: flex;
  gap: 7px;
  padding: 12px 18px 16px;
}
.meta-list {
  padding: 8px 18px 16px;
}
.meta-row {
  display: flex;
  align-items: center;
  padding: 9px 0;
  border-top: 1px solid var(--surface-muted);
  font-size: 12.5px;
  min-width: 0;
}
.meta-row:first-child {
  border-top: 0;
}
.meta-row .k {
  color: var(--text-tertiary);
  width: 84px;
  flex: none;
}
.meta-row .v {
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-row .v.strong {
  color: var(--text);
  font-weight: 500;
}
.u-hover:hover {
  text-decoration: underline;
}
.export {
  padding: 14px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.expbtn {
  height: 38px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 13px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}
.expbtn:hover:not(:disabled) {
  background: var(--surface-hover);
}
.expbtn:disabled {
  opacity: 0.5;
  cursor: default;
}
.expbtn.sm {
  height: 30px;
  padding: 0 11px;
  font-size: 12px;
}
.expbtn svg {
  width: 16px;
  height: 16px;
  flex: none;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.expbtn.primary {
  background: var(--text);
  border-color: var(--text);
  color: var(--on-strong);
  font-weight: 500;
}
.expbtn.primary:hover:not(:disabled) {
  background: var(--text);
  opacity: 0.9;
}
.expbtn .sub {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-tertiary);
}
.expbtn.primary .sub {
  color: color-mix(in srgb, var(--on-strong) 60%, transparent);
}
.side-body [role='group'] .nav-row {
  width: 100%;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
}
.side-body [role='group'] .nav-row.on {
  background: var(--surface-active);
}
.qitem {
  gap: 8px;
}
.qitem .qn {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  flex: none;
}
.qitem.on .qn {
  color: var(--text-secondary);
}
.qitem .qc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qitem .qa {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  flex: none;
}
@media (max-width: 1180px) {
  .quote-cols {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
