import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TEST_TOKEN = 'a1'.repeat(32)

export interface TestResponse {
  status: number
  headers: IncomingHttpHeaders
  text: string
  json: any
}

export interface RequestOptions {
  body?: unknown
  /** 原样发送的请求体（不做 JSON 序列化） */
  raw?: string
  headers?: Record<string, string>
  token?: string | null
  host?: string
}

export interface TestServer {
  home: string
  port: number
  base: string
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>
  close(): Promise<void>
}

/** 在临时数据目录里启动一个真实的 HTTP 服务；必须在导入任何 src 模块之前调用 */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const home = mkdtempSync(join(tmpdir(), 'lulux-test-'))
  process.env.LULUX_ETA_HOME = home
  process.env.LULUX_KERNEL_OFFLINE = '1'
  process.env.LULUX_KERNELS_DIR = join(home, 'kernels')
  Object.assign(process.env, env)

  const { createApp } = await import('../src/app.js')
  let port = 0
  const app = createApp({ token: TEST_TOKEN, getPort: () => port, isProduction: true })
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  port = (server.address() as AddressInfo).port

  const request = (method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(options.headers ?? {}) }
      headers.Host = options.host ?? `127.0.0.1:${port}`
      const token = options.token === undefined ? TEST_TOKEN : options.token
      if (token) headers.Authorization = `Bearer ${token}`
      let payload: string | undefined
      if (options.raw !== undefined) {
        payload = options.raw
      } else if (options.body !== undefined) {
        payload = JSON.stringify(options.body)
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
      }
      if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload))
      // agent: false = 每个请求一条新连接。默认全局 Agent 会复用 keep-alive 空闲连接；
      // 若某个测试同步阻塞事件循环超过服务端 keepAliveTimeout（5s，Windows 上迁移测试就会），
      // 下一个请求可能写进服务端正在关闭的旧连接 → read ECONNRESET（CI windows-latest 偶发）。
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = undefined
          try {
            json = text ? JSON.parse(text) : undefined
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
      })
      req.on('error', reject)
      if (payload !== undefined) req.write(payload)
      req.end()
    })

  return {
    home,
    port,
    base: `http://127.0.0.1:${port}`,
    request,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** 解析 SSE 文本为事件列表 */
export function parseSse(text: string): Array<{ event: string; data: any }> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      return { event, data: data ? JSON.parse(data) : null }
    })
}

/** 在 <home>/kernels/<kernelId> 下放一个替身 npm 包（package.json + bin 脚本），让内核显示为“已安装” */
export function fakeKernelPackage(kernelsDir: string, kernelId: string, pkg: string, binName: string, binRel: string, script: string): void {
  const dir = join(kernelsDir, kernelId, 'node_modules', ...pkg.split('/'))
  mkdirSync(join(dir, binRel, '..'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '9.9.9-test', bin: { [binName]: binRel } }))
  writeFileSync(join(dir, binRel), script)
}

/**
 * 替身 CLI 的公共片段：读 stdin 提示词，经 LULUX 网关（OpenAI 兼容 chat/completions，stream）请求一次模型，
 * 把 SSE 增量交给 onDelta，结束时调用 onDone(fullText)。baseUrl/key 由各内核的 scoped 配置给出。
 */
export const GATEWAY_CALL_JS = `
async function callGateway(baseUrl, key, model, prompt, onDelta) {
  const res = await fetch(baseUrl.replace(/\\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error('gateway ' + res.status + ' ' + (await res.text()))
  const text = await res.text()
  let full = ''
  for (const line of text.split('\\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    const delta = JSON.parse(data).choices?.[0]?.delta?.content
    if (delta) { full += delta; onDelta(delta) }
  }
  return full
}
function readStdin() {
  return new Promise((resolve) => { let input = ''; process.stdin.on('data', (d) => (input += d)); process.stdin.on('end', () => resolve(input)) })
}
const argOf = (name) => { const a = process.argv; const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
`

/** 替身 Pi：按 $PI_CODING_AGENT_DIR/models.json 的 lulux provider 调网关，输出 pi --mode json 事件 */
export const FAKE_PI_JS = `${GATEWAY_CALL_JS}
const fs = require('fs'); const path = require('path')
;(async () => {
  const prompt = await readStdin()
  const models = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'))
  const provider = models.providers[argOf('--provider')]
  const key = provider.apiKey.startsWith('$') ? process.env[provider.apiKey.slice(1)] : provider.apiKey
  out({ type: 'session', version: 3, id: 'x' })
  out({ type: 'message_start', message: { role: 'assistant', content: [] } })
  const full = await callGateway(provider.baseUrl, key, argOf('--model'), prompt, (delta) =>
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } }))
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: full }] } })
  out({ type: 'agent_settled', aborted: false })
})().catch((e) => { out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: String(e.message || e) } }); process.exit(1) })
`

/** 替身 Hermes Agent：按 $HERMES_HOME/config.yaml（JSON 文本）里 --provider 指定的 provider 调网关，输出 hermes --format stream-json 事件 */
export const FAKE_HERMES_JS = `${GATEWAY_CALL_JS}
const fs = require('fs'); const path = require('path')
;(async () => {
  const prompt = await readStdin()
  const config = JSON.parse(fs.readFileSync(path.join(process.env.HERMES_HOME, 'config.yaml'), 'utf8'))
  const provider = config.providers[argOf('--provider')]
  out({ type: 'system', subtype: 'init', model: argOf('--model'), session_id: 's' })
  const full = await callGateway(provider.base_url, process.env[provider.key_env], argOf('--model'), prompt, (text) => out({ type: 'text', text }))
  out({ type: 'result', session_id: 's', exit_code: 0, text: full })
})().catch((e) => { out({ type: 'result', exit_code: 1, error: String(e.message || e) }); process.exit(1) })
`
