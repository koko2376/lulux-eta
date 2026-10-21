import { t } from '../i18n'
/** 会话附件：上传到会话工作区 uploads/ 下，发送时在消息末尾注明路径，Agent 用技能脚本 / workspace_read 读取 */
export const UPLOAD_LIMIT = 10 * 1024 * 1024
export const UPLOAD_DIR = 'uploads'

/** 文件名 → 工作区相对路径：去掉目录、控制字符和不安全字符，保留中文与扩展名 */
export function uploadPath(name: string, taken: string[] = []): string {
  const base =
    (name.split(/[\\/]/).pop() ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f<>:"|?*]+/g, '')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 120) || 'file'
  let candidate = `${UPLOAD_DIR}/${base}`
  if (!taken.includes(candidate)) return candidate
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    candidate = `${UPLOAD_DIR}/${stem}-${i}${ext}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${UPLOAD_DIR}/${Date.now()}-${base}`
}

/** 发送时附加到消息末尾的说明 */
export function withAttachmentNote(content: string, paths: string[]): string {
  if (!paths.length) return content
  return t('attachments.kth8vpm', [content, paths.join(t('fmt.listSep'))])
}

/**
 * 气泡里显示的用户消息：附件说明里的文件都已经作为图片缩略图显示时，去掉发送时附加的
 * “附件已上传到会话工作区：…”说明（说明仍保留在消息内容里给模型 / CLI 内核读文件用，复制、编辑时也照旧）。
 * 说明里还有非图片文件（如 csv）时保留，用户需要看到路径。
 */
const NOTE_RE =
  /\n\n(?:（附件已上传到会话工作区：([^\n]*)）|\(Attachments uploaded to the session workspace: ([^\n]*)\))\s*$/

export function stripAttachmentNote(content: string, imagePaths: string[]): string {
  const match = NOTE_RE.exec(content)
  if (!match) return content
  const listed = (match[1] ?? match[2] ?? '')
    .split(/、|, /)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!listed.length || !listed.every((p) => imagePaths.includes(p))) return content
  return content.slice(0, match.index)
}
