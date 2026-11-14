/**
 * 邮箱计数变化通知：邮箱页改了判定 / 复核 / 已读等之后广播，全局侧栏据此立即刷新未读角标，
 * 不用等 60 秒定时或窗口焦点。只在本窗口内传播。
 */
export const MAIL_COUNTS_EVENT = 'lulux:mail-counts-changed'

export function notifyMailCountsChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(MAIL_COUNTS_EVENT))
}

export function onMailCountsChanged(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener(MAIL_COUNTS_EVENT, handler)
  return () => window.removeEventListener(MAIL_COUNTS_EVENT, handler)
}
