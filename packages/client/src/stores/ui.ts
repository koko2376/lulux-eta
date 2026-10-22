import { reactive } from 'vue'
import { ApiError } from '../api/http'
import { t, withParen } from '../i18n'

/** 全局 toast 与二次确认框。不依赖 Pinia，任何模块都能直接调用。 */

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  /** 出错请求的 X-Request-Id，toast 里可复制 */
  requestId?: string
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmText: string
  danger: boolean
  /** 需要用户输入这段文字才能确认（高危操作） */
  typeToConfirm?: string
  resolve: (ok: boolean) => void
}

export const uiState = reactive({
  toasts: [] as Toast[],
  confirm: null as ConfirmRequest | null,
})

let seq = 0

export function pushToast(
  kind: ToastKind,
  message: string,
  timeout = kind === 'error' ? 6000 : 3200,
  requestId = '',
): number {
  // 同一条错误短时间内重复出现时只保留一条
  const existing = uiState.toasts.find((t) => t.kind === kind && t.message === message)
  if (existing) return existing.id
  const id = ++seq
  uiState.toasts.push(requestId ? { id, kind, message, requestId } : { id, kind, message })
  if (uiState.toasts.length > 4) uiState.toasts.shift()
  window.setTimeout(() => dismissToast(id), timeout)
  return id
}

export function dismissToast(id: number): void {
  const index = uiState.toasts.findIndex((t) => t.id === id)
  if (index >= 0) uiState.toasts.splice(index, 1)
}

export const toast = {
  info: (message: string) => pushToast('info', message),
  success: (message: string) => pushToast('success', message),
  error: (message: string, requestId = '') => pushToast('error', message, requestId ? 9000 : 6000, requestId),
}

export function confirmDialog(options: {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  typeToConfirm?: string
}): Promise<boolean> {
  uiState.confirm?.resolve(false)
  return new Promise((resolve) => {
    uiState.confirm = {
      title: options.title,
      message: options.message,
      confirmText: options.confirmText ?? t('storeUi.k1w0qzyx'),
      danger: options.danger ?? false,
      typeToConfirm: options.typeToConfirm,
      resolve: (ok) => {
        uiState.confirm = null
        resolve(ok)
      },
    }
  })
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const requestId = error instanceof ApiError ? error.requestId : ''
  return requestId ? withParen(message, t('toastHost.requestId', [requestId])) : message
}

/** 调用方自己处理的错误（silent 请求）也带上 X-Request-Id 弹出 */
export function toastError(error: unknown): void {
  pushToast(
    'error',
    error instanceof Error ? error.message : String(error),
    9000,
    error instanceof ApiError ? error.requestId : '',
  )
}
