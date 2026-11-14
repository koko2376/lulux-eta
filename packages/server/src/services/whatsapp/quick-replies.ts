import { db } from '../../db.js'
import { AppError } from '../../errors.js'
import { newId } from '../../utils/id.js'

/** WhatsApp 快捷回复：每个人自己的常用回复片段（报价确认、交期说明…），会话里一键填入输入框 */
export interface WhatsAppQuickReply {
  id: string
  title: string
  body: string
  position: number
  createdAt: number
  updatedAt: number
}

interface Row {
  id: string
  title: string
  body: string
  position: number
  created_at: number
  updated_at: number
}

export const QUICK_REPLY_LIMIT = 50

function map(row: Row): WhatsAppQuickReply {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    position: Number(row.position),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function listQuickReplies(ownerId: string): WhatsAppQuickReply[] {
  const rows = db
    .prepare('SELECT * FROM whatsapp_quick_replies WHERE owner_id = ? ORDER BY position, created_at')
    .all(ownerId) as unknown as Row[]
  return rows.map(map)
}

function requireOwn(ownerId: string, id: string): Row {
  const row = db.prepare('SELECT * FROM whatsapp_quick_replies WHERE id = ? AND owner_id = ?').get(id, ownerId) as
    | Row
    | undefined
  if (!row) throw new AppError(404, 'WHATSAPP_QUICK_REPLY_NOT_FOUND', '快捷回复不存在')
  return row
}

export function createQuickReply(ownerId: string, orgId: string, input: { title: string; body: string }): WhatsAppQuickReply {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM whatsapp_quick_replies WHERE owner_id = ?').get(ownerId) as { n: number }).n
  if (Number(count) >= QUICK_REPLY_LIMIT) {
    throw new AppError(409, 'WHATSAPP_QUICK_REPLY_LIMIT', '快捷回复最多 50 条')
  }
  const now = Date.now()
  const id = newId('waq')
  db.prepare(
    `INSERT INTO whatsapp_quick_replies (id, owner_id, org_id, title, body, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, orgId, input.title, input.body, Number(count), now, now)
  return map(requireOwn(ownerId, id))
}

export function updateQuickReply(ownerId: string, id: string, patch: { title?: string; body?: string }): WhatsAppQuickReply {
  const row = requireOwn(ownerId, id)
  db.prepare('UPDATE whatsapp_quick_replies SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(
    patch.title ?? row.title,
    patch.body ?? row.body,
    Date.now(),
    id,
  )
  return map(requireOwn(ownerId, id))
}

export function deleteQuickReply(ownerId: string, id: string): void {
  requireOwn(ownerId, id)
  db.prepare('DELETE FROM whatsapp_quick_replies WHERE id = ?').run(id)
}
