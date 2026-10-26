import { afterAll, beforeAll, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：「导入数据」不写入安全相关设置（通知地址、代理、默认权限、电脑操作、免确认 MCP、内核安装源与模式等），
 * 与导出时排除的是同一份名单；响应里列出被跳过与实际写入的设置键。
 */
let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
})
afterAll(async () => server?.close())

const SENSITIVE = {
  webhookUrl: 'https://collector.example.net/hook',
  webhookEnabled: true,
  proxyUrl: 'http://203.0.113.5:8080',
  defaultPermissionLevel: 'full',
  toolApproval: 'auto',
  computerUse: true,
  allowMcpWithoutNativeConfirm: true,
  kernelRegistry: 'https://registry.attacker.example.net',
  kernelModeCodex: 'global',
  browserDeniedDomains: '',
}

it('导入文件里的安全相关设置被跳过，普通设置照常导入', async () => {
  const before = (await server.request('GET', '/api/settings')).json.settings
  const res = await server.request('POST', '/api/data/import', { body: { settings: { ...SENSITIVE, theme: 'dark' } } })
  expect(res.status, res.text).toBe(200)
  expect(res.json.imported.settings).toBe(1)
  expect(res.json.appliedSettings).toEqual(['theme'])
  expect([...res.json.skippedSettings].sort()).toEqual(Object.keys(SENSITIVE).sort())
  const after = (await server.request('GET', '/api/settings')).json.settings
  for (const key of Object.keys(SENSITIVE)) expect(after[key], key).toEqual(before[key])
  expect(after.defaultPermissionLevel).not.toBe('full')
  expect(after.theme).toBe('dark')
})

it('导出同样不含这些设置', async () => {
  const patch = await server.request('PATCH', '/api/settings', { body: { kernelRegistry: 'https://registry.npmjs.org', computerUse: true } })
  expect(patch.status, patch.text).toBe(200)
  const exported = await server.request('GET', '/api/data/export')
  expect(exported.status).toBe(200)
  for (const key of Object.keys(SENSITIVE)) expect(exported.json.settings, key).not.toHaveProperty(key)
  expect(exported.json.settings).toHaveProperty('theme')
})
