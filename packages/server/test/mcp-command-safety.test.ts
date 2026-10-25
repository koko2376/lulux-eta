import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unsafeMcpCommandReason } from '../src/services/mcp/spawn-env.js'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：本机命令型 MCP 的启动参数注入。确认框里看到的命令就是实际执行的命令：
 * 参数里不能有控制字符，不能借环境变量改变实际运行的程序 / 加载的代码，
 * Windows 上经 cmd 包装脚本启动的程序参数里不能有双引号（会被包装脚本重新解析拼出额外命令）。
 */
describe('unsafeMcpCommandReason', () => {
  const ok = { command: 'npx', args: ['-y', '@scope/server', '--root', 'C:\\data dir'], env: { API_KEY: 'x', npm_config_registry: 'https://registry.npmmirror.com' } }

  it('普通命令放行', () => {
    expect(unsafeMcpCommandReason(ok, 'linux')).toBeNull()
    expect(unsafeMcpCommandReason(ok, 'win32')).toBeNull()
    expect(unsafeMcpCommandReason({ command: 'node', args: ['-e', 'console.log("hi")'], env: {} }, 'linux')).toBeNull()
    expect(unsafeMcpCommandReason({ command: 'C:\\tools\\server.exe', args: ['--json', '{"a":1}'], env: {} }, 'win32')).toBeNull()
  })

  it.each([
    ['参数含 ESC 控制序列', { command: 'npx', args: ['-y', 'pkg\u001b[2Kcalc'], env: {} }],
    ['命令含换行', { command: 'npx\nwhoami', args: [], env: {} }],
    ['参数含 NUL', { command: 'node', args: ['a\u0000b'], env: {} }],
    ['NODE_OPTIONS', { command: 'npx', args: [], env: { NODE_OPTIONS: '--require /tmp/evil.js' } }],
    ['大小写混写的 Path', { command: 'npx', args: [], env: { Path: '/tmp/evil' } }],
    ['LD_PRELOAD', { command: 'uvx', args: [], env: { LD_PRELOAD: '/tmp/evil.so' } }],
    ['DYLD_INSERT_LIBRARIES', { command: 'uvx', args: [], env: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' } }],
    ['PYTHONPATH', { command: 'python', args: ['-m', 'srv'], env: { PYTHONPATH: '/tmp/evil' } }],
    ['BASH_ENV', { command: 'bash', args: ['srv.sh'], env: { BASH_ENV: '/tmp/evil.sh' } }],
  ])('拒绝：%s', (_label, spec) => {
    expect(unsafeMcpCommandReason(spec, 'linux')).not.toBeNull()
  })

  it('参数里的换行：只在 Windows 经 cmd 转发时拒绝（其他情况不经 shell，多行脚本是正常用法）', () => {
    const multi = { command: 'node', args: ['-e', 'const a = 1\nconsole.log(a)'], env: {} }
    expect(unsafeMcpCommandReason(multi, 'linux')).toBeNull()
    expect(unsafeMcpCommandReason({ ...multi, command: 'node.exe' }, 'win32')).toBeNull()
    expect(unsafeMcpCommandReason({ command: 'npx', args: ['-y', 'pkg\r\ncalc.exe'], env: {} }, 'win32')).not.toBeNull()
  })

  it('Windows：cmd 包装脚本的参数里不能有双引号；.exe 不受限', () => {
    const inject = { command: 'npx', args: ['-y', 'pkg" & calc.exe & "'], env: {} }
    expect(unsafeMcpCommandReason(inject, 'win32')).not.toBeNull()
    expect(unsafeMcpCommandReason({ ...inject, command: 'tool.cmd' }, 'win32')).not.toBeNull()
    expect(unsafeMcpCommandReason({ ...inject, command: 'node.exe' }, 'win32')).toBeNull()
    expect(unsafeMcpCommandReason(inject, 'linux')).toBeNull()
  })
})

describe('接口与启动时的检查', () => {
  let server: TestServer
  beforeAll(async () => {
    server = await startTestServer()
    const res = await server.request('PATCH', '/api/settings', { body: { allowMcpWithoutNativeConfirm: true } })
    expect(res.status, res.text).toBe(200)
  })
  afterAll(async () => server?.close())

  it('添加 / 修改时拒绝不安全的命令', async () => {
    const bad = await server.request('POST', '/api/mcp/servers', { body: { name: 'bad', command: 'npx', args: ['-y', 'pkg\u0000calc'], enabled: false } })
    expect(bad.status, bad.text).toBe(400)
    expect(bad.json.error.code).toBe('MCP_COMMAND_UNSAFE')
    const env = await server.request('POST', '/api/mcp/servers', { body: { name: 'env', command: 'npx', args: ['-y', 'pkg'], env: { NODE_OPTIONS: '--require /tmp/x.js' }, enabled: false } })
    expect(env.status, env.text).toBe(400)
    expect(env.json.error.code).toBe('MCP_COMMAND_UNSAFE')

    const good = await server.request('POST', '/api/mcp/servers', { body: { name: 'good', command: 'node', args: ['server.js'], env: { API_KEY: 'x' }, enabled: false } })
    expect(good.status, good.text).toBe(201)
    const patched = await server.request('PATCH', `/api/mcp/servers/${good.json.server.id}`, { body: { env: { LD_PRELOAD: '/tmp/x.so' } } })
    expect(patched.status, patched.text).toBe(400)
    expect(patched.json.error.code).toBe('MCP_COMMAND_UNSAFE')
  })

  it('库里已有的不安全配置在启动前被拦下，不会执行', async () => {
    const { McpConnection } = await import('../src/services/mcp/client.js')
    const conn = new McpConnection({
      id: 'mcp_legacy',
      name: 'legacy',
      command: 'node',
      args: ['-e', 'require("fs").writeFileSync("/tmp/should-not-exist", "x")\u001b[2K'],
      env: {},
      enabled: true,
      approved: true,
      transport: 'stdio',
      url: '',
      headers: {},
      createdAt: Date.now(),
      createdBy: 'user',
    } as never)
    await expect(conn.connect()).rejects.toThrow(/MCP 命令不安全/)
  })
})
