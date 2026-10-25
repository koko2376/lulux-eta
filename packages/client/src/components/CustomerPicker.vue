<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import * as api from '../api'
import StateBlock from './ui/StateBlock.vue'
import UiModal from './ui/UiModal.vue'
import { t } from '../i18n'

/** 选择一个已有客户（邮件关联客户等） */
const props = withDefaults(defineProps<{ title?: string; initialQuery?: string }>(), {
  title: t('customerPicker.kdcse20'),
  initialQuery: '',
})
const emit = defineEmits<{ close: []; pick: [customer: api.Customer] }>()

const query = ref(props.initialQuery)
const items = ref<api.Customer[]>([])
const loading = ref(false)
const error = ref('')
let timer = 0

async function search(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    items.value = (await api.listCustomers({ query: query.value.trim() || undefined, pageSize: 20 })).items
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(search)
watch(query, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(search, 250)
})
</script>

<template>
  <UiModal :title="title" :width="480" @close="emit('close')">
    <div class="stack">
      <input
        v-model="query"
        class="input"
        :placeholder="$t('customerPicker.k1ytq6jo')"
        :aria-label="$t('customerPicker.kf31amz')"
        autofocus
      />
      <StateBlock v-if="loading && !items.length" state="loading" compact />
      <StateBlock v-else-if="error" state="error" :message="error" compact @retry="search" />
      <StateBlock v-else-if="!items.length" state="empty" :title="$t('customerPicker.kw2d5xi')" compact />
      <ul v-else class="pick-list" role="listbox" :aria-label="$t('customerPicker.k1v5iwp2')">
        <li v-for="c in items" :key="c.id">
          <button type="button" class="pick" role="option" @click="emit('pick', c)">
            <b>{{ c.company }}</b>
            <span class="muted">{{ [c.country, c.contacts?.[0]?.email].filter(Boolean).join(' · ') }}</span>
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
  max-height: 340px;
  overflow: auto;
}
.pick {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: left;
  font-size: 13px;
}
.pick span {
  font-size: 12px;
}
.pick:hover,
.pick:focus-visible {
  background: var(--surface-hover);
}
</style>
