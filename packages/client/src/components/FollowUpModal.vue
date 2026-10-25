<script setup lang="ts">
import { onMounted, ref } from 'vue'
import * as api from '../api'
import UiModal from './ui/UiModal.vue'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'

/** 安排跟进：新建一条跟进任务（POST /api/tasks）。客户页传 customerId 时客户固定。 */
const props = withDefaults(defineProps<{ customerId?: string; customerName?: string; title?: string }>(), {
  customerId: '',
  customerName: '',
  title: '',
})
const emit = defineEmits<{ close: []; created: [task: api.Task] }>()

function tomorrowAt10(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(10, 0, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const form = ref({ title: props.title, customerId: props.customerId, due: tomorrowAt10(), notes: '' })
const customers = ref<api.Customer[]>([])
const saving = ref(false)
const tried = ref(false)

onMounted(async () => {
  if (props.customerId) return
  try {
    customers.value = (await api.listCustomers({ pageSize: 200 })).items
  } catch {
    customers.value = []
  }
})

async function submit(): Promise<void> {
  tried.value = true
  if (!form.value.title.trim()) return
  saving.value = true
  try {
    const due = form.value.due ? new Date(form.value.due).getTime() : null
    const task = await api.tasksApi.create({
      title: form.value.title.trim(),
      notes: form.value.notes.trim(),
      customerId: form.value.customerId || null,
      dueAt: due && Number.isFinite(due) ? due : null,
    })
    toast.success(t('wbx.followCreated'))
    emit('created', task)
    emit('close')
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiModal :title="$t('wbx.followTitle')" :subtitle="customerName || ''" :width="480" @close="emit('close')">
    <form id="follow-form" class="stack" novalidate @submit.prevent="submit">
      <label class="field">
        <span class="field-label">{{ $t('wbx.followWhat') }}</span>
        <input
          v-model="form.title"
          class="input"
          name="title"
          maxlength="300"
          :placeholder="$t('wbx.followWhatPh')"
          autofocus
        />
        <span v-if="tried && !form.title.trim()" class="field-error">{{ $t('wbx.followWhatReq') }}</span>
      </label>
      <label v-if="!customerId" class="field">
        <span class="field-label">{{ $t('wbx.followCustomer') }}</span>
        <select v-model="form.customerId" class="select" name="customer">
          <option value="">{{ $t('wbx.followNoCustomer') }}</option>
          <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.company }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{{ $t('wbx.followDue') }}</span>
        <input v-model="form.due" class="input" type="datetime-local" name="due" />
      </label>
      <label class="field">
        <span class="field-label">{{ $t('wbx.followNotes') }}</span>
        <textarea v-model="form.notes" class="textarea" rows="3" maxlength="5000" name="notes"></textarea>
      </label>
    </form>
    <template #footer>
      <button type="button" class="kbtn" @click="emit('close')">{{ $t('crm.cancel') }}</button>
      <button type="submit" form="follow-form" class="kbtn primary" :disabled="saving">
        {{ saving ? $t('crm.saving') : $t('crm.save') }}
      </button>
    </template>
  </UiModal>
</template>
