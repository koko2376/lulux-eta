import * as api from '../api'
import { downloadBlob } from './download'

/** 会话导出 Markdown（契约 §6.4 /export）：fetch → Blob 下载；包含推理、工具调用与用量 */
export async function exportSessionMarkdown(session: { id: string; title: string }): Promise<void> {
  const markdown = await api.exportSessionMarkdown(session.id, { reasoning: true, tools: true, usage: true })
  const name = session.title.replace(/[\\/:*?"<>|\r\n]+/g, '-').slice(0, 60) || 'session'
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${name}.md`)
}
