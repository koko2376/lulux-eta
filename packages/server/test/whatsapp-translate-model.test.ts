import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * WhatsApp 翻译：没有本地翻译包时使用设置里的默认模型（之前一律返回“未安装”，翻译在实际部署里永远不可用）。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}
const api = (method: string, path: string, body?: unknown) => server.request(method, path, body === undefined ? {} : { body })
const script = (...responses: unknown[]) =>
  fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })
const requests = async (): Promise<any[]> => (await (await fetch(`${mockBase}/__mock/requests`)).json()) as any[]

let savedTranslator: string | undefined
let savedTranslatorDir: string | undefined

beforeAll(async () => {
  savedTranslator = process.env.LULUX_WHATSAPP_TRANSLATOR
  savedTranslatorDir = process.env.LULUX_WHATSAPP_TRANSLATOR_DIR
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((resolve) => mock.stdout!.once('data', () => resolve()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  delete process.env.LULUX_WHATSAPP_TRANSLATOR
  process.env.LULUX_WHATSAPP_TRANSLATOR_DIR = `${server.home}/no-translator-here`
  await api('PATCH', '/api/settings', { autoTitle: false, llmMaxRetries: 0 })
}, 30_000)

afterAll(async () => {
  if (savedTranslator === undefined) delete process.env.LULUX_WHATSAPP_TRANSLATOR
  else process.env.LULUX_WHATSAPP_TRANSLATOR = savedTranslator
  if (savedTranslatorDir === undefined) delete process.env.LULUX_WHATSAPP_TRANSLATOR_DIR
  else process.env.LULUX_WHATSAPP_TRANSLATOR_DIR = savedTranslatorDir
  mock?.kill()
  await server.close()
})

describe('WhatsApp 翻译走默认模型', () => {
  it('译文清理：去掉思考段、代码围栏、整体引号', async () => {
    // 动态导入：服务端模块要在 startTestServer 设好 LULUX_ETA_HOME 之后才加载
    const { cleanModelTranslation } = await import('../src/services/whatsapp/translator.js')
    expect(cleanModelTranslation('<think>hmm</think>\n"Hello there"')).toBe('Hello there')
    expect(cleanModelTranslation('```text\n你好\n```')).toBe('你好')
    expect(cleanModelTranslation('「こんにちは」')).toBe('こんにちは')
    expect(cleanModelTranslation('He said "hi" to me')).toBe('He said "hi" to me')
  })

  it('没有模型也没有本地翻译包：503 TRANSLATOR_NOT_INSTALLED，提示去设置里选模型', async () => {
    const res = await api('POST', '/api/whatsapp/translate', { text: 'Hello', targetLang: 'zh-Hans' })
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('TRANSLATOR_NOT_INSTALLED')
    expect(res.json.error.details).toMatchObject({ reason: 'NO_PROVIDER', installHint: 'docs/WHATSAPP-TRANSLATOR.md' })
  })

  it('配置了模型：输入翻译与收到消息的翻译都可用，结果缓存，不把原文当译文', async () => {
    const created = await api('POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
    expect(created.status, created.text).toBeLessThan(300)
    await fetch(`${mockBase}/__mock/reset`, { method: 'POST' })
    await script({ text: '"Guten Tag, ich brauche 500 Stück."' }, { text: '你好，我需要 500 件。' })

    const outgoing = await api('POST', '/api/whatsapp/translate', { text: '你好，我需要 500 件。', targetLang: 'de' })
    expect(outgoing.status, outgoing.text).toBe(200)
    expect(outgoing.json).toMatchObject({ provider: 'model:mock-model', kind: 'llm', targetLang: 'de', text: 'Guten Tag, ich brauche 500 Stück.' })

    const incoming = await api('POST', '/api/whatsapp/translate', { text: 'Guten Tag, ich brauche 500 Stück.', targetLang: 'zh-Hans' })
    expect(incoming.status, incoming.text).toBe(200)
    expect(incoming.json.text).toBe('你好，我需要 500 件。')

    const sent = await requests()
    expect(sent).toHaveLength(2)
    const system = JSON.stringify(sent[0])
    expect(system).toContain('into German')
    expect(JSON.stringify(sent[1])).toContain('into Simplified Chinese')

    // 同一原文再译一次走缓存，不再调用模型
    const again = await api('POST', '/api/whatsapp/translate', { text: '你好，我需要 500 件。', targetLang: 'de' })
    expect(again.json.text).toBe('Guten Tag, ich brauche 500 Stück.')
    expect(await requests()).toHaveLength(2)
  })
})
