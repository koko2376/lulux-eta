import { ref } from 'vue'
import * as api from '../api'
import { t } from '../i18n'
import { DEAL_STAGE_LABEL } from '../lib/crm'
import { toast, toastError } from '../stores/ui'

/**
 * 改商机阶段：普通阶段直接 PATCH；“输单”先弹原因框，确认后带 lostReason 提交。
 * onChanged 拿到服务端返回的新商机（概率 / 加权金额由服务端算）。
 */
export function useDealStage(onChanged: (deal: api.Deal) => void) {
  const lostFor = ref<api.Deal | null>(null)
  const busy = ref(false)

  async function patch(deal: api.Deal, body: api.DealInput): Promise<boolean> {
    busy.value = true
    try {
      const next = await api.dealsApi.update(deal.id, body, true)
      onChanged(next)
      toast.success(t('crm.stageChanged', [next.title, DEAL_STAGE_LABEL[next.stage]]))
      return true
    } catch (error) {
      toastError(error)
      return false
    } finally {
      busy.value = false
    }
  }

  async function change(deal: api.Deal, stage: api.DealStage): Promise<void> {
    if (stage === deal.stage) return
    if (stage === 'lost') {
      lostFor.value = deal
      return
    }
    await patch(deal, { stage })
  }

  async function confirmLost(reason: string): Promise<void> {
    const deal = lostFor.value
    if (!deal) return
    if (await patch(deal, { stage: 'lost', lostReason: reason })) lostFor.value = null
  }

  return { lostFor, busy, change, confirmLost }
}
