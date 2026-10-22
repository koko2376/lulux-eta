<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import * as api from '../api'
import StateBlock from './ui/StateBlock.vue'
import UiModal from './ui/UiModal.vue'

/**
 * 会话业务上下文（契约 §6.4）：把会话绑定到一个客户和/或报价。
 * 绑定后每轮系统提示会带上客户资料、最近跟进与报价摘要。
 */
const props = defineProps<{ customerId: string | null; quoteId: string | null }>()
const emit = defineEmits<{ close: []; save: [context: api.SessionContext] }>()

const query = ref('')
const customers = ref<api.Customer[]>([])
const quotes = ref<api.Quote[]>([])
const customerId = ref<string | null>(props.customerId)
const quoteId = ref<string | null>(props.quoteId)
const selectedCustomer = ref<api.Customer | null>(null)
const loading = ref(false)
const error = ref('')
let timer = 0

async function search(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    customers.value = (await api.listCustomers({ query: query.value.trim() || undefined, pageSize: 20 })).items
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadQuotes(): Promise<void> {
  try {
    quotes.value = customerId.value ? await api.listQuotesForCustomer(customerId.value) : await api.listQuotes()
  } catch {
    quotes.value = []
  }
  if (quoteId.value && !quotes.value.some((q) => q.id === quoteId.value)) quoteId.value = null
}

onMounted(async () => {
  await Promise.all([search(), loadQuotes()])
  if (customerId.value) selectedCustomer.value = await api.getCustomer(customerId.value).catch(() => null)
})
watch(query, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(search, 250)
})

function pick(customer: api.Customer | null): void {
  customerId.value = customer?.id ?? null
  selectedCustomer.value = customer
  void loadQuotes()
}

const quoteLabel = (q: api.Quote) =>
  `${q.number} · ${q.currency} ${q.subtotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const changed = computed(() => customerId.value !== props.customerId || quoteId.value !== props.quoteId)
</script>

<template>
  <UiModal
    :title="$t('contextBindingModal.k187mzq')"
    :subtitle="$t('contextBindingModal.knfkybq')"
    :width="520"
    @close="emit('close')"
  >
    <div class="stack">
      <div class="bind-current">
        <span class="muted">{{ $t('contextBindingModal.k1psp28k') }}</span>
        <b v-if="selectedCustomer" class="bind-name" :title="selectedCustomer.company">{{
          selectedCustomer.company
        }}</b>
        <span v-else class="muted">{{ $t('contextBindingModal.kgmr8ig') }}</span>
        <button v-if="customerId" type="button" class="kbtn sm" @click="pick(null)">
          {{ $t('contextBindingModal.ky5gtew') }}
        </button>
      </div>
      <input
        v-model="query"
        class="input"
        :placeholder="$t('contextBindingModal.k1ytq6jo')"
        :aria-label="$t('contextBindingModal.kf31amz')"
      />
      <StateBlock v-if="loading && !customers.length" state="loading" compact />
      <StateBlock v-else-if="error" state="error" :message="error" compact @retry="search" />
      <StateBlock v-else-if="!customers.length" state="empty" :title="$t('contextBindingModal.kw2d5xi')" compact />
      <ul v-else class="pick-list" role="listbox" :aria-label="$t('contextBindingModal.k1v5iwp2')">
        <li v-for="c in customers" :key="c.id">
          <button
            type="button"
            class="pick"
            role="option"
            :aria-selected="c.id === customerId"
            :class="{ on: c.id === customerId }"
            :title="c.company"
            @click="pick(c)"
          >
            <b>{{ c.company }}</b>
            <span class="muted">{{ [c.country, c.contacts?.[0]?.email].filter(Boolean).join(' · ') }}</span>
          </button>
        </li>
      </ul>
      <label class="field">
        <span class="field-label">{{
          $t('contextBindingModal.kdkee00', [customerId ? $t('contextBindingModal.ki5jkyd') : ''])
        }}</span>
        <select v-model="quoteId" class="select" :aria-label="$t('contextBindingModal.k1py8dnr')">
          <option :value="null">{{ $t('contextBindingModal.ksqv1ce') }}</option>
          <option v-for="q in quotes" :key="q.id" :value="q.id">{{ quoteLabel(q) }}</option>
        </select>
      </label>
    </div>
    <template #footer>
      <button type="button" class="kbtn" @click="emit('close')">{{ $t('contextBindingModal.kldkknc') }}</button>
      <button type="button" class="kbtn primary" :disabled="!changed" @click="emit('save', { customerId, quoteId })">
        {{ $t('contextBindingModal.k1xlvxln') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.bind-current {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}
.bind-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow: auto;
}
.pick {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: left;
  font-size: 13px;
}
.pick b,
.pick span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick span {
  font-size: 12px;
}
.pick:hover,
.pick:focus-visible,
.pick.on {
  background: var(--surface-hover);
}
.pick.on b::after {
  content: ' ✓';
}
</style>
