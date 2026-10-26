import { browserControl } from '../browser/control.js'
import { computerControl } from '../computer/control.js'
import { sessionService } from '../session-service.js'
import { clearSessionAllow } from '../tool-approval.js'
import { activeRun } from './run-registry.js'

/**
 * 删除会话（解散群聊）的完整流程：先停掉进行中的运行（最多等 3 秒，避免它继续往已删除的会话里写），
 * 再删库（消息级联、工作区与内核 HOME 一并删除、推送 session.removed），最后清掉内存里按会话保存的状态
 * （“本会话始终允许”、浏览器 / 电脑操作控制）。调用方负责权限校验。
 */
export async function deleteSessionFully(sessionId: string): Promise<boolean> {
  const run = activeRun(sessionId)
  if (run) {
    run.cancel('user')
    await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 3000).unref())])
  }
  if (!sessionService.remove(sessionId)) return false
  clearSessionAllow(sessionId)
  browserControl.forget(sessionId)
  computerControl.forget(sessionId)
  return true
}
