import type { BrowserCapture } from './browser-capture'
import type { RefContext } from './composer-context'

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
