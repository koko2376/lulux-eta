import type { Message } from '../api'
import { labelled, t } from '../i18n'

/**
 * 会话列表预览：最后一条消息没有正文（例如只有一次超时 / 被拒绝的工具审批）时，
 * 用工具调用摘要代替“没有可显示的内容”。
 */
export function toolPreview(messages: Pick<Message, 'content' | 'toolTrace'>[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.content.trim()) return ''
    const trace = m.toolTrace ?? []
    if (!trace.length) continue
    const last = trace[trace.length - 1]
    const name = last.name || t('preview.k1ady4r1')
    const more = trace.length > 1 ? t('preview.k16wvc37', [trace.length]) : ''
    if (!last.approved) return t('preview.k1gp5l48', [name, more])
    return labelled(last.ok ? t('preview.kfd4q6b') : t('preview.kedloz5'), `${name}${more}`)
  }
  return ''
}

/**
 * 会话列表预览用的纯文本：助手消息按 Markdown 渲染后，列表里不该露出 `**`、`##`、表格竖线等标记。
 * 只做轻量去标记（标题、强调、行内代码、代码围栏、链接 / 图片、列表 / 引用前缀、表格），不追求完整解析。
 */
export function plainPreview(text: string): string {
  return text
    .replace(/^[ \t]*```[^\n]*$/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, cells: string) =>
      cells
        .split('|')
        .map((c) => c.trim())
        .join(' '),
    )
    .replace(/\s+/g, ' ')
    .trim()
}
