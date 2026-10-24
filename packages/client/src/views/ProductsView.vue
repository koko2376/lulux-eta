<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import FilePick from '../components/ui/FilePick.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import PermNote from '../components/ui/PermNote.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import { t } from '../i18n'
import { downloadBlob, stamp } from '../lib/download'
import { parseCsv, readText } from '../lib/import'
import {
  filterProducts,
  guessProductMapping,
  productCategories,
  productRowsForImport,
  productsToCsv,
} from '../lib/products'
import { formatMoney } from '../lib/quote'
import { can } from '../lib/session'
import { confirmDialog, errorText, toast } from '../stores/ui'

/**
 * 产品库：报价单选品与核价（低于产品价、低于起订量、币种不一致）用的数据源。
 * 列表 / 搜索 / 按分类筛选；新建、编辑、删除与 CSV 导入需要 catalog:write，导出所有人可用。
 */
const products = ref<api.Product[]>([])
const loading = ref(true)
const error = ref('')
const canWrite = computed(() => can('catalog:write'))

const q = ref('')
/** null = 全部；'' = 未分类 */
const category = ref<string | null>(null)
const categories = computed(() => productCategories(products.value))
const uncategorized = computed(() => products.value.filter((p) => !(p.category ?? '').trim()).length)
const visible = computed(() => filterProducts(products.value, q.value, category.value))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    products.value = await api.listProducts()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

/* ── 新建 / 编辑 ── */
type Draft = Omit<api.ProductInput, 'price' | 'moq'> & { price: number | ''; moq: number | '' }
const blank = (): Draft => ({
  sku: '',
  name: '',
  category: category.value ?? '',
  spec: '',
  unit: 'pcs',
  price: '',
  currency: 'USD',
  moq: '',
  hsCode: '',
})
const editing = ref<api.Product | null>(null)
const showForm = ref(false)
const form = reactive<Draft>(blank())
const saving = ref(false)
const formError = ref('')
const nameMissing = ref(false)

function openCreate(): void {
  editing.value = null
  Object.assign(form, blank())
  formError.value = ''
  nameMissing.value = false
  showForm.value = true
}
function openEdit(p: api.Product): void {
  editing.value = p
  Object.assign(form, {
    sku: p.sku,
    name: p.name,
    category: p.category ?? '',
    spec: p.spec,
    unit: p.unit,
    price: p.price,
    currency: p.currency,
    moq: p.moq,
    hsCode: p.hsCode,
  })
  formError.value = ''
  nameMissing.value = false
  showForm.value = true
}

async function save(): Promise<void> {
  formError.value = ''
  nameMissing.value = !form.name.trim()
  if (nameMissing.value) return
  if (form.hsCode && !/^[0-9.]*$/.test(form.hsCode.trim())) return void (formError.value = t('products.hsInvalid'))
  const input: api.ProductInput = {
    sku: form.sku.trim(),
    name: form.name.trim(),
    category: form.category.trim(),
    spec: form.spec,
    unit: form.unit.trim() || 'pcs',
    price: form.price === '' ? 0 : Number(form.price),
    currency: form.currency.trim().toUpperCase() || 'USD',
    moq: form.moq === '' ? 0 : Math.max(0, Math.round(Number(form.moq))),
    hsCode: form.hsCode.trim(),
  }
  saving.value = true
  try {
    const saved = editing.value ? await api.updateProduct(editing.value.id, input) : await api.createProduct(input)
    const i = products.value.findIndex((p) => p.id === saved.id)
    if (i >= 0) products.value.splice(i, 1, saved)
    else products.value.unshift(saved)
    showForm.value = false
    toast.success(editing.value ? t('products.updated', [saved.name]) : t('products.created', [saved.name]))
  } catch (e) {
    formError.value = errorText(e)
  } finally {
    saving.value = false
  }
}

async function remove(p: api.Product): Promise<void> {
  const ok = await confirmDialog({
    title: t('products.deleteTitle'),
    message: t('products.deleteMsg', [p.name]),
    confirmText: t('products.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await api.deleteProduct(p.id)
    products.value = products.value.filter((x) => x.id !== p.id)
    toast.success(t('products.deleted', [p.name]))
  } catch {
    /* 全局提示已展示服务端原因 */
  }
}

/* ── CSV 导入 / 导出 ── */
const showImport = ref(false)
const importRows = ref<Array<Record<string, string>>>([])
const importFile = ref('')
const importError = ref('')
const importing = ref(false)
const onDuplicate = ref<'update' | 'skip'>('update')
const importResult = ref<api.ProductImportResult | null>(null)

function openImport(): void {
  importRows.value = []
  importFile.value = ''
  importError.value = ''
  importResult.value = null
  showImport.value = true
}
async function onFile(event: Event): Promise<void> {
  importError.value = ''
  importResult.value = null
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  importFile.value = file.name
  const sheet = parseCsv(await readText(file))
  const mapping = guessProductMapping(sheet.headers)
  if (!mapping.name) {
    importRows.value = []
    importError.value = t('products.importNoName')
    return
  }
  importRows.value = productRowsForImport(sheet.rows, mapping)
  if (!importRows.value.length) importError.value = t('products.importEmpty')
}
async function runImport(): Promise<void> {
  if (!importRows.value.length) return
  importing.value = true
  try {
    importResult.value = await api.importProducts(importRows.value, onDuplicate.value)
    await load()
  } catch (e) {
    importError.value = errorText(e)
  } finally {
    importing.value = false
  }
}
function exportCsv(): void {
  const blob = new Blob([productsToCsv(visible.value)], { type: 'text/csv;charset=utf-8' })
  downloadBlob(blob, `products-${stamp()}.csv`)
}
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('products.title')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('products.title') }}</h2>
        <button v-if="canWrite" type="button" class="link" data-testid="product-new-side" @click="openCreate">
          {{ $t('products.new') }}
        </button>
      </div>
      <label class="side-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span class="sr-only">{{ $t('products.search') }}</span>
        <input
          v-model="q"
          type="search"
          :placeholder="$t('products.search')"
          spellcheck="false"
          data-testid="product-search"
        />
      </label>
      <nav class="side-body">
        <div role="group" :aria-label="$t('products.category')">
          <button
            type="button"
            class="nav-row"
            :class="{ on: category === null }"
            :aria-pressed="category === null"
            @click="category = null"
          >
            {{ $t('products.all') }}<span class="count">{{ products.length }}</span>
          </button>
          <div v-if="categories.length" class="side-label">{{ $t('products.category') }}</div>
          <button
            v-for="c in categories"
            :key="c.value"
            type="button"
            class="nav-row sub"
            :class="{ on: category === c.value }"
            :aria-pressed="category === c.value"
            data-testid="product-category"
            @click="category = c.value"
          >
            {{ c.value }}<span class="count">{{ c.count }}</span>
          </button>
          <button
            v-if="categories.length && uncategorized"
            type="button"
            class="nav-row sub"
            :class="{ on: category === '' }"
            :aria-pressed="category === ''"
            @click="category = ''"
          >
            {{ $t('products.uncategorized') }}<span class="count">{{ uncategorized }}</span>
          </button>
        </div>
        <div class="side-label">{{ $t('crm.related') }}</div>
        <RouterLink class="nav-row" to="/quotation">{{ $t('products.quotes') }}</RouterLink>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('products.title')" :sub="$t('products.sub')">
      <button type="button" class="kbtn" :disabled="!visible.length" data-testid="product-export" @click="exportCsv">
        {{ $t('products.export') }}
      </button>
      <button v-if="canWrite" type="button" class="kbtn" data-testid="product-import" @click="openImport">
        {{ $t('products.import') }}
      </button>
      <button v-if="canWrite" type="button" class="kbtn primary" data-testid="product-new" @click="openCreate">
        {{ $t('products.new') }}
      </button>
    </PageTopbar>

    <div class="doc">
      <PermNote perm="catalog:write" :text="$t('products.readonly')" />
      <StateBlock v-if="loading && !products.length" state="loading" />
      <StateBlock v-else-if="error" state="error" :message="error" @retry="load" />
      <StateBlock
        v-else-if="!products.length"
        state="empty"
        :title="$t('products.emptyTitle')"
        :message="canWrite ? $t('products.emptyMsg') : $t('products.emptyMsgRo')"
      >
        <button v-if="canWrite" type="button" class="kbtn primary" @click="openCreate">{{ $t('products.new') }}</button>
      </StateBlock>
      <template v-else>
        <div class="head-row">
          <div>
            <h2 class="page-h">
              {{ category === null ? $t('products.all') : category || $t('products.uncategorized') }}
            </h2>
            <div class="head-count">{{ $t('products.count', [visible.length, products.length]) }}</div>
          </div>
        </div>
        <StateBlock v-if="!visible.length" state="empty" :title="$t('products.noMatch')" compact />
        <div v-else class="table-wrap" data-hscroll-ok>
          <table class="data-table" data-testid="product-table">
            <thead>
              <tr>
                <th>{{ $t('products.sku') }}</th>
                <th>{{ $t('products.name') }}</th>
                <th>{{ $t('products.category') }}</th>
                <th>{{ $t('products.spec') }}</th>
                <th>{{ $t('products.unit') }}</th>
                <th class="num">{{ $t('products.price') }}</th>
                <th class="num">{{ $t('products.moq') }}</th>
                <th>{{ $t('products.hsCode') }}</th>
                <th v-if="canWrite">
                  <span class="sr-only">{{ $t('products.actions') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in visible" :key="p.id">
                <td class="mono">{{ p.sku || '—' }}</td>
                <td class="strong">{{ p.name }}</td>
                <td>{{ p.category || '—' }}</td>
                <td class="clip" :title="p.spec">{{ p.spec || '—' }}</td>
                <td>{{ p.unit }}</td>
                <td class="num">{{ p.price > 0 ? formatMoney(p.price, p.currency) : '—' }}</td>
                <td class="num">{{ p.moq || '—' }}</td>
                <td class="mono">{{ p.hsCode || '—' }}</td>
                <td v-if="canWrite" class="acts">
                  <button type="button" class="link" :aria-label="$t('products.editOf', [p.name])" @click="openEdit(p)">
                    {{ $t('products.edit') }}
                  </button>
                  <button
                    type="button"
                    class="link danger"
                    :aria-label="$t('products.deleteOf', [p.name])"
                    @click="remove(p)"
                  >
                    {{ $t('products.delete') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <UiModal
      v-if="showForm"
      :title="editing ? $t('products.editTitle') : $t('products.newTitle')"
      :width="600"
      @close="showForm = false"
    >
      <form id="product-form" class="stack" novalidate @submit.prevent="save">
        <div class="form-grid">
          <label class="field span-2"
            ><span class="field-label">{{ $t('products.nameReq') }}</span
            ><input
              v-model="form.name"
              class="input"
              :class="{ invalid: nameMissing }"
              maxlength="300"
              autofocus
              data-testid="product-name"
              @input="nameMissing = false"
            />
            <span v-if="nameMissing" class="field-error" role="alert">{{ $t('products.nameMissing') }}</span></label
          >
          <label class="field"
            ><span class="field-label">{{ $t('products.sku') }}</span
            ><input v-model="form.sku" class="input" maxlength="100" data-testid="product-sku"
          /></label>
          <label class="field"
            ><span class="field-label">{{ $t('products.category') }}</span
            ><input
              v-model="form.category"
              class="input"
              maxlength="100"
              list="product-categories"
              data-testid="product-cat"
            />
            <datalist id="product-categories">
              <option v-for="c in categories" :key="c.value" :value="c.value" />
            </datalist>
          </label>
          <label class="field"
            ><span class="field-label">{{ $t('products.price') }}</span
            ><input
              v-model.number="form.price"
              class="input"
              type="number"
              min="0"
              step="any"
              data-testid="product-price"
          /></label>
          <label class="field"
            ><span class="field-label">{{ $t('products.currency') }}</span>
            <select v-model="form.currency" class="select">
              <option v-for="c in api.CURRENCIES" :key="c" :value="c">{{ c }}</option>
              <option v-if="!(api.CURRENCIES as readonly string[]).includes(form.currency)" :value="form.currency">
                {{ form.currency }}
              </option>
            </select>
          </label>
          <label class="field"
            ><span class="field-label">{{ $t('products.unit') }}</span
            ><input v-model="form.unit" class="input" maxlength="30" placeholder="pcs"
          /></label>
          <label class="field"
            ><span class="field-label">{{ $t('products.moq') }}</span
            ><input v-model.number="form.moq" class="input" type="number" min="0" step="1" data-testid="product-moq"
          /></label>
          <label class="field"
            ><span class="field-label">{{ $t('products.hsCode') }}</span
            ><input v-model="form.hsCode" class="input" maxlength="20" placeholder="8481.80"
          /></label>
          <label class="field span-all"
            ><span class="field-label">{{ $t('products.spec') }}</span
            ><textarea v-model="form.spec" class="textarea" rows="3" maxlength="5000"></textarea>
          </label>
        </div>
        <p class="hint">{{ $t('products.priceHint') }}</p>
        <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showForm = false">{{ $t('products.cancel') }}</button>
        <button type="submit" form="product-form" class="kbtn primary" :disabled="saving" data-testid="product-save">
          {{ saving ? $t('products.saving') : $t('products.save') }}
        </button>
      </template>
    </UiModal>

    <UiModal v-if="showImport" :title="$t('products.importTitle')" :width="520" @close="showImport = false">
      <div class="stack">
        <p class="hint">{{ $t('products.importHint') }}</p>
        <FilePick accept=".csv,text/csv" :file-name="importFile" testid="product-import-file" @change="onFile" />
        <p v-if="importRows.length && !importResult" class="hint">
          {{ $t('products.importReady', [importRows.length]) }}
        </p>
        <fieldset class="dup-mode">
          <legend class="field-label">{{ $t('products.importDup') }}</legend>
          <label class="check"
            ><input v-model="onDuplicate" type="radio" value="update" /> {{ $t('products.importUpdate') }}</label
          >
          <label class="check"
            ><input v-model="onDuplicate" type="radio" value="skip" /> {{ $t('products.importSkip') }}</label
          >
        </fieldset>
        <p v-if="importError" class="field-error" role="alert">{{ importError }}</p>
        <div v-if="importResult" class="import-result" role="status" data-testid="product-import-result">
          <p>
            {{ $t('products.importDone', [importResult.created, importResult.updated, importResult.skipped]) }}
          </p>
          <ul v-if="importResult.errors.length" class="import-errors">
            <li v-for="e in importResult.errors.slice(0, 20)" :key="e.row">
              {{ $t('products.importRowError', [e.row, e.message]) }}
            </li>
          </ul>
        </div>
      </div>
      <template #footer>
        <button type="button" class="kbtn" @click="showImport = false">
          {{ importResult ? $t('products.close') : $t('products.cancel') }}
        </button>
        <button
          v-if="!importResult"
          type="button"
          class="kbtn primary"
          :disabled="!importRows.length || importing"
          data-testid="product-import-run"
          @click="runImport"
        >
          {{ importing ? $t('products.importing') : $t('products.importRun') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.head-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.page-h {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.head-count {
  font-size: 12.5px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
.table-wrap {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: auto;
}
.mono {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.strong {
  font-weight: 500;
}
.clip {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.acts {
  white-space: nowrap;
  text-align: right;
}
.acts .link + .link {
  margin-left: 10px;
}
.link.danger {
  color: var(--danger-text);
}
.nav-row.sub {
  padding-left: 22px;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}
.dup-mode {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}
.dup-mode .check {
  font-size: 13px;
}
.import-result p {
  margin: 0 0 6px;
}
.import-errors {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--danger-text);
}
</style>
