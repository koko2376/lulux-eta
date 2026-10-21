<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../../api'
import { request } from '../../api/http'
import { t } from '../../i18n'

/**
 * 顶栏全局搜索（原版的灰色搜索框）：客户 / 报价 / 邮件，输入即搜，↑↓ 选择，回车打开；
 * 没有选中项时回车 → 客户列表按关键字筛选。没有权限 / 旧服务端的那一组静默为空。
 */
interface Hit {
  key: string
  group: 'customers' | 'quotes' | 'mail'
  title: string
  sub: string
  to: string | { path: string; query?: Record<string, string> }
}

const router = useRouter()
const q = ref('')
const open = ref(false)
const loading = ref(false)
const hits = ref<Hit[]>([])
const active = ref(-1)
let timer = 0
let ticket = 0
let quotesCache: { at: number; items: api.Quote[] } | null = null
let customerNames = new Map<string, string>()

async function quotes(): Promise<api.Quote[]> {
  if (quotesCache && Date.now() - quotesCache.at < 60_000) return quotesCache.items
  const res = await request<unknown>('/api/quotes', { silent: true })
  const items = (
    Array.isArray(res)
      ? res
      : ((res as { items?: api.Quote[]; quotes?: api.Quote[] })?.items ??
        (res as { quotes?: api.Quote[] })?.quotes ??
        [])
  ) as api.Quote[]
  quotesCache = { at: Date.now(), items }
  return items
}

async function search(text: string): Promise<void> {
  const my = ++ticket
  loading.value = true
  const needle = text.toLowerCase()
  const [cust, quo, mail] = await Promise.allSettled([
    request<{ items: api.Customer[] }>('/api/customers', { query: { query: text, pageSize: 5 }, silent: true }),
    quotes(),
    request<{ items: api.EmailMessageSummary[] }>('/api/email/messages', {
      query: { query: text, pageSize: 5, folder: 'all' },
      silent: true,
    }),
  ])
  if (my !== ticket) return
  const out: Hit[] = []
  if (cust.status === 'fulfilled') {
    for (const c of cust.value.items ?? []) {
      customerNames.set(c.id, c.company)
      const contact = c.contacts?.find((x) => x.isPrimary) ?? c.contacts?.[0]
      out.push({
        key: `c:${c.id}`,
        group: 'customers',
        title: c.company,
        sub: [c.country, contact?.name || contact?.email].filter(Boolean).join(' · '),
        to: `/customers/${c.id}`,
      })
    }
  }
  if (quo.status === 'fulfilled') {
    for (const qt of quo.value
      .filter(
        (x) =>
          x.number.toLowerCase().includes(needle) ||
          (customerNames.get(x.customerId) ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 5)) {
      out.push({
        key: `q:${qt.id}`,
        group: 'quotes',
        title: qt.number,
        sub: customerNames.get(qt.customerId) ?? '',
        to: `/quotation/${qt.id}`,
      })
    }
  }
  if (mail.status === 'fulfilled') {
    for (const m of mail.value.items ?? []) {
      out.push({
        key: `m:${m.id}`,
        group: 'mail',
        title: m.subject || t('shellx.noSubject'),
        sub: m.from?.name || m.from?.address || '',
        to: { path: '/mailbox', query: { message: m.id, q: text } },
      })
    }
  }
  hits.value = out
  active.value = out.length ? 0 : -1
  loading.value = false
}

watch(q, (text) => {
  window.clearTimeout(timer)
  const trimmed = text.trim()
  if (!trimmed) {
    ticket++
    hits.value = []
    loading.value = false
    return
  }
  open.value = true
  loading.value = true
  timer = window.setTimeout(() => void search(trimmed), 220)
})
onBeforeUnmount(() => window.clearTimeout(timer))

const groups = computed(() =>
  (['customers', 'quotes', 'mail'] as const)
    .map((g) => ({ g, items: hits.value.filter((h) => h.group === g) }))
    .filter((x) => x.items.length),
)
const groupLabel = (g: Hit['group']) =>
  g === 'customers' ? t('shellx.groupCustomers') : g === 'quotes' ? t('shellx.groupQuotes') : t('shellx.groupMail')

function go(hit: Hit | undefined): void {
  const text = q.value.trim()
  open.value = false
  if (hit) void router.push(hit.to)
  else if (text) void router.push({ path: '/customers', query: { q: text } })
  q.value = ''
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' && hits.value.length) {
    e.preventDefault()
    open.value = true
    active.value = (active.value + 1) % hits.value.length
  } else if (e.key === 'ArrowUp' && hits.value.length) {
    e.preventDefault()
    active.value = (active.value - 1 + hits.value.length) % hits.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    go(hits.value[active.value])
  } else if (e.key === 'Escape') {
    open.value = false
    ;(e.target as HTMLInputElement).blur()
  }
}
function onBlur(): void {
  // 让下拉里的点击先生效
  window.setTimeout(() => (open.value = false), 150)
}
</script>

<template>
  <div class="gsearch">
    <label class="search">
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </svg>
      <input
        v-model="q"
        type="search"
        :placeholder="$t('shellx.searchPlaceholder')"
        :aria-label="$t('shellx.searchAria')"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        :aria-expanded="open && !!q.trim()"
        aria-controls="gsearch-list"
        @focus="open = true"
        @blur="onBlur"
        @keydown="onKey"
      />
    </label>
    <div v-if="open && q.trim()" id="gsearch-list" class="gs-pop" role="listbox">
      <div v-if="loading && !hits.length" class="gs-empty">{{ $t('shellx.searching') }}</div>
      <div v-else-if="!hits.length" class="gs-empty">{{ $t('shellx.noHits') }}</div>
      <template v-for="grp in groups" :key="grp.g">
        <div class="gs-label">{{ groupLabel(grp.g) }}</div>
        <button
          v-for="h in grp.items"
          :key="h.key"
          type="button"
          class="gs-row"
          role="option"
          :aria-selected="hits[active]?.key === h.key"
          :class="{ on: hits[active]?.key === h.key }"
          @mousedown.prevent="go(h)"
        >
          <b>{{ h.title }}</b
          ><span v-if="h.sub">{{ h.sub }}</span>
        </button>
      </template>
      <button type="button" class="gs-row gs-all" @mousedown.prevent="go(undefined)">
        {{ $t('shellx.searchAllCustomers', [q.trim()]) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.gsearch {
  position: relative;
  -webkit-app-region: no-drag;
}
.search input::-webkit-search-cancel-button {
  display: none;
}
.gs-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 340px;
  max-height: 420px;
  overflow: auto;
  z-index: 60;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-3);
}
.gs-label {
  padding: 8px 10px 4px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.gs-row {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 34px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  font: inherit;
  font-size: 13px;
}
.gs-row b {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60%;
}
.gs-row span {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs-row:hover,
.gs-row.on {
  background: var(--surface-hover);
}
.gs-all {
  margin-top: 4px;
  color: var(--text-secondary);
  border-top: 1px solid var(--line);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
}
.gs-empty {
  padding: 12px 10px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}
</style>
