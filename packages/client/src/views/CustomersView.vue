<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import PermNote from '../components/ui/PermNote.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import CustomerFormModal from '../components/CustomerFormModal.vue'
import FollowUpModal from '../components/FollowUpModal.vue'
import InitialBadge from '../components/ui/InitialBadge.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiPager from '../components/ui/UiPager.vue'
import { dueLabel } from '../lib/due'
import { STAGE_LABEL, relativeTime } from '../lib/labels'
import { forgetCustomer } from '../lib/recent-customers'
import { can } from '../lib/session'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { downloadBlob, stamp } from '../lib/download'
import { labelled, t } from '../i18n'
import { trashConfirmMessage } from '../lib/trash'
import { toCssRect } from '../lib/ui-zoom'
import { localTimeFor } from '../lib/country-time'
import { scopedKey } from '../lib/storage-scope'

/**
 * 客户列表：列表 / 看板切换、计数行、勾选列、最近跟进 / 下次跟进（逾期红色）、负责人、行菜单、分页；
 * 侧栏 阶段 / 国家 / 负责人 / 标签 筛选，全部来自真实接口。
 */
type Row = api.Customer & api.CustomerFollowUp
const route = useRoute()
const router = useRouter()
const PAGE_SIZES = [20, 50, 100] as const
const qs = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')

const query = ref(qs('q'))
const stage = ref(qs('stage'))
const tag = ref(qs('tag'))
const country = ref(qs('country'))
const owner = ref(qs('owner'))
const mode = ref<'list' | 'board'>(qs('view') === 'board' ? 'board' : 'list')
const page = ref(Number(route.query.page) || 1)
/* ── 视图偏好（按账号 + 服务器保存在本机）：每页条数、可选列 ── */
type OptCol = 'contact' | 'localTime' | 'tags' | 'source'
interface ViewPrefs {
  pageSize: (typeof PAGE_SIZES)[number]
  cols: Record<OptCol, boolean>
}
const DEFAULT_PREFS: ViewPrefs = {
  pageSize: 50,
  cols: { contact: true, localTime: true, tags: true, source: false },
}
const prefsKey = scopedKey('lulux.customersView')
function readPrefs(): ViewPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(prefsKey) ?? 'null') as Partial<ViewPrefs> | null
    if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_PREFS)
    return {
      pageSize: PAGE_SIZES.includes(raw.pageSize as never) ? (raw.pageSize as ViewPrefs['pageSize']) : DEFAULT_PREFS.pageSize,
      cols: { ...DEFAULT_PREFS.cols, ...(raw.cols && typeof raw.cols === 'object' ? raw.cols : {}) },
    }
  } catch {
    return structuredClone(DEFAULT_PREFS)
  }
}
const prefs = ref<ViewPrefs>(readPrefs())
watch(prefs, (v) => {
  try {
    localStorage.setItem(prefsKey, JSON.stringify(v))
  } catch {
    /* 存储满或被禁用：只影响下次打开的默认值 */
  }
}, { deep: true })
const OPT_COLS: OptCol[] = ['contact', 'localTime', 'tags', 'source']
const pageSize = computed(() => prefs.value.pageSize)
/** 表格可用宽度：窄窗口按优先级自动收起可选列（来源 → 标签 → 当地时间 → 主联系人），不出横向滚动 */
const wrapEl = ref<HTMLElement | null>(null)
const wrapWidth = ref(0)
let resizeObs: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return
  resizeObs = new ResizeObserver((entries) => (wrapWidth.value = entries[0]?.contentRect.width ?? 0))
  if (wrapEl.value) resizeObs.observe(wrapEl.value)
})
watch(wrapEl, (el, prev) => {
  if (prev) resizeObs?.unobserve(prev)
  if (el) resizeObs?.observe(el)
})
onBeforeUnmount(() => resizeObs?.disconnect())
const COL_WIDTH: Record<OptCol, number> = { contact: 190, localTime: 76, tags: 120, source: 96 }
/** 固定列（勾选、国家、阶段、最近 / 下次跟进、负责人、操作）+ 公司名最小宽度 */
const BASE_WIDTH = 40 + 64 + 78 + 84 + 104 + 84 + 40 + 220
const autoHidden = computed<Set<OptCol>>(() => {
  const hidden = new Set<OptCol>()
  if (!wrapWidth.value) return hidden
  const wanted = OPT_COLS.filter((c) => prefs.value.cols[c])
  let width = BASE_WIDTH + wanted.reduce((n, c) => n + COL_WIDTH[c], 0)
  for (const c of ['source', 'tags', 'localTime', 'contact'] as OptCol[]) {
    if (width <= wrapWidth.value) break
    if (!wanted.includes(c)) continue
    hidden.add(c)
    width -= COL_WIDTH[c]
  }
  return hidden
})
const showCol = (c: OptCol) => prefs.value.cols[c] && !autoHidden.value.has(c)

/* ── 排序（服务端稳定排序） ── */
const SORTS = ['updatedAt', 'createdAt', 'company'] as const
type SortKey = (typeof SORTS)[number]
const sort = ref<SortKey>((SORTS as readonly string[]).includes(qs('sort')) ? (qs('sort') as SortKey) : 'updatedAt')
const order = computed<'asc' | 'desc'>(() => (sort.value === 'company' ? 'asc' : 'desc'))

/* ── 当地时间每分钟刷新一次 ── */
const now = ref(Date.now())
let clock = 0
onMounted(() => {
  clock = window.setInterval(() => (now.value = Date.now()), 60_000)
})
onBeforeUnmount(() => window.clearInterval(clock))
const localTime = (c: Row) => localTimeFor(c.country, now.value)

const items = ref<Row[]>([])
const total = ref(0)
const loading = ref(true)
const loadError = ref('')
const stageCounts = ref<Partial<Record<api.Stage, number>>>({})
const facets = ref<api.CustomerFacets | null>(null)
let seq = 0

const filtered = computed(() => !!(query.value.trim() || stage.value || tag.value || country.value || owner.value))
const filters = () => ({
  query: query.value.trim(),
  stage: stage.value,
  tag: tag.value,
  country: country.value || undefined,
  ownerId: owner.value || undefined,
})

const exporting = ref(false)
async function exportCsv(): Promise<void> {
  exporting.value = true
  try {
    const blob = await api.exportCustomersCsv(filters())
    downloadBlob(blob, `customers-${stamp()}.csv`)
    toast.success(t('customers.exported'))
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    exporting.value = false
  }
}

async function load(): Promise<void> {
  if (mode.value === 'board') return loadBoard()
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.listCustomers({ ...filters(), sort: sort.value, order: order.value, page: page.value, pageSize: pageSize.value })
    if (mine !== seq) return
    items.value = res.items
    total.value = res.total
    selected.value = new Set([...selected.value].filter((id) => res.items.some((c) => c.id === id)))
    if (!res.items.length && page.value > 1 && res.total > 0) {
      page.value = Math.max(1, Math.ceil(res.total / pageSize.value))
    }
  } catch (error) {
    if (mine === seq) loadError.value = errorText(error)
  } finally {
    if (mine === seq) loading.value = false
  }
}

async function loadCounts(): Promise<void> {
  const [s, f] = await Promise.allSettled([api.getWorkbenchSummary(), api.getCustomerFacets()])
  if (s.status === 'fulfilled') stageCounts.value = s.value.customers.byStage
  if (f.status === 'fulfilled') facets.value = f.value
}

/* ── 看板：每个阶段一列（各取前 50 个） ── */
const board = ref<Record<string, { items: Row[]; total: number }>>({})
async function loadBoard(): Promise<void> {
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const stages = stage.value ? [stage.value as api.Stage] : [...api.STAGES]
    const res = await Promise.all(stages.map((s) => api.listCustomers({ ...filters(), stage: s, pageSize: 50 })))
    if (mine !== seq) return
    const next: Record<string, { items: Row[]; total: number }> = {}
    stages.forEach((s, i) => (next[s] = res[i]))
    board.value = next
    total.value = res.reduce((n, r) => n + r.total, 0)
  } catch (error) {
    if (mine === seq) loadError.value = errorText(error)
  } finally {
    if (mine === seq) loading.value = false
  }
}
const dragId = ref('')
const dropStage = ref('')
async function dropTo(target: api.Stage): Promise<void> {
  const id = dragId.value
  dragId.value = ''
  dropStage.value = ''
  if (!id || !can('data:write')) return
  const from = Object.entries(board.value).find(([, col]) => col.items.some((c) => c.id === id))
  if (!from || from[0] === target) return
  try {
    await api.updateCustomer(id, { stage: target })
    toast.success(t('custx.stageMoved', [STAGE_LABEL[target]]))
    void loadBoard()
    void loadCounts()
  } catch (error) {
    toast.error(errorText(error))
  }
}

function syncUrl(): void {
  const q: Record<string, string> = {}
  if (query.value.trim()) q.q = query.value.trim()
  if (stage.value) q.stage = stage.value
  if (tag.value) q.tag = tag.value
  if (country.value) q.country = country.value
  if (owner.value) q.owner = owner.value
  if (mode.value === 'board') q.view = 'board'
  if (sort.value !== 'updatedAt') q.sort = sort.value
  if (page.value > 1 && mode.value === 'list') q.page = String(page.value)
  void router.replace({ query: q })
}

let debounce = 0
watch(query, () => {
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => {
    page.value = 1
    syncUrl()
    void load()
  }, 250)
})
watch([stage, tag, country, owner, mode, sort, pageSize], () => {
  page.value = 1
  syncUrl()
  void load()
})
watch(page, () => {
  syncUrl()
  void load()
})
onBeforeUnmount(() => window.clearTimeout(debounce))

/** 同一个页面里被外部跳转（全局搜索「在客户列表中搜索」、工作台阶段条）改了查询参数：同步到筛选 */
watch(
  () => route.query,
  () => {
    if (qs('q') !== query.value.trim()) query.value = qs('q')
    if (qs('stage') !== stage.value) stage.value = qs('stage')
    if (qs('tag') !== tag.value) tag.value = qs('tag')
    if (qs('country') !== country.value) country.value = qs('country')
    if (qs('owner') !== owner.value) owner.value = qs('owner')
    const m = qs('view') === 'board' ? 'board' : 'list'
    if (m !== mode.value) mode.value = m
    if (route.query.new === '1') showCreate.value = true
  },
)

onMounted(() => {
  void load()
  void loadCounts()
  if (route.query.new === '1') showCreate.value = true
})

const showCreate = ref(false)

function clearFilters(includeQuery: boolean): void {
  stage.value = ''
  tag.value = ''
  country.value = ''
  owner.value = ''
  if (includeQuery) query.value = ''
}
async function onCreated(customer: api.Customer): Promise<void> {
  showCreate.value = false
  toast.success(t('customers.k1fq70e6', [customer.company]))
  await router.push(`/customers/${customer.id}`)
}

const primary = (c: api.Customer) => c.contacts.find((x) => x.isPrimary) ?? c.contacts[0]
const heading = computed(() =>
  stage.value
    ? STAGE_LABEL[stage.value as api.Stage]
    : tag.value
      ? t('customers.k1qbut2v', [tag.value])
      : country.value
        ? country.value
        : owner.value
          ? (facets.value?.owners.find((o) => o.id === owner.value)?.name ?? t('customers.k1jk3qup'))
          : t('customers.k1jk3qup'),
)
const countLine = computed(() => {
  if (filtered.value) return t('custx.countFiltered', [total.value])
  const f = facets.value
  return f ? t('custx.countLine', [f.total, f.newThisMonth]) : t('custx.countOnly', [total.value])
})
function open(c: api.Customer): void {
  void router.push(`/customers/${c.id}`)
}

/* ── 勾选 + 批量操作 ── */
const selected = ref<Set<string>>(new Set())
const allChecked = computed(() => items.value.length > 0 && items.value.every((c) => selected.value.has(c.id)))
function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function toggleAll(): void {
  allMatching.value = false
  selected.value = allChecked.value ? new Set() : new Set(items.value.map((c) => c.id))
}
/** 选中“全部筛选结果”（跨页，由服务端按同一组筛选条件取，上限 2000） */
const allMatching = ref(false)
const BATCH_ALL_LIMIT = 2000
const selCount = computed(() => (allMatching.value ? total.value : selected.value.size))
function clearSelection(): void {
  allMatching.value = false
  selected.value = new Set()
}
watch([query, stage, tag, country, owner], () => (allMatching.value = false))
function batchTarget(): Pick<api.CustomerBatchRequest, 'scope' | 'ids' | 'filters'> {
  return allMatching.value
    ? { scope: 'all', filters: filters() }
    : { scope: 'page', ids: [...selected.value] }
}
const nameOf = (id: string) => items.value.find((c) => c.id === id)?.company ?? id
/** 服务端批量：成功数 + 逐项失败原因；失败的客户保持勾选，方便处理后重试 */
async function runBatch(
  req: Omit<api.CustomerBatchRequest, 'scope' | 'ids' | 'filters'>,
  okMsg: (n: number) => string,
): Promise<boolean> {
  bulkBusy.value = true
  try {
    const res = await api.batchCustomers({ ...req, ...batchTarget() })
    if (!res.failed.length) toast.success(okMsg(res.succeeded))
    else
      toast.error(
        t('custx.batchPartial', [
          res.succeeded,
          res.failed.length,
          res.failed
            .slice(0, 5)
            .map((f) => labelled(nameOf(f.id), f.message))
            .join(t('fmt.clauseSep')),
        ]),
      )
    if (req.action === 'delete') for (const id of selected.value) if (!res.failed.some((f) => f.id === id)) forgetCustomer(id)
    allMatching.value = false
    selected.value = new Set(res.failed.map((f) => f.id).filter((id) => items.value.some((c) => c.id === id)))
    void load()
    void loadCounts()
    return true
  } catch (error) {
    toast.error(errorText(error))
    return false
  } finally {
    bulkBusy.value = false
  }
}
const bulkTagText = ref('')
async function bulkTag(action: 'addTag' | 'removeTag'): Promise<void> {
  const tagName = bulkTagText.value.trim()
  if (!tagName) return
  const ok = await runBatch({ action, params: { tag: tagName } }, (n) =>
    t(action === 'addTag' ? 'custx.bulkTagged' : 'custx.bulkUntagged', [n, tagName]),
  )
  if (ok) bulkTagText.value = ''
}
async function bulkAssign(event: Event): Promise<void> {
  const el = event.target as HTMLSelectElement
  const ownerId = el.value
  el.value = ''
  if (!ownerId || !selCount.value) return
  const name = facets.value?.owners.find((o) => o.id === ownerId)?.name ?? ownerId
  await runBatch({ action: 'assign', params: { ownerId } }, (n) => t('custx.bulkAssigned', [n, name]))
}
const bulkBusy = ref(false)
async function bulkStage(event: Event): Promise<void> {
  const el = event.target as HTMLSelectElement
  const next = el.value as api.Stage
  el.value = ''
  if (!next || !selCount.value) return
  await runBatch({ action: 'stage', params: { stage: next } }, (n) => t('custx.bulkStaged', [n, STAGE_LABEL[next]]))
}
async function bulkDelete(): Promise<void> {
  const n = selCount.value
  if (!n) return
  const ok = await confirmDialog({
    title: t('custx.bulkDeleteTitle', [n]),
    message: trashConfirmMessage('custx.bulkDeleteMsg'),
    confirmText: t('custx.delete'),
    danger: true,
  })
  if (!ok) return
  await runBatch({ action: 'delete' }, (done) => t('custx.bulkDeleted', [done]))
}

/* ── 行菜单 ··· ── */
const menuFor = ref('')
const menuPos = ref({ top: 0, left: 0 })
function openMenu(c: Row, event: MouseEvent): void {
  if (menuFor.value === c.id) {
    menuFor.value = ''
    return
  }
  // 界面缩放时 rect 是视觉像素，行菜单（position: fixed）的 top / left 是 CSS 像素
  const r = toCssRect((event.currentTarget as HTMLElement).getBoundingClientRect())
  menuPos.value = { top: r.bottom + 4, left: Math.max(8, r.right - 180) }
  menuFor.value = c.id
}
function closeMenu(): void {
  menuFor.value = ''
}
function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest('.row-menu, .row-act')) closeMenu()
}
onMounted(() => document.addEventListener('mousedown', onDocClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))
const menuRow = computed(() => items.value.find((c) => c.id === menuFor.value) ?? null)
const followFor = ref<Row | null>(null)
function menuFollow(): void {
  followFor.value = menuRow.value
  closeMenu()
}
async function menuDelete(): Promise<void> {
  const c = menuRow.value
  closeMenu()
  if (!c) return
  const ok = await confirmDialog({
    title: t('custx.deleteTitle', [c.company]),
    message: trashConfirmMessage('custx.deleteMsg'),
    confirmText: t('custx.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await api.deleteCustomer(c.id, { silent: true })
    forgetCustomer(c.id)
    toast.success(t('custx.deleted', [c.company]))
    void load()
    void loadCounts()
  } catch (error) {
    toast.error(errorText(error))
  }
}
const lastTouch = (c: Row) => (c.lastTouchAt ? relativeTime(c.lastTouchAt) : '—')
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('customers.kfxx4p3')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('customers.k1v5iwp2') }}</h2>
        <button v-perm="'data:write'" type="button" class="link" @click="showCreate = true">
          {{ $t('customers.k3ke49o') }}
        </button>
      </div>
      <label class="side-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span class="sr-only">{{ $t('customers.kf31amz') }}</span>
        <input v-model="query" type="search" :placeholder="$t('customers.kf31amz')" spellcheck="false" />
      </label>
      <nav class="side-body">
        <button
          type="button"
          class="nav-row"
          :class="{ on: !stage && !tag && !country && !owner }"
          @click="clearFilters(false)"
        >
          {{ $t('customers.k1jk3qup') }}<span v-if="facets" class="count">{{ facets.total }}</span>
        </button>
        <div class="side-label">{{ $t('customers.kl9iz6y') }}</div>
        <button
          v-for="s in api.STAGES"
          :key="s"
          type="button"
          class="nav-row sub"
          :class="{ on: stage === s }"
          :aria-pressed="stage === s"
          @click="stage = stage === s ? '' : s"
        >
          {{ STAGE_LABEL[s] }}<span class="count">{{ stageCounts[s] ?? 0 }}</span>
        </button>
        <template v-if="facets?.countries.length">
          <div class="side-label">{{ $t('custx.country') }}</div>
          <button
            v-for="c in facets.countries.slice(0, 6)"
            :key="c.value"
            type="button"
            class="nav-row sub"
            :class="{ on: country.toLowerCase() === c.value.toLowerCase() }"
            :aria-pressed="country.toLowerCase() === c.value.toLowerCase()"
            @click="country = country.toLowerCase() === c.value.toLowerCase() ? '' : c.value"
          >
            <span class="nav-ellipsis">{{ c.value }}</span
            ><span class="count">{{ c.count }}</span>
          </button>
        </template>
        <template v-if="facets?.owners.length">
          <div class="side-label">{{ $t('custx.owner') }}</div>
          <button
            v-for="o in facets.owners.slice(0, 8)"
            :key="o.id"
            type="button"
            class="nav-row sub"
            :class="{ on: owner === o.id }"
            :aria-pressed="owner === o.id"
            @click="owner = owner === o.id ? '' : o.id"
          >
            <span class="nav-ellipsis">{{ o.name || o.id }}</span
            ><span class="count">{{ o.count }}</span>
          </button>
        </template>
        <template v-if="facets?.tags.length || tag">
          <div class="side-label">{{ $t('customers.k1cag2ke') }}</div>
          <div class="tag-chips">
            <button
              v-for="it in facets?.tags.slice(0, 12) ?? []"
              :key="it.value"
              type="button"
              class="chip"
              :class="{ on: tag.toLowerCase() === it.value.toLowerCase() }"
              :aria-pressed="tag.toLowerCase() === it.value.toLowerCase()"
              @click="tag = tag.toLowerCase() === it.value.toLowerCase() ? '' : it.value"
            >
              {{ it.value }}
            </button>
            <button
              v-if="tag && !facets?.tags.some((x) => x.value.toLowerCase() === tag.toLowerCase())"
              type="button"
              class="chip on"
              @click="tag = ''"
            >
              {{ tag }}
            </button>
          </div>
        </template>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('customers.k1v5iwp2')" :sub="facets ? $t('custx.tbSub', [facets.total]) : ''" />

    <div class="doc">
      <PermNote perm="data:write" :text="$t('customers.k1yfgt48')" />
      <div class="head-row">
        <div>
          <h2 class="page-h">{{ heading }}</h2>
          <div class="head-count">{{ loading && !items.length && !facets ? '' : countLine }}</div>
        </div>
        <div class="head-actions">
          <div class="segmented" role="tablist" :aria-label="$t('custx.viewLabel')">
            <button
              type="button"
              role="tab"
              :aria-selected="mode === 'list'"
              :class="{ on: mode === 'list' }"
              @click="mode = 'list'"
            >
              {{ $t('custx.list') }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="mode === 'board'"
              :class="{ on: mode === 'board' }"
              @click="mode = 'board'"
            >
              {{ $t('custx.board') }}
            </button>
          </div>
          <button
            v-perm="'data:export'"
            type="button"
            class="btn"
            :disabled="exporting || !total"
            data-testid="customers-export"
            @click="exportCsv"
          >
            {{ exporting ? $t('customers.exporting') : $t('customers.exportCsv') }}
          </button>
          <RouterLink v-perm:hide="['data:write', 'customer:import']" class="btn" to="/customers/import">{{
            $t('customers.k14fjh9e')
          }}</RouterLink>
          <button v-perm="'data:write'" type="button" class="btn dark" @click="showCreate = true">
            {{ $t('customers.kr9abat') }}
          </button>
        </div>
      </div>

      <div v-if="filtered" class="filter-line">
        <span v-if="query.trim()" class="tag">{{ $t('custx.fQuery', [query.trim()]) }}</span>
        <span v-if="stage" class="tag">{{ STAGE_LABEL[stage as api.Stage] }}</span>
        <span v-if="country" class="tag">{{ country }}</span>
        <span v-if="owner" class="tag">{{ facets?.owners.find((o) => o.id === owner)?.name ?? owner }}</span>
        <span v-if="tag" class="tag">{{ tag }}</span>
        <button type="button" class="link" @click="clearFilters(true)">{{ $t('customers.kl0i1y7') }}</button>
      </div>

      <StateBlock v-if="loading && !items.length && mode === 'list'" state="loading" />
      <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />

      <!-- 看板 -->
      <div v-else-if="mode === 'board'" class="kanban" :class="{ 'is-loading': loading }" data-testid="customers-board">
        <section
          v-for="(col, s) in board"
          :key="s"
          class="kcol"
          :class="{ drop: dropStage === s }"
          @dragover.prevent="dropStage = String(s)"
          @dragleave="dropStage = ''"
          @drop.prevent="dropTo(s as api.Stage)"
        >
          <header class="kcol-head">
            <span class="kdot" :class="`s-${s}`"></span>{{ STAGE_LABEL[s as api.Stage]
            }}<span class="count">{{ col.total }}</span>
          </header>
          <p v-if="!col.items.length" class="kempty">{{ $t('custx.boardEmpty') }}</p>
          <RouterLink
            v-for="c in col.items"
            :key="c.id"
            class="kcard"
            :to="`/customers/${c.id}`"
            :draggable="can('data:write')"
            @dragstart="dragId = c.id"
            @dragend="dragId = ''"
          >
            <div class="kcard-top">
              <InitialBadge :name="c.company" :size="28" />
              <b>{{ c.company }}</b>
            </div>
            <div class="kcard-meta">
              {{ [c.country, primary(c)?.name].filter(Boolean).join(' · ') || '—' }}
            </div>
            <div v-if="c.nextTask" class="kcard-due" :class="dueLabel(c.nextTask.dueAt).cls">
              {{ dueLabel(c.nextTask.dueAt).text }} · {{ c.nextTask.title }}
            </div>
          </RouterLink>
          <p v-if="col.total > col.items.length" class="kempty">
            {{ $t('custx.boardMore', [col.total - col.items.length]) }}
          </p>
        </section>
      </div>

      <StateBlock
        v-else-if="!items.length"
        state="empty"
        :title="filtered ? $t('customers.k575bpo') : $t('customers.kigilbx')"
        :message="filtered ? $t('customers.ki6fvlo') : $t('customers.k1vrxdin')"
      >
        <template v-if="filtered">
          <button type="button" class="kbtn" @click="clearFilters(true)">{{ $t('customers.kl0i1y7') }}</button>
        </template>
        <template v-else>
          <button v-perm="'data:write'" type="button" class="kbtn primary" @click="showCreate = true">
            {{ $t('customers.kr9abat') }}
          </button>
          <RouterLink v-perm:hide="['data:write', 'customer:import']" class="kbtn" to="/customers/import">{{
            $t('customers.k14fjh9e')
          }}</RouterLink>
        </template>
      </StateBlock>

      <!-- 列表 -->
      <div v-else ref="wrapEl" class="table-wrap" :class="{ 'is-loading': loading }">
        <div class="list-tools" data-testid="customers-tools">
          <label class="tool">
            <span class="tool-l">{{ $t('custx.sortBy') }}</span>
            <select v-model="sort" class="select sm" data-testid="customers-sort">
              <option value="updatedAt">{{ $t('custx.sortUpdated') }}</option>
              <option value="createdAt">{{ $t('custx.sortCreated') }}</option>
              <option value="company">{{ $t('custx.sortCompany') }}</option>
            </select>
          </label>
          <details class="cols-pop">
            <summary class="btn sm">{{ $t('custx.columns') }}</summary>
            <div class="cols-menu" role="group" :aria-label="$t('custx.columns')">
              <label v-for="col in OPT_COLS" :key="col">
                <input v-model="prefs.cols[col]" type="checkbox" class="cb" />
                <span>{{ $t(`custx.col_${col}`) }}</span>
              </label>
              <p v-if="autoHidden.size" class="cols-hint">{{ $t('custx.autoHidden') }}</p>
            </div>
          </details>
          <div class="tb-spacer"></div>
          <label class="tool">
            <span class="tool-l">{{ $t('custx.perPage') }}</span>
            <select v-model.number="prefs.pageSize" class="select sm" data-testid="customers-page-size">
              <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
            </select>
          </label>
        </div>
        <div v-if="selected.size || allMatching" class="bulk-bar" data-testid="customers-bulk">
          <b>{{ $t('custx.selected', [selCount]) }}</b>
          <button
            v-if="allChecked && !allMatching && total > items.length"
            type="button"
            class="link"
            data-testid="customers-select-all-matching"
            :disabled="total > BATCH_ALL_LIMIT"
            :title="total > BATCH_ALL_LIMIT ? $t('custx.allTooMany', [BATCH_ALL_LIMIT]) : undefined"
            @click="allMatching = true"
          >
            {{ $t('custx.selectAllMatching', [total]) }}
          </button>
          <template v-if="can('data:write')">
            <select class="select sm" :disabled="bulkBusy" :aria-label="$t('custx.bulkStage')" @change="bulkStage">
              <option value="">{{ $t('custx.bulkStage') }}</option>
              <option v-for="s in api.STAGES" :key="s" :value="s">{{ STAGE_LABEL[s] }}</option>
            </select>
            <select
              v-if="(facets?.owners.length ?? 0) > 1"
              class="select sm"
              :disabled="bulkBusy"
              :aria-label="$t('custx.bulkAssign')"
              @change="bulkAssign"
            >
              <option value="">{{ $t('custx.bulkAssign') }}</option>
              <option v-for="o in facets?.owners ?? []" :key="o.id" :value="o.id">{{ o.name || o.id }}</option>
            </select>
            <span class="bulk-tag">
              <input
                v-model="bulkTagText"
                class="input sm"
                maxlength="50"
                :placeholder="$t('custx.tagPh')"
                :aria-label="$t('custx.tagPh')"
                data-testid="customers-bulk-tag"
                @keydown.enter.prevent="bulkTag('addTag')"
              />
              <button type="button" class="kbtn sm" :disabled="bulkBusy || !bulkTagText.trim()" @click="bulkTag('addTag')">
                {{ $t('custx.addTag') }}
              </button>
              <button type="button" class="kbtn sm" :disabled="bulkBusy || !bulkTagText.trim()" @click="bulkTag('removeTag')">
                {{ $t('custx.removeTag') }}
              </button>
            </span>
            <button
              v-perm="['data:write', 'customer:delete']"
              type="button"
              class="kbtn sm danger"
              :disabled="bulkBusy"
              data-testid="customers-bulk-delete"
              @click="bulkDelete"
            >
              {{ $t('custx.delete') }}
            </button>
          </template>
          <button type="button" class="link" @click="clearSelection">{{ $t('custx.clearSel') }}</button>
        </div>
        <div class="table-scroll-x">
          <table class="ctable data-table">
            <colgroup>
              <col style="width: 40px" />
              <col />
              <col v-if="showCol('contact')" style="width: 190px" />
              <col style="width: 64px" />
              <col v-if="showCol('localTime')" style="width: 76px" />
              <col style="width: 78px" />
              <col v-if="showCol('tags')" style="width: 120px" />
              <col style="width: 84px" />
              <col style="width: 104px" />
              <col style="width: 84px" />
              <col v-if="showCol('source')" style="width: 96px" />
              <col style="width: 40px" />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    class="cb"
                    :checked="allChecked"
                    :aria-label="$t('custx.selectAll')"
                    @change="toggleAll"
                  />
                </th>
                <th :aria-sort="sort === 'company' ? 'ascending' : undefined">
                  <button type="button" class="th-sort" :class="{ on: sort === 'company' }" @click="sort = sort === 'company' ? 'updatedAt' : 'company'">
                    {{ $t('customers.k1v5iwp2') }}<span v-if="sort === 'company'" aria-hidden="true">↑</span>
                  </button>
                </th>
                <th v-if="showCol('contact')">{{ $t('custx.col_contact') }}</th>
                <th>{{ $t('custx.country') }}</th>
                <th v-if="showCol('localTime')" :title="$t('custx.localTimeTip')">{{ $t('custx.col_localTime') }}</th>
                <th>{{ $t('customers.kl9iz6y') }}</th>
                <th v-if="showCol('tags')">{{ $t('custx.col_tags') }}</th>
                <th>{{ $t('custx.lastFollow') }}</th>
                <th>{{ $t('custx.nextFollow') }}</th>
                <th>{{ $t('custx.owner') }}</th>
                <th v-if="showCol('source')">{{ $t('custx.col_source') }}</th>
                <th>
                  <span class="sr-only">{{ $t('custx.actions') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in items"
                :key="c.id"
                class="row-link"
                :class="{ on: selected.has(c.id) }"
                tabindex="0"
                @click="open(c)"
                @keydown.enter.self="open(c)"
              >
                <td @click.stop>
                  <input
                    type="checkbox"
                    class="cb"
                    :checked="selected.has(c.id)"
                    :aria-label="$t('custx.selectOne', [c.company])"
                    @change="toggle(c.id)"
                  />
                </td>
                <td>
                  <div class="cust">
                    <div class="cust-txt">
                      <RouterLink class="cust-name" :to="`/customers/${c.id}`" :title="c.company" tabindex="-1" @click.stop>{{
                        c.company
                      }}</RouterLink>
                    </div>
                  </div>
                </td>
                <td v-if="showCol('contact')" class="ellip contact-cell" :title="[primary(c)?.name, primary(c)?.email || primary(c)?.phone || primary(c)?.whatsapp].filter(Boolean).join(' · ') || undefined">
                  <template v-if="primary(c)">
                    <span class="ct-name">{{ primary(c)?.name || '—' }}</span>
                    <span v-if="primary(c)?.email || primary(c)?.phone || primary(c)?.whatsapp" class="dim">
                      · {{ primary(c)?.email || primary(c)?.phone || primary(c)?.whatsapp }}</span
                    >
                  </template>
                  <span v-else class="dim">{{ $t('customers.k6tqy4q') }}</span>
                </td>
                <td class="dim ellip" :title="c.country || undefined">{{ c.country || '—' }}</td>
                <td v-if="showCol('localTime')" class="tnum" :title="localTime(c)?.tz">
                  <span v-if="localTime(c)" class="ltime" :class="{ work: localTime(c)?.workHours }"
                    ><i class="ldot" aria-hidden="true"></i>{{ localTime(c)?.approx ? $t('custx.approx') : '' }}{{ localTime(c)?.text }}</span
                  >
                  <span v-else class="dim">—</span>
                </td>
                <td>
                  <span class="stage-pill" :class="`s-${c.stage}`">{{ STAGE_LABEL[c.stage] ?? c.stage }}</span>
                </td>
                <td v-if="showCol('tags')" class="ellip" :title="c.tags.join(', ') || undefined">
                  <span v-for="tg in c.tags.slice(0, 2)" :key="tg" class="mini-tag">{{ tg }}</span>
                  <span v-if="c.tags.length > 2" class="dim">+{{ c.tags.length - 2 }}</span>
                  <span v-if="!c.tags.length" class="dim">—</span>
                </td>
                <td class="dim tnum">{{ lastTouch(c) }}</td>
                <td class="tnum ellip" :title="c.nextTask?.title">
                  <span v-if="c.nextTask" :class="dueLabel(c.nextTask.dueAt).cls || 'up'">{{
                    dueLabel(c.nextTask.dueAt).text
                  }}</span>
                  <span v-else class="dim">—</span>
                </td>
                <td class="dim ellip">{{ c.ownerName || '—' }}</td>
                <td v-if="showCol('source')" class="dim ellip" :title="c.source || undefined">{{ c.source || '—' }}</td>
                <td class="act-cell" @click.stop>
                  <button
                    type="button"
                    class="row-act"
                    :aria-label="$t('custx.moreFor', [c.company])"
                    :aria-expanded="menuFor === c.id"
                    @click="openMenu(c, $event)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.4" />
                      <circle cx="12" cy="12" r="1.4" />
                      <circle cx="19" cy="12" r="1.4" />
                    </svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <UiPager v-model:page="page" class="pager-in" :page-size="pageSize" :total="total" />
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="menuRow"
        class="row-menu"
        role="menu"
        :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px` }"
        @keydown.esc="closeMenu"
      >
        <RouterLink role="menuitem" :to="`/customers/${menuRow.id}`" @click="closeMenu">{{
          $t('custx.mOpen')
        }}</RouterLink>
        <RouterLink
          role="menuitem"
          :to="{ path: '/quotation/new', query: { customer: menuRow.id } }"
          @click="closeMenu"
          >{{ $t('custx.mQuote') }}</RouterLink
        >
        <button type="button" role="menuitem" @click="menuFollow">{{ $t('wbx.aiFollow') }}</button>
        <button
          v-if="can('data:write')"
          v-perm="['data:write', 'customer:delete']"
          type="button"
          role="menuitem"
          class="danger"
          @click="menuDelete"
        >
          {{ $t('custx.delete') }}
        </button>
      </div>
    </Teleport>

    <CustomerFormModal v-if="showCreate" @close="showCreate = false" @saved="onCreated" />
    <FollowUpModal
      v-if="followFor"
      :customer-id="followFor.id"
      :customer-name="followFor.company"
      @close="followFor = null"
      @created="load"
    />
  </main>
</template>

<style scoped>
.head-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  margin-bottom: 16px;
}
/* 窄窗口下按钮整组换到下一行并靠右，标题不被挤成两行、按钮不出界 */
.head-row > :first-child {
  flex: 1 1 180px;
  min-width: 0;
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px 12px;
  margin-left: auto;
}
.page-h {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.head-count {
  min-height: 18px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
.btn.dark {
  border-color: var(--bubble-user);
  background: var(--bubble-user);
  color: var(--on-strong);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.filter-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: -4px 0 12px;
}
.nav-row .count {
  margin-left: auto;
}
.nav-row.sub {
  height: 34px;
  font-size: 13px;
}
.nav-ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 10px 2px;
}
.chip {
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  font: inherit;
  font-size: 11.5px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
}
.chip:hover {
  color: var(--text);
}
.chip.on {
  background: var(--surface-active);
  border-color: transparent;
  color: var(--text);
  font-weight: 500;
}

/* 表格 */
.table-wrap {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.table-scroll-x {
  overflow-x: auto;
}
.ctable {
  width: 100%;
  min-width: 900px;
  border-collapse: collapse;
  table-layout: fixed;
}
.ctable thead th {
  height: 42px;
  padding: 0 12px;
  text-align: left;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--line);
  background: var(--surface-soft);
  white-space: nowrap;
}
.ctable tbody td {
  height: 57px;
  padding: 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--surface-muted);
  white-space: nowrap;
}
.ctable tbody tr:last-child td {
  border-bottom: 0;
}
.ctable tbody tr.on td {
  background: var(--surface-soft);
}
.row-link {
  cursor: pointer;
}
.row-link:hover td {
  background: var(--surface-soft);
}
.row-link:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.cb {
  appearance: none;
  width: 16px;
  height: 16px;
  margin: 0;
  display: block;
  border: 1.5px solid var(--line-strong);
  border-radius: 4px;
  background: var(--surface);
  cursor: pointer;
}
.cb:hover {
  border-color: var(--text-tertiary);
}
.cb:checked {
  border-color: var(--text);
  background: var(--text)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.2l2.6 2.6L12 5.4' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
    center / 12px no-repeat;
}
:root[data-theme='dark'] .cb:checked {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.2l2.6 2.6L12 5.4' fill='none' stroke='%23111113' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
th .cb,
td .cb {
  /* 点击区域 ≥ 24px */
  outline-offset: 4px;
}
.cust {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.cust-txt {
  min-width: 0;
}
.cust-name {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.005em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cust-name:hover {
  text-decoration: underline;
}
.dim {
  color: var(--text-tertiary);
  font-size: 12.5px;
}
.ellip {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tnum {
  font-variant-numeric: tabular-nums;
}
.over {
  color: var(--danger-text);
  font-weight: 500;
}
.today,
.up {
  color: var(--text);
  font-weight: 500;
}
.act-cell {
  text-align: right;
}
.row-act {
  width: 32px;
  height: 28px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
}
.row-act svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}
.row-act:hover,
.row-act[aria-expanded='true'] {
  background: var(--surface-hover);
  color: var(--text);
}
.pager-in {
  border-top: 1px solid var(--surface-muted);
}
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-soft);
  font-size: 12.5px;
}
.bulk-bar .select {
  width: auto;
  max-width: 170px;
}
.bulk-bar {
  flex-wrap: wrap;
}
.bulk-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.input.sm {
  height: 32px;
  width: 104px;
  padding: 0 10px;
  font-size: 13px;
}
.list-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
.tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tool-l {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}
.tool .select {
  width: auto;
}
.btn.sm {
  height: 32px;
  padding: 0 12px;
  font-size: 13px;
}
.cols-pop {
  position: relative;
}
.cols-pop > summary {
  list-style: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.cols-pop > summary::-webkit-details-marker {
  display: none;
}
.cols-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  min-width: 190px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-pop, 0 8px 24px rgba(0, 0, 0, 0.12));
}
.cols-menu label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.cols-menu label:hover {
  background: var(--surface-soft);
}
.cols-hint {
  margin: 4px 8px 2px;
  font-size: 11.5px;
  color: var(--text-tertiary);
  white-space: normal;
}
.th-sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.th-sort:hover,
.th-sort.on {
  color: var(--text);
}
.ctable tbody td {
  height: 50px;
  padding: 0 10px;
}
.ctable thead th {
  padding: 0 10px;
}
.ctable {
  min-width: 0;
}
.ctable .cust-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.contact-cell .ct-name {
  color: var(--text);
}
.ltime {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-tertiary);
}
.ltime.work {
  color: var(--text-secondary);
}
.ldot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line-strong);
  flex: none;
}
.ltime.work .ldot {
  background: var(--stage-5);
}
.mini-tag {
  display: inline-block;
  max-width: 64px;
  margin-right: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-muted);
  font-size: 11.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}
.is-loading {
  opacity: 0.6;
  transition: opacity 0.15s;
}

/* 行菜单 */
.row-menu {
  position: fixed;
  z-index: 800;
  width: 180px;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-3);
  display: flex;
  flex-direction: column;
}
.row-menu :is(a, button) {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  text-align: left;
}
.row-menu :is(a, button):hover {
  background: var(--surface-hover);
}
.row-menu .danger {
  color: var(--danger-text);
}

/* 看板 */
.kanban {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(196px, 1fr);
  gap: 12px;
  align-items: start;
  overflow-x: auto;
  padding-bottom: 4px;
}
.kcol {
  min-width: 0;
  padding: 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kcol.drop {
  border-color: var(--good);
  background: var(--good-soft);
}
.kcol-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 4px;
  font-size: 13px;
  font-weight: 600;
}
.kcol-head .count {
  margin-left: auto;
  font-weight: 400;
  font-size: 12px;
  color: var(--text-tertiary);
}
.kdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.kdot.s-lead {
  background: var(--stage-1);
}
.kdot.s-contacted {
  background: var(--stage-2);
}
.kdot.s-quoted {
  background: var(--stage-3);
}
.kdot.s-negotiating {
  background: var(--stage-4);
}
.kdot.s-won {
  background: var(--stage-5);
}
.kdot.s-lost {
  background: var(--stage-lost);
}
.kcard {
  display: block;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid var(--line);
  color: inherit;
}
.kcard:hover {
  border-color: var(--line-strong);
}
.kcard-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.kcard-top b {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kcard-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kcard-due {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kcard-due.over {
  color: var(--danger-text);
}
.kcard-due.today {
  color: var(--text);
  font-weight: 500;
}
.kempty {
  margin: 0;
  padding: 4px;
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
