import { reactive } from 'vue'
import { ApiError, getLock } from '../api'

/**
 * 本机锁（契约 §3）。解锁状态只存在内存里：重启应用 / 刷新页面后需要重新输入 PIN。
 * 服务端不支持 /api/lock（旧版本 404）时视为未启用。
 */
export const lockState = reactive({
  checked: false,
  enabled: false,
  unlocked: false,
  error: '',
})

export async function checkLock(force = false): Promise<void> {
  if (lockState.checked && !force) return
  try {
    const { enabled } = await getLock()
    lockState.enabled = Boolean(enabled)
    lockState.error = ''
  } catch (error) {
    lockState.enabled = false
    // 404：服务端尚未实现本机锁；网络错误：交给各页面的错误态展示
    lockState.error = error instanceof ApiError && error.status !== 404 ? error.message : ''
  }
  lockState.checked = true
}

export function markUnlocked(): void {
  lockState.unlocked = true
}

export function needsUnlock(): boolean {
  return lockState.enabled && !lockState.unlocked
}
