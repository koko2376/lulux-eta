<script setup lang="ts">
import FilePick from '../components/ui/FilePick.vue'
import FieldError from '../components/ui/FieldError.vue'
import { useFieldErrors } from '../composables/useFieldErrors'
import PermNote from '../components/ui/PermNote.vue'
import { onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const templates = ref<api.QuoteTemplate[]>([])
const loading = ref(true)
const loadError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    templates.value = await api.listQuoteTemplates()
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const blank = (): Omit<api.QuoteTemplate, 'id'> => ({
  name: '',
  isDefault: templates.value.length === 0,
  company: { name: '', address: '', phone: '', email: '', logoDataUrl: '' },
  defaultIncoterm: 'FOB',
  defaultCurrency: 'USD',
  defaultPaymentTerms: '',
  footer: '',
})
const showForm = ref(false)
const editing = ref<api.QuoteTemplate | null>(null)
const form = reactive(blank())
const saving = ref(false)
const formError = ref('')

function openCreate(): void {
  editing.value = null
  Object.assign(form, blank())
  formError.value = ''
  showForm.value = true
}
function openEdit(t: api.QuoteTemplate): void {
  editing.value = t
  Object.assign(form, JSON.parse(JSON.stringify({ ...t, id: undefined })))
  formError.value = ''
  showForm.value = true
}

function onLogo(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type))
    return void (formError.value = t('settingsTemplates.k1vpj8pi'))
  if (file.size > 300 * 1024) return void (formError.value = t('settingsTemplates.klpuzeg'))
  const reader = new FileReader()
  reader.onload = () => {
    form.company.logoDataUrl = String(reader.result)
  }
  reader.readAsDataURL(file)
}

const fe = useFieldErrors<'name' | 'company'>('tpl-form')
async function save(): Promise<void> {
  formError.value = ''
  fe.clear()
  const a = fe.require({ name: form.name }, () => t('settingsTemplates.k1nw8seo'))
  const b = fe.require({ company: form.company.name }, () => t('settingsTemplates.k730fhd'))
  if (!a || !b) return
  saving.value = true
  try {
    const payload = JSON.parse(JSON.stringify(form)) as Omit<api.QuoteTemplate, 'id'> & { id?: string }
    delete payload.id
    if (editing.value) await api.updateQuoteTemplate(editing.value.id, payload)
    else await api.createQuoteTemplate(payload)
    showForm.value = false
    toast.success(t('settingsTemplates.k1uqvrw0'))
    await load()
  } catch (error) {
    formError.value = errorText(error)
  } finally {
    saving.value = false
  }
}

async function makeDefault(tpl: api.QuoteTemplate): Promise<void> {
  await api.updateQuoteTemplate(tpl.id, { isDefault: true })
  toast.success(t('settingsTemplates.k1bdsgv6', [tpl.name]))
  await load()
}

async function remove(tpl: api.QuoteTemplate): Promise<void> {
  if (
    !(await confirmDialog({
      title: t('settingsTemplates.kjkghn', [tpl.name]),
      message: t('settingsTemplates.kad3mep'),
      confirmText: t('settingsTemplates.kfcqesv'),
      danger: true,
    }))
  )
    return
  await api.deleteQuoteTemplate(tpl.id)
  toast.success(t('settingsTemplates.k1xqwrmq'))
  await load()
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsTemplates.kvleujt')" :sub="$t('settingsTemplates.k19mo6je')">
      <button v-perm="'settings:write'" type="button" class="kbtn primary" @click="openCreate">
        {{ $t('settingsTemplates.k19dk3rv') }}
      </button>
    </PageTopbar>
    <div class="doc">
      <div class="doc-inner">
        <PermNote perm="settings:write" :text="$t('settingsTemplates.kuydf9b')" />
        <section class="panel">
          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <StateBlock
            v-else-if="!templates.length"
            state="empty"
            :title="$t('settingsTemplates.k1wgm2ej')"
            :message="$t('settingsTemplates.ka15usi')"
            compact
          >
            <button v-perm="'settings:write'" type="button" class="kbtn primary" @click="openCreate">
              {{ $t('settingsTemplates.k19dk3rv') }}
            </button>
          </StateBlock>
          <div v-else>
            <div v-for="it in templates" :key="it.id" class="row-item">
              <img v-if="it.company.logoDataUrl" :src="it.company.logoDataUrl" alt="" class="tlogo" />
              <div class="grow">
                <div class="t">
                  {{ it.name }} <span v-if="it.isDefault" class="badge-on">{{ $t('settingsTemplates.k1jpvto9') }}</span>
                </div>
                <div class="d">
                  {{ it.company.name }} · {{ it.defaultIncoterm }} · {{ it.defaultCurrency
                  }}<template v-if="it.defaultPaymentTerms"> · {{ it.defaultPaymentTerms }}</template>
                </div>
              </div>
              <div class="panel-actions">
                <button
                  v-if="!it.isDefault"
                  v-perm="'settings:write'"
                  type="button"
                  class="kbtn sm"
                  @click="makeDefault(it)"
                >
                  {{ $t('settingsTemplates.kn5772y') }}
                </button>
                <button v-perm="'settings:write'" type="button" class="kbtn sm" @click="openEdit(it)">
                  {{ $t('settingsTemplates.k1alsnuo') }}
                </button>
                <button v-perm="'settings:write'" type="button" class="kbtn sm danger" @click="remove(it)">
                  {{ $t('settingsTemplates.kfcqesv') }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <UiModal
      v-if="showForm"
      :title="editing ? $t('settingsTemplates.k1w6ejfr') : $t('settingsTemplates.k19dk3rv')"
      :width="640"
      @close="showForm = false"
    >
      <form id="tpl-form" class="form-grid" novalidate @submit.prevent="save">
        <label class="field span-all"
          ><span class="field-label">{{ $t('settingsTemplates.k1g3kvyo') }}</span
          ><input
            v-model="form.name"
            class="input"
            :class="{ invalid: fe.errors.name }"
            data-field="name"
            required
            maxlength="60"
            @input="fe.clear('name')" />
          <FieldError :msg="fe.errors.name"
        /></label>
        <label class="field span-2"
          ><span class="field-label">{{ $t('settingsTemplates.k1p2f9q9') }}</span
          ><input
            v-model="form.company.name"
            class="input"
            :class="{ invalid: fe.errors.company }"
            data-field="company"
            required
            @input="fe.clear('company')" />
          <FieldError :msg="fe.errors.company"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsTemplates.k1vld1sy') }}</span
          ><input v-model="form.company.phone" class="input"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsTemplates.k182knuk') }}</span
          ><input v-model="form.company.email" class="input" type="email"
        /></label>
        <label class="field span-all"
          ><span class="field-label">{{ $t('settingsTemplates.kst2c9j') }}</span
          ><input v-model="form.company.address" class="input"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsTemplates.kqijgpo') }}</span>
          <select v-model="form.defaultIncoterm" class="select">
            <option v-for="it in api.INCOTERMS" :key="it">{{ it }}</option>
          </select>
        </label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsTemplates.k1p8679o') }}</span>
          <select v-model="form.defaultCurrency" class="select">
            <option v-for="c in api.CURRENCIES" :key="c">{{ c }}</option>
          </select>
        </label>
        <label class="field span-all"
          ><span class="field-label">{{ $t('settingsTemplates.k1tmf054') }}</span
          ><input v-model="form.defaultPaymentTerms" class="input" placeholder="30% T/T deposit, 70% against B/L copy"
        /></label>
        <label class="field span-all"
          ><span class="field-label">{{ $t('settingsTemplates.k1m2t0et') }}</span
          ><textarea v-model="form.footer" class="textarea" rows="2"></textarea>
        </label>
        <div class="field span-all">
          <span class="field-label">{{ $t('settingsTemplates.k17zkgul') }}</span>
          <div class="hstack">
            <img
              v-if="form.company.logoDataUrl"
              :src="form.company.logoDataUrl"
              :alt="$t('settingsTemplates.kfsn5xn')"
              class="tlogo"
            />
            <FilePick
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              :label="$t('settingsTemplates.k8xze7n')"
              @change="onLogo"
            />
            <button
              v-if="form.company.logoDataUrl"
              type="button"
              class="kbtn sm"
              @click="form.company.logoDataUrl = ''"
            >
              {{ $t('settingsTemplates.kd61i4g') }}
            </button>
          </div>
        </div>
        <label class="check span-all"
          ><input v-model="form.isDefault" type="checkbox" /> {{ $t('settingsTemplates.ky02ud') }}</label
        >
        <p v-if="formError" class="field-error span-all" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showForm = false">{{ $t('settingsTemplates.kldkknc') }}</button>
        <button type="submit" form="tpl-form" class="kbtn primary" :disabled="saving">
          {{ saving ? $t('settingsTemplates.ksdjf4x') : $t('settingsTemplates.k1xlvxln') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.tlogo {
  width: 40px;
  height: 40px;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}
</style>
