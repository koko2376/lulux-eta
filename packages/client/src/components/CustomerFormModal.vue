<script setup lang="ts">
import { reactive, ref } from 'vue'
import * as api from '../api'
import { STAGE_LABEL } from '../lib/labels'
import { errorText } from '../stores/ui'
import UiModal from './ui/UiModal.vue'
import CustomerDuplicateNotice from './CustomerDuplicateNotice.vue'
import { t } from '../i18n'

const props = defineProps<{ customer?: api.Customer | null }>()
const emit = defineEmits<{ close: []; saved: [customer: api.Customer] }>()

type ContactDraft = Omit<api.Contact, 'id'> & { id?: string }
const blankContact = (primary = false): ContactDraft => ({
  name: '',
  title: '',
  email: '',
  phone: '',
  whatsapp: '',
  isPrimary: primary,
})

const c = props.customer
const form = reactive({
  company: c?.company ?? '',
  country: c?.country ?? '',
  website: c?.website ?? '',
  stage: (c?.stage ?? 'lead') as api.Stage,
  tagsText: (c?.tags ?? []).join(', '),
  source: c?.source ?? '',
  notes: c?.notes ?? '',
  contacts: c?.contacts?.length ? c.contacts.map((x) => ({ ...x })) : [blankContact(true)],
})
const saving = ref(false)
const error = ref('')
/** 新建时查重命中的已有客户（409 CUSTOMER_DUPLICATE），用户可返回修改或仍然创建 */
const duplicates = ref<api.CustomerDuplicate[] | null>(null)
/** 公司名必填：在字段下方提示（不用浏览器原生气泡，和其它表单一致） */
const companyMissing = ref(false)
const companyInput = ref<HTMLInputElement | null>(null)

function setPrimary(index: number): void {
  form.contacts.forEach((x, i) => (x.isPrimary = i === index))
}
function removeContact(index: number): void {
  const wasPrimary = form.contacts[index].isPrimary
  form.contacts.splice(index, 1)
  if (wasPrimary && form.contacts[0]) form.contacts[0].isPrimary = true
}

async function save(force = false): Promise<void> {
  error.value = ''
  duplicates.value = null
  companyMissing.value = !form.company.trim()
  if (companyMissing.value) {
    companyInput.value?.focus()
    return
  }
  const contacts = form.contacts.filter((x) => x.name.trim() || x.email.trim() || x.phone.trim())
  for (const x of contacts) {
    if (x.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email.trim()))
      return void (error.value = t('customerFormModal.k1d7qiwa', [x.email]))
  }
  if (contacts.length && !contacts.some((x) => x.isPrimary)) contacts[0].isPrimary = true
  const input: api.CustomerInput = {
    company: form.company.trim(),
    country: form.country.trim(),
    website: form.website.trim(),
    stage: form.stage,
    tags: Array.from(
      new Set(
        form.tagsText
          .split(/[,，;；]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ),
    source: form.source.trim(),
    notes: form.notes.trim(),
    contacts: contacts.map((x) => ({
      ...x,
      name: x.name.trim(),
      email: x.email.trim(),
      phone: x.phone.trim(),
      whatsapp: x.whatsapp.trim(),
      title: x.title.trim(),
    })),
  }
  saving.value = true
  try {
    const saved = props.customer
      ? await api.updateCustomer(props.customer.id, input)
      : await api.createCustomer(input, { force })
    emit('saved', saved)
  } catch (value) {
    const found = api.customerDuplicatesOf(value)
    if (found) duplicates.value = found
    else error.value = errorText(value)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiModal
    :title="customer ? $t('customerFormModal.kx7a9rd') : $t('customerFormModal.kr9abat')"
    :width="680"
    @close="emit('close')"
  >
    <form id="customer-form" class="stack" novalidate @submit.prevent="save()">
      <div class="form-grid">
        <label class="field span-2"
          ><span class="field-label">{{ $t('customerFormModal.k10wyfer') }}</span
          ><input
            ref="companyInput"
            v-model="form.company"
            class="input"
            :class="{ invalid: companyMissing }"
            required
            :aria-invalid="companyMissing || undefined"
            maxlength="120"
            autofocus
            @input="companyMissing = false"
          />
          <span v-if="companyMissing" class="field-error" role="alert">{{
            $t('customerFormModal.k730fhd')
          }}</span></label
        >
        <label class="field"
          ><span class="field-label">{{ $t('customerFormModal.kl9iz6y') }}</span>
          <select v-model="form.stage" class="select">
            <option v-for="s in api.STAGES" :key="s" :value="s">{{ STAGE_LABEL[s] }}</option>
          </select>
        </label>
        <label class="field"
          ><span class="field-label">{{ $t('customerFormModal.k1lky7ue') }}</span
          ><input v-model="form.country" class="input"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('customerFormModal.k14bpx7p') }}</span
          ><input v-model="form.website" class="input" placeholder="example.com"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('customerFormModal.k1j08rmu') }}</span
          ><input v-model="form.source" class="input" :placeholder="$t('customerFormModal.k1ta196h')"
        /></label>
        <label class="field span-all"
          ><span class="field-label">{{ $t('customerFormModal.kxcs0u1') }}</span
          ><input v-model="form.tagsText" class="input" :placeholder="$t('customerFormModal.k18gxwy7')"
        /></label>
        <label class="field span-all"
          ><span class="field-label">{{ $t('customerFormModal.k1q7l0g0') }}</span
          ><textarea v-model="form.notes" class="textarea" rows="2"></textarea>
        </label>
      </div>

      <fieldset class="contacts">
        <legend class="field-label">{{ $t('customerFormModal.ka12e6j') }}</legend>
        <div v-for="(x, i) in form.contacts" :key="i" class="contact">
          <input
            v-model="x.name"
            class="input"
            :placeholder="$t('customerFormModal.k1gsttee')"
            :aria-label="$t('customerFormModal.k1mhkfa4', [i + 1])"
          />
          <input
            v-model="x.title"
            class="input"
            :placeholder="$t('customerFormModal.k194rv4g')"
            :aria-label="$t('customerFormModal.k1li4rlt', [i + 1])"
          />
          <input
            v-model="x.email"
            class="input"
            type="email"
            :placeholder="$t('customerFormModal.k182knuk')"
            :aria-label="$t('customerFormModal.kw8zm51', [i + 1])"
          />
          <input
            v-model="x.phone"
            class="input"
            :placeholder="$t('customerFormModal.k1vld1sy')"
            :aria-label="$t('customerFormModal.kmj79lf', [i + 1])"
          />
          <input
            v-model="x.whatsapp"
            class="input"
            placeholder="WhatsApp"
            :aria-label="$t('customerFormModal.k1oekr61', [i + 1])"
          />
          <div class="contact-acts">
            <label class="check"
              ><input type="radio" name="primary" :checked="x.isPrimary" @change="setPrimary(i)" />
              {{ $t('customerFormModal.k16lure5') }}</label
            >
            <button
              type="button"
              class="kbtn sm ghost"
              :aria-label="$t('customerFormModal.k6kjr6c', [i + 1])"
              @click="removeContact(i)"
            >
              {{ $t('customerFormModal.kfcqesv') }}
            </button>
          </div>
        </div>
        <button type="button" class="kbtn sm" @click="form.contacts.push(blankContact(form.contacts.length === 0))">
          {{ $t('customerFormModal.k1b6bcsb') }}
        </button>
      </fieldset>
      <CustomerDuplicateNotice
        v-if="duplicates"
        :duplicates="duplicates"
        :busy="saving"
        @back="duplicates = null"
        @force="save(true)"
      />
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" class="kbtn" @click="emit('close')">{{ $t('customerFormModal.kldkknc') }}</button>
      <button type="submit" form="customer-form" class="kbtn primary" :disabled="saving">
        {{ saving ? $t('customerFormModal.ksdjf4x') : $t('customerFormModal.k1xlvxln') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.contacts {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.contact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  width: 100%;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.contact-acts {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.contact-acts .check {
  font-size: 12px;
  white-space: nowrap;
}
</style>
