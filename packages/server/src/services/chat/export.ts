import type { Message, Session } from '../../types.js'

export interface ExportOptions {
  reasoning?: boolean
  tools?: boolean
  usage?: boolean
}

function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(longest + 1)
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function time(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export function messageToMarkdown(message: Message, speaker: string, options: ExportOptions = {}): string {
  const lines: string[] = [`### ${speaker} · ${time(message.createdAt)}`]
  if (message.runtime?.kind === 'provider' && message.runtime.model) lines[0] += ` · ${message.runtime.providerName}/${message.runtime.model}`
  if (options.reasoning && message.reasoning) lines.push('', '<details><summary>思考过程</summary>', '', quoteBlock(message.reasoning), '', '</details>')
  if (options.tools && message.toolTrace.length > 0) {
    lines.push('', '<details><summary>工具调用</summary>', '')
    for (const entry of message.toolTrace) {
      const status = !entry.approved ? '已拒绝' : entry.ok ? '成功' : '失败'
      const args = entry.arguments
      const result = entry.result
      lines.push(`- **${entry.name}**（${entry.server}，${status}，${entry.durationMs} ms）`)
      lines.push(`  参数：`, '', `${fenceFor(args)}json`, args, fenceFor(args), '', `  结果：`, '', fenceFor(result), result, fenceFor(result), '')
    }
    lines.push('</details>')
  }
  lines.push('', message.content || '（无内容）')
  if (options.usage && message.usage) {
    const u = message.usage
    lines.push(
      '',
      `<sub>tokens：输入 ${u.inputTokens}（缓存 ${u.cacheReadTokens}）/ 输出 ${u.outputTokens}${u.reasoningTokens ? `（推理 ${u.reasoningTokens}）` : ''}${u.estimated ? '（估算）' : ''}${u.cost !== null ? ` · 约 ${u.cost} ${u.currency}` : ''}</sub>`,
    )
  }
  return lines.join('\n')
}

export function sessionToMarkdown(
  session: Session,
  messages: Message[],
  nameOf: (agentId: string | null) => string,
  options: ExportOptions = {},
): string {
  const header = [
    `# ${session.title}`,
    '',
    `- 会话 ID：${session.id}`,
    `- 创建：${time(session.createdAt)}　更新：${time(session.updatedAt)}`,
    `- 成员：${session.agentIds.map((id) => nameOf(id)).join('、')}`,
    `- 消息数：${messages.length}`,
    `- 导出：${time(Date.now())}（LULUX ETA）`,
    '',
    '---',
  ]
  const body = messages.map((message) =>
    messageToMarkdown(message, message.role === 'user' ? (message.senderName ?? '用户') : message.role === 'system' ? '系统' : nameOf(message.senderAgentId), options),
  )
  return `${header.join('\n')}\n\n${body.join('\n\n---\n\n')}\n`
}
