import type { Message } from '../api'
import { t } from '../i18n'

/** 会话里可预览的代码块产物 */
export interface Artifact {
  id: string
  messageId: string
  agentId: string | null
  createdAt: number
  language: string
  code: string
  title: string
}

const EXTENSIONS: Record<string, string> = {
  html: 'html',
  htm: 'html',
  svg: 'svg',
  markdown: 'md',
  md: 'md',
  json: 'json',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  css: 'css',
  python: 'py',
  py: 'py',
  shell: 'sh',
  bash: 'sh',
  sh: 'sh',
  sql: 'sql',
  yaml: 'yml',
  yml: 'yml',
  xml: 'xml',
}

export function normalizeLanguage(raw: string): string {
  const token = raw.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (token === 'htm') return 'html'
  if (token === 'markdown') return 'markdown'
  return token || 'text'
}

export function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    html: 'HTML',
    svg: 'SVG',
    markdown: 'Markdown',
    json: 'JSON',
    javascript: 'JavaScript',
    js: 'JavaScript',
    typescript: 'TypeScript',
    ts: 'TypeScript',
    css: 'CSS',
    python: 'Python',
    py: 'Python',
    shell: 'Shell',
    bash: 'Shell',
    sh: 'Shell',
    sql: 'SQL',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
    text: t('artifacts.k1v0ztzv'),
  }
  return labels[language] ?? language.toUpperCase()
}

function titleOf(language: string, code: string): string {
  if (language === 'html' || language === 'svg' || language === 'xml') {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code)
    const found = match?.[1]?.trim()
    if (found) return found.length > 48 ? `${found.slice(0, 48)}…` : found
  }
  const firstLine = code
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return t('artifacts.kfkd3xl')
  const cleaned = firstLine
    .replace(/^<!--|-->$/g, '')
    .replace(/^\/\*|\*\/$/g, '')
    .replace(/^\/\/\s*/, '')
    .trim()
  if (!cleaned) return t('artifacts.kfkd3xl')
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned
}

/** 从已落库消息中提取代码块，按出现顺序返回 */
export function extractArtifacts(messages: Message[]): Artifact[] {
  const result: Artifact[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const fence = /```([^\n`]*)\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    let index = 0
    while ((match = fence.exec(message.content)) !== null) {
      const language = normalizeLanguage(match[1] ?? '')
      const code = match[2].replace(/\s+$/, '')
      if (!code.trim()) continue
      result.push({
        id: `${message.id}:${index++}`,
        messageId: message.id,
        agentId: message.senderAgentId,
        createdAt: message.createdAt,
        language,
        code,
        title: titleOf(language, code),
      })
    }
  }
  return result
}

export function artifactFileName(artifact: Artifact): string {
  const base = artifact.title
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 40)
  const extension = EXTENSIONS[artifact.language] ?? 'txt'
  return `${base || 'artifact'}.${extension}`
}

/**
 * 产物预览的 CSP：禁止一切网络请求（connect-src 'none'），只允许内联脚本与样式、data/blob 图片。
 * 与 iframe sandbox="allow-scripts"（不含 allow-same-origin）配合，产物拿不到本地 API 与 token。
 * 注意：srcdoc iframe 同时继承主窗口 CSP（script-src 'self'），因此预览中的内联脚本实际不会执行。
 */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'"

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`

/** 把 CSP meta 放到文档最前面：必须先于任何脚本 / 资源被解析 */
export function withArtifactCsp(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + CSP_META + html.slice(head.index + head[0].length)
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag)
    return (
      html.slice(0, htmlTag.index + htmlTag[0].length) +
      `<head>${CSP_META}</head>` +
      html.slice(htmlTag.index + htmlTag[0].length)
    )
  return `<!doctype html><html><head>${CSP_META}</head><body>${html}</body></html>`
}

export function previewSource(artifact: Artifact): string {
  if (artifact.language === 'html') return withArtifactCsp(artifact.code)
  if (artifact.language === 'svg') {
    return withArtifactCsp(`<!doctype html><html><head><meta charset="utf-8" />
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#fff}
svg{max-width:92%;max-height:92%}</style></head><body>${artifact.code}</body></html>`)
  }
  if (artifact.language === 'json') {
    try {
      return JSON.stringify(JSON.parse(artifact.code), null, 2)
    } catch {
      return artifact.code
    }
  }
  return artifact.code
}

export function isPreviewable(language: string): boolean {
  return language === 'html' || language === 'svg'
}

/** 工作区文件的类型标签（产物面板的小方块） */
export function fileKind(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  if (['doc', 'docx'].includes(ext)) return 'docx'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return ext === 'csv' ? 'csv' : 'xlsx'
  if (['ppt', 'pptx'].includes(ext)) return 'pptx'
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'img'
  return ext.slice(0, 4) || 'file'
}
