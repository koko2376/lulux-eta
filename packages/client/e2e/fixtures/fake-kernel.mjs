// 端到端用的替身命令行内核：在 e2e 数据目录的 kernels/ 下放一个“已安装”的 Claude Code 包，
// bin 是一个按 claude stream-json 格式输出固定回答的小脚本（不联网、不调用模型）。
// 服务端每次请求都从磁盘判断是否已安装，所以写完立即生效。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FAKE_CLAUDE_REPLY = 'Claude Code 替身：收到。'

export function installFakeClaudeCode(dataDir = process.env.E2E_DATA_DIR) {
  if (!dataDir) throw new Error('E2E_DATA_DIR 未设置')
  const dir = join(dataDir, 'kernels', 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-code', version: '9.9.9-e2e', bin: { claude: 'bin/claude.js' } }),
  )
  writeFileSync(
    join(dir, 'bin', 'claude.js'),
    `process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  out({ type: 'system', subtype: 'init' })
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ${JSON.stringify(FAKE_CLAUDE_REPLY)} } } })
  out({ type: 'result', is_error: false, result: 'done' })
})
`,
  )
}
