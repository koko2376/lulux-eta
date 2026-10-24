import type { ImapFlow } from 'imapflow'
import { db } from '../../db.js'
import { messageOf } from '../../errors.js'
import { onMemberStatusChange } from '../member-events.js'
import { settingsService } from '../settings-service.js'
import { accountRow, idleAccounts, openImap, publishAccount, type AccountRow } from './account-service.js'
import { isSyncing, syncAccount } from './message-service.js'

const TICK_MS = 60_000

/** 负责人账号已停用的邮箱不参与后台同步（账号重新启用后自动恢复）；本机模式没有 users 记录，不受影响 */
const ACTIVE_OWNER = 'owner_id NOT IN (SELECT id FROM users WHERE disabled = 1)'

/**
 * 后台同步（契约 4.2）：每分钟检查一次，按 emailSyncIntervalMinutes 增量同步启用了同步的账户；
 * emailUseIdle='1' 时为每个账户保持一条 INBOX IDLE 连接，有新邮件立即触发增量同步。
 */
class EmailScheduler {
  private timer: NodeJS.Timeout | null = null
  private idleClients = new Map<string, ImapFlow>()
  private stopped = true

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    setTimeout(() => void this.tick(), 5_000).unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const [id, client] of this.idleClients) {
      client.close()
      idleAccounts.delete(id)
    }
    this.idleClients.clear()
  }

  /** 立即关闭某个负责人名下邮箱的 IDLE 连接（账号停用时调用，不必等下一轮 tick） */
  closeIdleForOwner(ownerId: string): void {
    const ids = (db.prepare('SELECT id FROM email_accounts WHERE owner_id = ?').all(ownerId) as Array<{ id: string }>).map((row) => row.id)
    for (const id of ids) {
      const client = this.idleClients.get(id)
      if (!client) continue
      client.close()
      this.idleClients.delete(id)
      idleAccounts.delete(id)
    }
  }

  dueAccounts(): AccountRow[] {
    const minutes = Number.parseInt(settingsService.get('emailSyncIntervalMinutes') ?? '5', 10)
    if (!Number.isFinite(minutes) || minutes <= 0) return []
    const threshold = Date.now() - minutes * 60_000
    return db
      .prepare(
        `SELECT * FROM email_accounts WHERE sync_enabled = 1 AND state NOT IN ('needs_reauth', 'syncing')
         AND (last_sync_at IS NULL OR last_sync_at <= ?) AND ${ACTIVE_OWNER}`,
      )
      .all(threshold) as unknown as AccountRow[]
  }

  async tick(): Promise<void> {
    if (this.stopped) return
    for (const account of this.dueAccounts()) {
      if (isSyncing(account.id)) continue
      await syncAccount(account.id).catch((error) => console.warn(`[lulux-eta] 后台同步 ${account.email} 失败：`, messageOf(error)))
    }
    await this.reconcileIdle()
  }

  private async reconcileIdle(): Promise<void> {
    const wanted =
      settingsService.get('emailUseIdle') === '1'
        ? new Set(
            (
              db
                .prepare(`SELECT id FROM email_accounts WHERE sync_enabled = 1 AND state <> 'needs_reauth' AND ${ACTIVE_OWNER}`)
                .all() as Array<{ id: string }>
            ).map(
              (row) => row.id,
            ),
          )
        : new Set<string>()
    for (const [id, client] of this.idleClients) {
      if (!wanted.has(id)) {
        client.close()
        this.idleClients.delete(id)
        idleAccounts.delete(id)
      }
    }
    for (const id of wanted) {
      if (this.idleClients.has(id) || this.stopped) continue
      const row = accountRow(id)
      if (!row) continue
      try {
        const client = await openImap(row)
        await client.mailboxOpen(row.inbox_path, { readOnly: true })
        client.on('exists', () => {
          void syncAccount(id).catch((error) => console.warn('[lulux-eta] IDLE 触发同步失败：', messageOf(error)))
        })
        client.on('close', () => {
          this.idleClients.delete(id)
          idleAccounts.delete(id)
          const fresh = accountRow(id)
          if (fresh) publishAccount(fresh)
        })
        this.idleClients.set(id, client)
        idleAccounts.add(id)
        publishAccount(row)
        void client.idle().catch(() => client.close())
      } catch (error) {
        console.warn(`[lulux-eta] IDLE 连接 ${row.email} 失败：`, messageOf(error))
      }
    }
  }
}

export const emailScheduler = new EmailScheduler()

onMemberStatusChange((userId, disabled) => {
  if (disabled) emailScheduler.closeIdleForOwner(userId)
})
