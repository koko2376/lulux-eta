import { schedulesApi, toAutomationEvent, type AutomationEvent } from '../api/workflows'
import { t } from '../i18n'
import { onServerEvent } from './events'
import { toast } from './ui'

/** 订阅工作流 / 定时任务的实时事件（workflow.run / workflow.node / schedule.run），返回取消函数 */
export function onAutomationEvent(handler: (event: AutomationEvent) => void): () => void {
  return onServerEvent('*', (raw) => {
    const event = toAutomationEvent(raw as { event: string; data: unknown })
    if (event) handler(event)
  })
}

/**
 * 定时任务跑完（schedule.run 成功 / 失败）时在任意页面弹一条提示；AppLayout 挂载时调用一次。
 * 事件里只有 scheduleId，名称静默取一次；取不到就用通用文案。
 */
export function startScheduleNotices(): () => void {
  return onAutomationEvent((ev) => {
    if (ev.type !== 'schedule.run' || (ev.status !== 'succeeded' && ev.status !== 'failed')) return
    const status = ev.status
    void schedulesApi
      .get(ev.scheduleId, true)
      .then(
        (s) => s.name,
        () => '',
      )
      .then((name) => {
        const label = name || t('schedule.title')
        if (status === 'failed') toast.error(t('schedule.noticeFailed', [label]))
        else toast.success(t('schedule.noticeDone', [label]))
      })
  })
}
