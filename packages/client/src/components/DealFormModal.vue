<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import { t } from '../i18n'
import { DEAL_STAGE_LABEL, DEFAULT_PROBABILITY, parseAmount } from '../lib/crm'
import { toastError } from '../stores/ui'
import UiModal from './ui/UiModal.vue'

/**
 * 新建 / 编辑商机（契约 §10.7）。
 * - 阶段为“输单”时必须填输单原因（服务端 400 LOST_REASON_REQUIRED，这里先拦住）
 * - 赢单 / 输单概率固定 100 / 0；其余阶段留空则用阶段默认概率
 */
const props = defineProps<{
  deal?: api.Deal | null
  customerId?: string
  customerName?: string
  /** 打开时预选的阶段（看板上从某列直接新建） */
  stage?: api.DealStage
}>()
const emit = defineEmits<{ close: []; saved: [deal: api.Deal] }>()

const editing = computed(() => Boolean(props.deal))
const form = reactive({
  customerId: props.deal?.customerId ?? props.customerId ?? '',
  title: props.deal?.title ?? '',
  amount: props.deal ? String(props.deal.amount) : '',
  currency: props.deal?.currency ?? 'USD',
  stage: (props.deal?.stage ?? props.stage ?? 'prospecting') as api.DealStage,
  probability: props.deal?.probabilityOverridden ? String(props.deal.probability) : '',
  expectedClose: props.deal?.expectedClose ?? '',
  wonReason: props.deal?.wonReason ?? '',
  lostReason: props.deal?.lostReason ?? '',
  notes: props.deal?.notes ?? '',
})
const saving = ref(false)
const tried = ref(false)

const closed = computed(() => form.stage === 'won' || form.stage === 'lost')
const amountValue = computed(() => (form.amount.trim() ? parseAmount(form.amount) : 0))
const probabilityValue = computed(() => (form.probability.trim() ? Number(form.probability) : null))
const errors = computed(() => ({
  customer: !form.customerId ? t('crm.errCustomer') : '',
  title: !form.title.trim() ? t('crm.errTitle') : '',
  amount: !Number.isFinite(amountValue.value) || amountValue.value < 0 ? t('crm.errAmount') : '',
  probability:
    probabilityValue.value !== null &&
    (!Number.isInteger(probabilityValue.value) || probabilityValue.value < 0 || probabilityValue.value > 100)
      ? t('crm.errProbability')
      : '',
  lostReason: form.stage === 'lost' && !form.lostReason.trim() ? t('crm.errLostReason') : '',
}))
const valid = computed(() => Object.values(errors.value).every((e) => !e))

/** 看板上新建时选客户：最多列 200 个（按最近更新） */
const customers = ref<api.Customer[]>([])
onMounted(async () => {
  if (props.deal || props.customerId) return
  try {
    customers.value = (await api.listCustomers({ pageSize: 200 })).items
  } catch {
    /* 全局 toast 已提示 */
  }
})

async function submit(): Promise<void> {
  tried.value = true
  if (!valid.value) return
  saving.value = true
  const body: api.DealInput = {
    title: form.title.trim(),
    amount: amountValue.value,
    currency: form.currency,
    stage: form.stage,
    expectedClose: form.expectedClose,
    notes: form.notes.trim(),
    wonReason: form.stage === 'won' ? form.wonReason.trim() : undefined,
    lostReason: form.stage === 'lost' ? form.lostReason.trim() : undefined,
  }
  if (!closed.value && probabilityValue.value !== null) body.probability = probabilityValue.value
  try {
    const saved = props.deal
      ? await api.dealsApi.update(props.deal.id, body, true)
      : await api.dealsApi.create({ ...body, customerId: form.customerId })
    emit('saved', saved)
  } catch (error) {
    toastError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiModal :title="editing ? $t('crm.editDeal') : $t('crm.newDeal')" :width="520" @close="emit('close')">
    <form id="deal-form" class="stack" novalidate @submit.prevent="submit">
      <label v-if="!editing && !customerId" class="field">
        <span class="field-label">{{ $t('crm.customer') }}</span>
        <select v-model="form.customerId" class="select" name="customer">
          <option value="" disabled>{{ $t('crm.pickCustomer') }}</option>
          <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.company }}</option>
        </select>
        <span v-if="tried && errors.customer" class="field-error">{{ errors.customer }}</span>
      </label>
      <label class="field">
        <span class="field-label">{{ $t('crm.dealTitle') }}</span>
        <input
          v-model="form.title"
          class="input"
          name="title"
          maxlength="200"
          :placeholder="$t('crm.dealTitlePh')"
          autofocus
        />
        <span v-if="tried && errors.title" class="field-error">{{ errors.title }}</span>
      </label>
      <div class="form-grid two">
        <label class="field">
          <span class="field-label">{{ $t('crm.amount') }}</span>
          <input v-model="form.amount" class="input num" name="amount" inputmode="decimal" placeholder="0" />
          <span v-if="tried && errors.amount" class="field-error">{{ errors.amount }}</span>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('crm.currency') }}</span>
          <select v-model="form.currency" class="select" name="currency">
            <option v-for="c in api.CURRENCIES" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('crm.stage') }}</span>
          <select v-model="form.stage" class="select" name="stage">
            <option v-for="s in api.DEAL_STAGES" :key="s" :value="s">{{ DEAL_STAGE_LABEL[s] }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('crm.probability') }}</span>
          <input
            v-model="form.probability"
            class="input num"
            name="probability"
            inputmode="numeric"
            :disabled="closed"
            :placeholder="$t('crm.probabilityPh', [DEFAULT_PROBABILITY[form.stage]])"
          />
          <span v-if="tried && errors.probability" class="field-error">{{ errors.probability }}</span>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('crm.expectedClose') }}</span>
          <input v-model="form.expectedClose" class="input" type="date" name="expectedClose" />
        </label>
      </div>
      <label v-if="form.stage === 'won'" class="field">
        <span class="field-label">{{ $t('crm.wonReason') }}</span>
        <input v-model="form.wonReason" class="input" name="wonReason" maxlength="500" />
      </label>
      <label v-if="form.stage === 'lost'" class="field">
        <span class="field-label">{{ $t('crm.lostReason') }} *</span>
        <textarea
          v-model="form.lostReason"
          class="textarea"
          name="lostReason"
          rows="2"
          maxlength="500"
          :placeholder="$t('crm.lostReasonPh')"
        ></textarea>
        <span v-if="tried && errors.lostReason" class="field-error">{{ errors.lostReason }}</span>
      </label>
      <label class="field">
        <span class="field-label">{{ $t('crm.notes') }}</span>
        <textarea v-model="form.notes" class="textarea" name="notes" rows="2" maxlength="2000"></textarea>
      </label>
    </form>
    <template #footer>
      <button type="button" class="kbtn" @click="emit('close')">{{ $t('crm.cancel') }}</button>
      <button type="submit" form="deal-form" class="kbtn primary" :disabled="saving">
        {{ saving ? $t('crm.saving') : $t('crm.save') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.form-grid.two {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 14px;
}
.num {
  font-variant-numeric: tabular-nums;
}
</style>
