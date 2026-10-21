/**
 * 成员停用 / 启用事件。独立成没有依赖的小模块，供账号、邮箱同步、定时任务等模块互相通知而不形成循环引用。
 */
export type MemberStatusListener = (userId: string, disabled: boolean) => void

const listeners = new Set<MemberStatusListener>()

export function onMemberStatusChange(listener: MemberStatusListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitMemberStatus(userId: string, disabled: boolean): void {
  for (const listener of listeners) {
    try {
      listener(userId, disabled)
    } catch (error) {
      console.warn('[lulux-eta] member status listener failed:', error instanceof Error ? error.message : String(error))
    }
  }
}
