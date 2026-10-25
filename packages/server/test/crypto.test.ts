import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
})
afterAll(() => server.close())

describe('API Key 加密存储', () => {
  it('浏览器开发态生成 <dataDir>/master.key（0600）', () => {
    const file = join(server.home, 'master.key')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('AES-256-GCM 往返、篡改检测、换密钥无法解密', async () => {
    const { encryptSecret, decryptSecret, loadKeyring, SecretUnavailableError, isEncrypted } = await import(
      '../src/security/secrets.js'
    )
    const ring = loadKeyring(server.home)
    const cipher = encryptSecret('sk-test-1234567890', ring)
    expect(isEncrypted(cipher)).toBe(true)
    expect(cipher).not.toContain('sk-test')
    expect(encryptSecret('sk-test-1234567890', ring)).not.toBe(cipher) // 随机 IV
    expect(decryptSecret(cipher, ring)).toBe('sk-test-1234567890')
    expect(decryptSecret('legacy-plain', ring)).toBe('legacy-plain')

    const parts = cipher.split(':')
    const ct = Buffer.from(parts[5]!, 'base64')
    ct[0] = ct[0]! ^ 0xff
    parts[5] = ct.toString('base64')
    expect(() => decryptSecret(parts.join(':'), ring)).toThrow(SecretUnavailableError)

    const other = { primary: { id: 'ffffffff', key: randomBytes(32) }, keys: new Map(), source: 'env' as const }
    other.keys.set('ffffffff', other.primary.key)
    expect(() => decryptSecret(cipher, other)).toThrow(SecretUnavailableError)
  })

  it('环境变量主密钥优先，旧文件密钥仍可解密', async () => {
    const { encryptSecret, decryptSecret, loadKeyring } = await import('../src/security/secrets.js')
    const fileRing = loadKeyring(server.home)
    const oldCipher = encryptSecret('old-secret', fileRing)
    process.env.LULUX_MASTER_KEY = randomBytes(32).toString('hex')
    const envRing = loadKeyring(server.home)
    expect(process.env.LULUX_MASTER_KEY).toBeUndefined()
    expect(envRing.source).toBe('env')
    expect(envRing.primary.id).not.toBe(fileRing.primary.id)
    expect(decryptSecret(oldCipher, envRing)).toBe('old-secret')
    expect(decryptSecret(encryptSecret('new', envRing), envRing)).toBe('new')
  })

  it('接口不返回明文 Key，库里存密文', async () => {
    const created = await server.request('POST', '/api/providers', {
      body: { name: 'P', kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-abcdefghijklmnop', model: 'm1' },
    })
    expect(created.status).toBe(201)
    expect(created.json.provider).toMatchObject({ hasApiKey: true, apiKeyPreview: 'sk-…mnop', apiKeyError: null })
    expect(created.text).not.toContain('sk-abcdefghijklmnop')
    expect(created.json.provider.apiKey).toBeUndefined()

    const list = await server.request('GET', '/api/providers')
    expect(list.text).not.toContain('abcdefghijklmnop')

    const { db } = await import('../src/db.js')
    const row = db.prepare('SELECT api_key FROM providers WHERE id = ?').get(created.json.provider.id) as { api_key: string }
    expect(row.api_key.startsWith('enc:v1:')).toBe(true)

    const { providerService } = await import('../src/services/provider-service.js')
    expect(providerService.get(created.json.provider.id)!.apiKey).toBe('sk-abcdefghijklmnop')

    // PATCH 空 Key 保持原值；新 Key 重新加密
    await server.request('PATCH', `/api/providers/${created.json.provider.id}`, { body: { apiKey: '', name: 'P2' } })
    expect(providerService.get(created.json.provider.id)!.apiKey).toBe('sk-abcdefghijklmnop')
    await server.request('PATCH', `/api/providers/${created.json.provider.id}`, { body: { apiKey: 'sk-zzzzzzzzzzzz9999' } })
    expect(providerService.get(created.json.provider.id)!.apiKey).toBe('sk-zzzzzzzzzzzz9999')

    const exported = await server.request('GET', '/api/data/export')
    expect(exported.text).not.toContain('sk-zzzz')
    expect(exported.text).not.toContain('apiKeyPreview')
  })

  it('Provider baseUrl 只允许 http/https', async () => {
    for (const baseUrl of ['file:///etc/passwd', 'ftp://x.example', 'javascript:alert(1)', 'not a url']) {
      const res = await server.request('POST', '/api/providers', { body: { name: 'X', kind: 'openai', baseUrl } })
      expect(res.status).toBe(400)
    }
  })

  it('discover-models 超时 / 无法连接返回 502 且不挂起', async () => {
    const created = await server.request('POST', '/api/providers', {
      body: { name: 'Dead', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' },
    })
    const res = await server.request('POST', `/api/providers/${created.json.provider.id}/discover-models`)
    expect(res.status).toBe(502)
    expect(res.json.error.code).toMatch(/UPSTREAM_/)
  })
})
