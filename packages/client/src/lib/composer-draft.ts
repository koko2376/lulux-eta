import type { BrowserCapture } from './browser-capture'
import type { RefContext } from './composer-context'
import { t } from '../i18n'

/** 输入框里的一个附件（上传到会话工作区；图片另作为消息附件发给能看图的模型） */
export interface ComposerAttachment {
  path: string
  name: string
  size: number
  status: 'uploading' | 'done' | 'error'
  error?: string
  /** 来自内置浏览器的框选 / 元素：截图即本附件，页面与元素信息发送时附在消息里 */
  capture?: BrowserCapture
  /** 图片（粘贴 / 拖放 / 选择）：作为消息的图片附件发送 */
  image?: boolean
  /** 缩略图（blob: / data: URL） */
  preview?: string
  mime?: string
  width?: number | null
  height?: number | null
}

/** 一个会话的输入框草稿：用户敲的原文、附件、一次性引用 */
export interface SessionDraft {
  text: string
  attachments: ComposerAttachment[]
  refs: RefContext[]
}

/** 退回输入框的草稿（请求没被接受 / 预填）：只填回它所属的会话 */
export interface ReturnedDraft extends SessionDraft {
  /** null = 还没有会话（新对话） */
  sessionId: string | null
  /** 预填（问 LULUX / 核价入口）：输入框已有内容时不填入 */
  prefill?: boolean
}

/** 草稿表里“还没有会话（新对话）”用的键 */
export const NO_SESSION_KEY = ''

export function draftKey(sessionId: string | null | undefined): string {
  return sessionId || NO_SESSION_KEY
}

export function emptyDraft(): SessionDraft {
  return { text: '', attachments: [], refs: [] }
}

export function isEmptyDraft(draft: SessionDraft | null | undefined): boolean {
  return !draft || (!draft.text.trim() && draft.attachments.length === 0 && draft.refs.length === 0)
}

/** 两份草稿合在一起（退回的草稿遇上已有草稿时都保留，不丢字） */
export function mergeDrafts(first: SessionDraft, second: SessionDraft): SessionDraft {
  const text = [first.text, second.text].filter((part) => part.trim()).join('\n')
  const paths = new Set(first.attachments.map((a) => a.path))
  const refKey = (r: RefContext): string => `${r.kind}:${r.id}`
  const refKeys = new Set(first.refs.map(refKey))
  return {
    text,
    attachments: [...first.attachments, ...second.attachments.filter((a) => !paths.has(a.path))],
    refs: [...first.refs, ...second.refs.filter((r) => !refKeys.has(refKey(r)))],
  }
}

/* ─────────────── 草稿落盘（localStorage，按账号 + 服务器作用域分 key） ─────────────── */

/** 落盘键前缀；真实 key 是 `<前缀>:<作用域 hash>`（见 lib/storage-scope.ts） */
export const DRAFTS_BASE_KEY = 'lulux.composerDrafts'
/** 单个账号的草稿总量上限：超出后先丢最久没动过的会话草稿 */
export const DRAFTS_BUDGET_BYTES = 1024 * 1024
/** 落盘格式版本：以后改结构时用来判断要不要迁移 */
export const DRAFTS_VERSION = 1

/** 落盘的草稿：附件只留元数据，多一个“最后一次改动时间”用来裁剪超预算的旧草稿 */
export interface StoredDraft extends SessionDraft {
  at: number
}

export interface DraftSnapshotEntry {
  /** draftKey(sessionId) */
  key: string
  draft: SessionDraft
  at: number
}

/**
 * 附件只留元数据（path / name / size / status / image / mime / width / height）：
 * - `preview` 是 blob: 或 data: URL，blob: 关窗即失效，data: 会把图片正文写进 localStorage（禁止）
 * - 框选截图的 `capture.image` 是 PNG data URL，同样不落盘，只留“来自哪个页面的哪个元素”
 */
export function stripAttachment(attachment: ComposerAttachment): ComposerAttachment {
  const { preview, capture, ...rest } = attachment
  void preview
  return capture ? { ...rest, capture: { ...capture, image: '' } } : rest
}

export function stripDraft(draft: SessionDraft): SessionDraft {
  return {
    text: draft.text,
    attachments: draft.attachments.map(stripAttachment),
    refs: draft.refs.map((ref) => ({ ...ref })),
  }
}

function byteSize(value: string): number {
  return typeof TextEncoder === 'undefined' ? value.length * 2 : new TextEncoder().encode(value).length
}

/**
 * 把草稿表打包成落盘 JSON：按最后改动时间从新到旧装，装不下的丢掉（返回 dropped 键）。
 * 宁可丢最老的草稿，也不让一次写入超限把整份草稿表写坏。
 */
export function packDrafts(
  entries: DraftSnapshotEntry[],
  budget = DRAFTS_BUDGET_BYTES,
): { raw: string; dropped: string[] } {
  const kept: Record<string, StoredDraft> = {}
  const dropped: string[] = []
  let used = 0
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const stored: StoredDraft = { ...stripDraft(entry.draft), at: entry.at }
    const size = byteSize(JSON.stringify(stored)) + byteSize(JSON.stringify(entry.key))
    if (used + size > budget) {
      dropped.push(entry.key)
      continue
    }
    used += size
    kept[entry.key] = stored
  }
  return { raw: JSON.stringify({ v: DRAFTS_VERSION, drafts: kept }), dropped }
}

const ATTACHMENT_STATUS = new Set(['uploading', 'done', 'error'])

function readAttachment(raw: unknown, lost: string): ComposerAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<ComposerAttachment>
  if (typeof item.path !== 'string' || !item.path) return null
  const status = typeof item.status === 'string' && ATTACHMENT_STATUS.has(item.status) ? item.status : 'error'
  return {
    path: item.path,
    name: typeof item.name === 'string' && item.name ? item.name : item.path.split('/').pop() || item.path,
    size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
    // 上传到一半就关窗的附件不会再有人接着传：标成失败，用户可以移除后照常发送
    status: status === 'uploading' ? 'error' : (status as ComposerAttachment['status']),
    ...(status === 'uploading' ? { error: lost } : item.error ? { error: item.error } : {}),
    ...(item.image ? { image: true } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    ...(typeof item.width === 'number' ? { width: item.width } : {}),
    ...(typeof item.height === 'number' ? { height: item.height } : {}),
    ...(item.capture && typeof item.capture === 'object' ? { capture: item.capture } : {}),
  }
}

function readRef(raw: unknown): RefContext | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<RefContext>
  if (typeof item.id !== 'string' || typeof item.kind !== 'string') return null
  return {
    kind: item.kind as RefContext['kind'],
    id: item.id,
    label: typeof item.label === 'string' ? item.label : item.id,
    summary: typeof item.summary === 'string' ? item.summary : '',
  }
}

/** 读出落盘的草稿表；坏数据、旧版本一律当空（不抛错，不影响打开应用） */
export function unpackDrafts(raw: string | null): Record<string, SessionDraft> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const data = parsed as { v?: number; drafts?: unknown }
  if (!data || typeof data !== 'object' || data.v !== DRAFTS_VERSION || !data.drafts) return {}
  const lost = t('composer.draftAttachmentLost')
  const out: Record<string, SessionDraft> = {}
  for (const [key, value] of Object.entries(data.drafts as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Partial<StoredDraft>
    const attachments = Array.isArray(item.attachments)
      ? item.attachments.map((a) => readAttachment(a, lost)).filter((a): a is ComposerAttachment => a !== null)
      : []
    const refs = Array.isArray(item.refs) ? item.refs.map(readRef).filter((r): r is RefContext => r !== null) : []
    const draft: SessionDraft = { text: typeof item.text === 'string' ? item.text : '', attachments, refs }
    if (isEmptyDraft(draft)) continue
    out[key] = draft
  }
  return out
}
