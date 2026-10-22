<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../api'
import { t } from '../i18n'
import { toggleSidebar } from '../lib/agent-sidebar'
import { can } from '../lib/session'
import { focusComposer, matchesQuery, shortcutUi } from '../lib/shortcuts'
import { useAppStore } from '../stores/app'
import UiModal from './ui/UiModal.vue'

/**
 * 搜索 / 命令面板（Ctrl/⌘+K）：跳转到客户、报价、订单、会话、页面，或执行常用操作。
 * 客户走服务端搜索（输入停顿后请求）；报价 / 订单在打开时取一次列表，本地按编号 / 客户名过滤；会话用侧栏已有的列表。
 */
type Group = 'actions' | 'pages' | 'sessions' | 'customers' | 'quotes' | 'orders'
interface Item {
  id: string
  group: Group
  label: string
  sub?: string
  run: () => unknown
}

const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const store = useAppStore()
const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const customers = ref<Array<{ id: string; company: string; country?: string }>>([])
const quotes = ref<Array<{ id: string; number: string; status?: string }>>([])
const orders = ref<Array<{ id: string; number: string; customerName?: string }>>([])

const PER_GROUP = 6

async function go(path: string): Promise<void> {
  await router.push(path)
}

async function onAgentPage(): Promise<void> {
  if (router.currentRoute.value.name !== 'agent') await router.push({ name: 'agent' })
}

const actions = computed<Item[]>(() => [
  {
    id: 'a:new-chat',
    group: 'actions',
    label: t('shortcuts.newChat'),
    run: async () => {
      await onAgentPage()
      await store.newSession().catch(() => undefined)
      await nextTick()
      focusComposer()
    },
  },
  {
    id: 'a:focus',
    group: 'actions',
    label: t('shortcuts.focusComposer'),
    run: async () => {
      await onAgentPage()
      await nextTick()
      focusComposer()
    },
  },
  {
    id: 'a:sidebar',
    group: 'actions',
    label: t('shortcuts.toggleSidebar'),
    run: async () => {
      await onAgentPage()
      toggleSidebar()
    },
  },
  {
    id: 'a:help',
    group: 'actions',
    label: t('shortcuts.help'),
    run: () => {
      shortcutUi.help = true
    },
  },
])

const PAGES: Array<{ path: string; key: string }> = [
  { path: '/', key: 'shortcuts.pageWorkbench' },
  { path: '/agent', key: 'shortcuts.pageAgent' },
  { path: '/customers', key: 'shortcuts.pageCustomers' },
  { path: '/deals', key: 'shortcuts.pageDeals' },
  { path: '/quotation', key: 'shortcuts.pageQuotation' },
  { path: '/orders', key: 'shortcuts.pageOrders' },
  { path: '/mailbox', key: 'shortcuts.pageMailbox' },
  { path: '/workflows', key: 'shortcuts.pageWorkflows' },
  { path: '/schedules', key: 'shortcuts.pageSchedules' },
  { path: '/skills', key: 'shortcuts.pageSkills' },
  { path: '/settings/models', key: 'shortcuts.pageSettingsModels' },
  { path: '/settings/mailbox', key: 'shortcuts.pageSettingsMailbox' },
  { path: '/settings/team', key: 'shortcuts.pageSettingsTeam' },
  { path: '/settings/backup', key: 'shortcuts.pageSettingsBackup' },
  { path: '/settings/appearance', key: 'shortcuts.pageSettingsAppearance' },
  { path: '/settings/account', key: 'shortcuts.pageSettingsAccount' },
  { path: '/settings/about', key: 'shortcuts.pageSettingsAbout' },
]

const pages = computed<Item[]>(() =>
  PAGES.map((p) => ({ id: `p:${p.path}`, group: 'pages' as const, label: t(p.key), sub: p.path, run: () => go(p.path) })),
)

const sessionItems = computed<Item[]>(() =>
  store.sessions
    .filter((s) => matchesQuery(`${s.title} ${s.groupName ?? ''}`, query.value))
    .slice(0, PER_GROUP)
    .map((s) => ({
      id: `s:${s.id}`,
      group: 'sessions' as const,
      label: s.title || t('shortcuts.untitled'),
      sub: s.groupName ?? undefined,
      run: async () => {
        await onAgentPage()
        await store.selectSession(s.id).catch(() => undefined)
      },
    })),
)

const items = computed<Item[]>(() => {
  const q = query.value
  const out: Item[] = []
  out.push(...actions.value.filter((i) => matchesQuery(i.label, q)))
  out.push(...pages.value.filter((i) => matchesQuery(`${i.label} ${i.sub}`, q)).slice(0, q.trim() ? PER_GROUP : PAGES.length))
  if (q.trim()) {
    out.push(...sessionItems.value)
    out.push(
      ...customers.value.slice(0, PER_GROUP).map((c) => ({
        id: `c:${c.id}`,
        group: 'customers' as const,
        label: c.company,
        sub: c.country || undefined,
        run: () => go(`/customers/${encodeURIComponent(c.id)}`),
      })),
    )
    out.push(
      ...quotes.value
        .filter((x) => matchesQuery(x.number, q))
        .slice(0, PER_GROUP)
        .map((x) => ({ id: `q:${x.id}`, group: 'quotes' as const, label: x.number, run: () => go(`/quotation/${encodeURIComponent(x.id)}`) })),
    )
    out.push(
      ...orders.value
        .filter((x) => matchesQuery(`${x.number} ${x.customerName ?? ''}`, q))
        .slice(0, PER_GROUP)
        .map((x) => ({
          id: `o:${x.id}`,
          group: 'orders' as const,
          label: x.number,
          sub: x.customerName || undefined,
          run: () => go(`/orders/${encodeURIComponent(x.id)}`),
        })),
    )
  }
  return out
})

const GROUP_LABEL = computed<Record<Group, string>>(() => ({
  actions: t('shortcuts.groupActions'),
  pages: t('shortcuts.groupPages'),
  sessions: t('shortcuts.groupSessions'),
  customers: t('shortcuts.groupCustomers'),
  quotes: t('shortcuts.groupQuotes'),
  orders: t('shortcuts.groupOrders'),
}))

/** 渲染用：带分组标题的行 */
const rows = computed(() => {
  const out: Array<{ header: string } | { item: Item; index: number }> = []
  let last: Group | null = null
  items.value.forEach((item, index) => {
    if (item.group !== last) {
      out.push({ header: GROUP_LABEL.value[item.group] })
      last = item.group
    }
    out.push({ item, index })
  })
  return out
})

watch(items, () => {
  if (active.value >= items.value.length) active.value = Math.max(0, items.value.length - 1)
})
watch(query, () => {
  active.value = 0
  scheduleCustomerSearch()
})

let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0
function scheduleCustomerSearch(): void {
  if (timer) clearTimeout(timer)
  const q = query.value.trim()
  if (!q || !can('data:read')) {
    customers.value = []
    return
  }
  timer = setTimeout(async () => {
    const mine = ++seq
    try {
      const res = await api.request<{ items?: Array<{ id: string; company: string; country?: string }> }>('/api/customers', {
        query: { query: q, pageSize: PER_GROUP },
        silent: true,
      })
      if (mine === seq) customers.value = res?.items ?? []
    } catch {
      if (mine === seq) customers.value = []
    }
  }, 180)
}

async function loadLists(): Promise<void> {
  if (!can('data:read')) return
  const [q, o] = await Promise.all([
    api.request<unknown>('/api/quotes', { silent: true }).catch(() => null),
    api.request<{ items?: unknown[] }>('/api/orders', { query: { limit: 200 }, silent: true }).catch(() => null),
  ])
  const quoteList = Array.isArray(q) ? q : ((q as { quotes?: unknown[]; items?: unknown[] } | null)?.quotes ?? (q as { items?: unknown[] } | null)?.items ?? [])
  quotes.value = quoteList as typeof quotes.value
  orders.value = ((o?.items ?? []) as typeof orders.value) || []
}

async function runItem(item: Item | undefined): Promise<void> {
  if (!item) return
  emit('close')
  await item.run()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  const n = items.value.length
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (n) active.value = (active.value + 1) % n
    scrollActive()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (n) active.value = (active.value + n - 1) % n
    scrollActive()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void runItem(items.value[active.value])
  }
}

function scrollActive(): void {
  void nextTick(() => {
    listEl.value?.querySelector<HTMLElement>('.cp-item.on')?.scrollIntoView?.({ block: 'nearest' })
  })
}

onMounted(() => {
  void loadLists()
  void nextTick(() => input.value?.focus())
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <UiModal :title="$t('shortcuts.paletteTitle')" :width="560" @close="emit('close')">
    <div class="cp" data-testid="command-palette">
      <input
        ref="input"
        v-model="query"
        class="input cp-input"
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls="cp-list"
        :aria-activedescendant="items[active] ? `cp-${active}` : undefined"
        :placeholder="$t('shortcuts.palettePlaceholder')"
        spellcheck="false"
        autocomplete="off"
        autofocus
        data-testid="command-input"
        @keydown="onKeydown"
      />
      <ul id="cp-list" ref="listEl" class="cp-list" role="listbox" :aria-label="$t('shortcuts.paletteTitle')">
        <template v-for="(row, i) in rows" :key="i">
          <li v-if="'header' in row" class="cp-head" role="presentation">{{ row.header }}</li>
          <li
            v-else
            :id="`cp-${row.index}`"
            class="cp-item"
            :class="{ on: row.index === active }"
            role="option"
            :aria-selected="row.index === active"
            :data-item="row.item.id"
            @mousemove="active = row.index"
            @click="runItem(row.item)"
          >
            <span class="cp-label">{{ row.item.label }}</span>
            <span v-if="row.item.sub" class="cp-sub">{{ row.item.sub }}</span>
          </li>
        </template>
        <li v-if="!items.length" class="cp-empty" role="presentation">{{ $t('shortcuts.noResults') }}</li>
      </ul>
    </div>
  </UiModal>
</template>

<style scoped>
.cp {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cp-input {
  width: 100%;
}
.cp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: min(420px, 60vh);
  overflow-y: auto;
}
.cp-head {
  padding: 8px 8px 4px;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cp-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font-size: var(--fs-sm);
}
.cp-item.on {
  background: var(--accent-soft, rgba(0, 0, 0, 0.06));
}
.cp-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-sub {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.cp-empty {
  padding: 16px 8px;
  color: var(--muted);
  text-align: center;
  font-size: var(--fs-sm);
}
</style>
