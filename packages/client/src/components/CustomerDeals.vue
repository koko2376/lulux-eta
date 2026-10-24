<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import * as api from '../api'
import { useDealStage } from '../composables/useDealStage'
import { t } from '../i18n'
import { trashConfirmMessage } from '../lib/trash'
import { DEAL_STAGE_LABEL } from '../lib/crm'
import { formatDate } from '../lib/labels'
import { formatMoney } from '../lib/quote'
import { confirmDialog, errorText, toast } from '../stores/ui'
import DealFormModal from './DealFormModal.vue'
import LostReasonModal from './LostReasonModal.vue'
import StateBlock from './ui/StateBlock.vue'

/** 客户详情页的商机区块（契约 §10.7）：列表、阶段切换（输单需原因）、新建 / 编辑 / 删除 */
const props = defineProps<{ customerId: string; customerName: string; canEdit: boolean }>()

const deals = ref<api.Deal[]>([])
const loading = ref(true)
const error = ref('')
const editing = ref<api.Deal | null>(null)
const creating = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    deals.value = (await api.dealsApi.list({ customerId: props.customerId, stage: 'all' })).items
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.customerId, load)

function upsert(deal: api.Deal): void {
  const i = deals.value.findIndex((d) => d.id === deal.id)
  if (i >= 0) deals.value.splice(i, 1, deal)
  else deals.value.unshift(deal)
}
const stage = useDealStage(upsert)

function onMove(event: Event, deal: api.Deal): void {
  const el = event.target as HTMLSelectElement
  const target = el.value as api.DealStage
  el.value = deal.stage
  void stage.change(deal, target)
}
function closeForm(): void {
  creating.value = false
  editing.value = null
}
function onSaved(deal: api.Deal): void {
  upsert(deal)
  toast.success(creating.value ? t('crm.dealCreated') : t('crm.dealSaved'))
  creating.value = false
  editing.value = null
}

async function remove(deal: api.Deal): Promise<void> {
  const ok = await confirmDialog({
    title: t('crm.deleteDealTitle', [deal.title]),
    message: trashConfirmMessage('crm.deleteDealMsg'),
    confirmText: t('crm.delete'),
    danger: true,
  })
  if (!ok) return
  await api.dealsApi.remove(deal.id)
  deals.value = deals.value.filter((d) => d.id !== deal.id)
  toast.success(t('crm.dealDeleted'))
}
</script>

<template>
  <section class="panel" data-testid="customer-deals">
    <div class="panel-head">
      <div class="txt">
        <h2 class="panel-title">{{ $t('crm.deals') }}</h2>
      </div>
      <RouterLink class="link" to="/deals">{{ $t('crm.board') }}</RouterLink>
      <button v-if="canEdit" type="button" class="kbtn sm" data-testid="new-deal" @click="creating = true">
        {{ $t('crm.newDeal') }}
      </button>
    </div>
    <StateBlock v-if="loading" state="loading" compact />
    <StateBlock v-else-if="error" state="error" :message="error" compact @retry="load" />
    <StateBlock
      v-else-if="!deals.length"
      state="empty"
      :title="$t('crm.noDeals')"
      :message="$t('crm.noDealsMsg')"
      compact
    />
    <ul v-else class="deal-list">
      <li v-for="d in deals" :key="d.id" class="deal-row" data-testid="deal-row">
        <div class="grow">
          <div class="t">
            <span class="title" :title="d.title">{{ d.title }}</span>
            <span v-if="d.overdue" class="badge-bad">{{ $t('crm.overdueClose') }}</span>
          </div>
          <div class="d">
            <span>{{ $t('crm.probShort', [d.probability]) }}</span>
            <span v-if="d.expectedClose">· {{ $t('crm.closeOn', [formatDate(d.expectedClose)]) }}</span>
            <span v-if="d.stage === 'lost' && d.lostReason" class="reason" :title="d.lostReason"
              >· {{ $t('crm.lostBecause', [d.lostReason]) }}</span
            >
          </div>
        </div>
        <div class="money">
          <b>{{ formatMoney(d.amount, d.currency) }}</b>
          <span v-if="d.stage !== 'won' && d.stage !== 'lost'" class="d">{{
            $t('crm.weightedShort', [formatMoney(d.weightedAmount, d.currency)])
          }}</span>
        </div>
        <select
          class="select sm stage-select"
          :class="`st-${d.stage}`"
          :value="d.stage"
          :disabled="!canEdit || stage.busy.value"
          :aria-label="$t('crm.stageOf', [d.title])"
          @change="onMove($event, d)"
        >
          <option v-for="s in api.DEAL_STAGES" :key="s" :value="s">{{ DEAL_STAGE_LABEL[s] }}</option>
        </select>
        <div v-if="canEdit" class="acts">
          <button
            type="button"
            class="icon-btn"
            :aria-label="$t('crm.edit')"
            :title="$t('crm.edit')"
            @click="editing = d"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 20h4L19 9l-4-4L4 16z" />
              <path d="m13.5 6.5 4 4" />
            </svg>
          </button>
          <button
            v-perm="['data:write', 'deal:delete']"
            type="button"
            class="icon-btn danger"
            :aria-label="$t('crm.delete')"
            :title="$t('crm.delete')"
            @click="remove(d)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
            </svg>
          </button>
        </div>
      </li>
    </ul>

    <DealFormModal
      v-if="creating || editing"
      :deal="editing"
      :customer-id="customerId"
      :customer-name="customerName"
      @close="closeForm"
      @saved="onSaved"
    />
    <LostReasonModal
      v-if="stage.lostFor.value"
      :title="stage.lostFor.value.title"
      :busy="stage.busy.value"
      @close="stage.lostFor.value = null"
      @confirm="stage.confirmLost"
    />
  </section>
</template>

<style scoped>
.panel-head {
  gap: 12px;
}
.deal-list {
  list-style: none;
  margin: 0;
  padding: 0 20px 8px;
}
.deal-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line);
}
.deal-row:first-child {
  border-top: 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
.t {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  min-width: 0;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.d {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  display: flex;
  gap: 4px;
  min-width: 0;
}
.reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.money {
  text-align: right;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.stage-select {
  width: auto;
  min-width: 96px;
}
.acts {
  display: flex;
  gap: 2px;
}
.icon-btn {
  width: 28px;
  height: 28px;
  border: 0;
  background: none;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  display: grid;
  place-items: center;
}
.icon-btn:hover,
.icon-btn:focus-visible {
  background: var(--surface-hover);
  color: var(--text);
}
.icon-btn.danger:hover {
  color: var(--danger-text);
}
.icon-btn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
