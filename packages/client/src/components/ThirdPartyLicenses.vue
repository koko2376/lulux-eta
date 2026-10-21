<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { parseThirdParty, type ThirdPartyEntry } from '../lib/about'
import { openExternal } from '../lib/window'
import UiModal from './ui/UiModal.vue'

const emit = defineEmits<{ close: [] }>()
const entries = ref<ThirdPartyEntry[]>([])
const notice = ref('')
const loading = ref(true)
const failed = ref(false)
const query = ref('')

onMounted(async () => {
  try {
    // 构建时把仓库根目录的 NOTICE / THIRD_PARTY_LICENSES.md 作为纯文本打进单独的分块，打开时才加载
    const [md, nt] = await Promise.all([
      import('../../../../THIRD_PARTY_LICENSES.md?raw'),
      import('../../../../NOTICE?raw'),
    ])
    entries.value = parseThirdParty(md.default)
    notice.value = nt.default
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
})

const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map<string, ThirdPartyEntry[]>()
  for (const e of entries.value) {
    if (q && !`${e.name} ${e.license}`.toLowerCase().includes(q)) continue
    const list = map.get(e.group) ?? []
    list.push(e)
    map.set(e.group, list)
  }
  return [...map.entries()]
})
const total = computed(() => groups.value.reduce((n, [, list]) => n + list.length, 0))

function open(event: MouseEvent, url: string): void {
  event.preventDefault()
  openExternal(url)
}
</script>

<template>
  <UiModal
    :title="$t('thirdPartyLicenses.k1frlde3')"
    :subtitle="$t('thirdPartyLicenses.kmk13m5')"
    :width="720"
    @close="emit('close')"
  >
    <div v-if="loading" class="muted">{{ $t('thirdPartyLicenses.kdc1fby') }}</div>
    <div v-else-if="failed" class="muted">{{ $t('thirdPartyLicenses.k19465jb') }}</div>
    <template v-else>
      <input
        v-model="query"
        class="input tp-search"
        type="search"
        :placeholder="$t('thirdPartyLicenses.kjr7hxw')"
        :aria-label="$t('thirdPartyLicenses.kjr7hxw')"
      />
      <p class="tp-count">{{ $t('thirdPartyLicenses.ktd0rt9', [total]) }}</p>
      <section v-for="[group, list] in groups" :key="group" class="tp-group">
        <h3>
          {{ group }} <span>{{ list.length }}</span>
        </h3>
        <table class="tp-table">
          <thead>
            <tr>
              <th>{{ $t('thirdPartyLicenses.k7qqgy7') }}</th>
              <th>{{ $t('thirdPartyLicenses.k16ceynz') }}</th>
              <th>{{ $t('thirdPartyLicenses.km8lw71') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in list" :key="group + e.name + e.version">
              <td>
                <a v-if="/^https?:\/\//.test(e.repo)" class="link" :href="e.repo" @click="open($event, e.repo)">{{
                  e.name
                }}</a>
                <span v-else>{{ e.name }}</span>
              </td>
              <td class="mono">{{ e.version || '—' }}</td>
              <td>{{ e.license }}</td>
            </tr>
          </tbody>
        </table>
      </section>
      <details class="tp-notice">
        <summary>{{ $t('thirdPartyLicenses.kepbh62') }}</summary>
        <pre>{{ notice }}</pre>
      </details>
    </template>
  </UiModal>
</template>

<style scoped>
.tp-search {
  width: 100%;
}
.tp-count {
  margin: 8px 0 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.tp-group h3 {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
}
.tp-group h3 span {
  color: var(--text-secondary);
  font-weight: 400;
  margin-left: 4px;
}
.tp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.tp-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-secondary);
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}
.tp-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--surface-muted);
  overflow-wrap: anywhere;
}
.tp-table tbody tr:nth-child(even) td {
  background: var(--surface-soft);
}
.mono {
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
  font-variant-numeric: tabular-nums;
}
.tp-notice {
  margin-top: 16px;
  font-size: 12.5px;
}
.tp-notice summary {
  cursor: pointer;
  font-weight: 600;
}
.tp-notice pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
  background: var(--surface-soft);
  padding: 12px;
  border-radius: 8px;
}
</style>
