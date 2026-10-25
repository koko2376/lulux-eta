<script setup lang="ts">
import { computed, ref } from 'vue'
import * as api from '../api'
import { parseCsv, parseXlsx, readText, type ParsedSheet } from '../lib/import'
import { guessProspectMapping as guess } from '../lib/prospect-import'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'
import FilePick from './ui/FilePick.vue'
import UiModal from './ui/UiModal.vue'

/**
 * 线索表格导入：选 CSV / Excel → 自动猜列 → 可改映射 → 导入。
 * 证据记为“表格导入”，不会算作海关证据；服务端同样做制裁名单初筛。
 */
const emit = defineEmits<{ close: []; done: [] }>()

const FIELDS = computed<Array<{ key: api.ProspectImportField; label: string; required?: boolean }>>(() => [
  { key: 'company', label: t('prosp.company'), required: true },
  { key: 'country', label: t('prosp.country') },
  { key: 'website', label: t('prosp.website') },
  { key: 'address', label: t('prosp.address') },
  { key: 'products', label: t('prosp.products') },
  { key: 'hsCodes', label: 'HS' },
  { key: 'emails', label: t('prosp.emails') },
  { key: 'phones', label: t('prosp.phones') },
  { key: 'notes', label: t('prosp.notes') },
])

const fileName = ref('')
const sheet = ref<ParsedSheet | null>(null)
const mapping = ref<Partial<Record<api.ProspectImportField, string>>>({})
const parsing = ref(false)
const importing = ref(false)
const result = ref<api.ProspectImportResult | null>(null)
const parseError = ref('')
const MAX = 2000

const rowsWithCompany = computed(() => {
  const col = mapping.value.company
  if (!sheet.value || !col) return 0
  return sheet.value.rows.filter((row) => (row[col] ?? '').trim()).length
})
const tooMany = computed(() => (sheet.value?.rows.length ?? 0) > MAX)

async function onFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  fileName.value = file.name
  parseError.value = ''
  result.value = null
  parsing.value = true
  try {
    const parsed = /\.xlsx?$/i.test(file.name)
      ? await parseXlsx(await file.arrayBuffer())
      : parseCsv(await readText(file))
    if (!parsed.headers.length) throw new Error(t('prosp.importEmpty'))
    sheet.value = parsed
    mapping.value = guess(parsed.headers)
  } catch (error) {
    sheet.value = null
    parseError.value = errorText(error)
  } finally {
    parsing.value = false
  }
}

async function submit(): Promise<void> {
  if (!sheet.value || !mapping.value.company || tooMany.value) return
  importing.value = true
  try {
    const clean = Object.fromEntries(Object.entries(mapping.value).filter(([, v]) => v)) as Partial<
      Record<api.ProspectImportField, string>
    >
    result.value = await api.importProspects({ fileName: fileName.value, mapping: clean, rows: sheet.value.rows })
    toast.success(t('prosp.importDone', [result.value.created, result.value.merged]))
    emit('done')
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <UiModal :title="$t('prosp.importTitle')" :subtitle="$t('prosp.importSub')" :width="560" @close="emit('close')">
    <div class="imp">
      <FilePick
        accept=".csv,.xlsx,.xls,text/csv"
        :file-name="fileName"
        :disabled="parsing || importing"
        testid="prospect-import-file"
        @change="onFile"
      />
      <p v-if="parseError" class="err" role="alert">{{ parseError }}</p>

      <template v-if="sheet && !result">
        <p class="meta">{{ $t('prosp.importRows', [sheet.rows.length, sheet.headers.length]) }}</p>
        <p v-if="tooMany" class="err" role="alert">{{ $t('prosp.importTooMany', [MAX]) }}</p>
        <div class="map">
          <label v-for="f in FIELDS" :key="f.key" class="map-row">
            <span class="map-k">{{ f.label }}<b v-if="f.required" class="req" aria-hidden="true">*</b></span>
            <select v-model="mapping[f.key]" class="select sm" :data-testid="`map-${f.key}`">
              <option :value="undefined">{{ $t('prosp.importSkip') }}</option>
              <option v-for="h in sheet.headers" :key="h" :value="h">{{ h }}</option>
            </select>
          </label>
        </div>
        <p class="hint">{{ $t('prosp.importHint') }}</p>
      </template>

      <div v-if="result" class="res" data-testid="prospect-import-result">
        <p>{{ $t('prosp.importResult', [result.created, result.merged, result.skipped]) }}</p>
        <p v-if="result.sanctionsHits" class="warn-line">{{ $t('prosp.importSanctions', [result.sanctionsHits]) }}</p>
        <ul v-if="result.errors.length" class="errs">
          <li v-for="e in result.errors.slice(0, 8)" :key="e.row">
            {{ $t('prosp.importRowErr', [e.row, e.message]) }}
          </li>
        </ul>
      </div>
    </div>
    <template #footer>
      <button type="button" class="btn" @click="emit('close')">
        {{ result ? $t('prosp.close') : $t('prosp.cancel') }}
      </button>
      <button
        v-if="!result"
        type="button"
        class="btn dark"
        data-testid="prospect-import-submit"
        :disabled="!sheet || !mapping.company || !rowsWithCompany || tooMany || importing"
        @click="submit"
      >
        {{ importing ? $t('prosp.importing') : $t('prosp.importGo', [rowsWithCompany]) }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.imp {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.meta,
.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-tertiary);
  line-height: 1.5;
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--danger, #d64545);
}
.map {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
}
.map-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.map-k {
  font-size: 12px;
  color: var(--text-secondary);
}
.req {
  margin-left: 2px;
  color: var(--danger, #d64545);
}
.map-row .select {
  width: 100%;
  min-width: 0;
}
.res p {
  margin: 0 0 6px;
  font-size: 13.5px;
}
.warn-line {
  color: var(--prs-red, #c03333);
}
.errs {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-secondary);
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
</style>
