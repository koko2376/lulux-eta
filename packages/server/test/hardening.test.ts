import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { publicOnlyDispatcher } from '../src/services/tools/net-guard.js'

/** DNS rebinding：连接时再校验解析结果，域名解析到本机 / 内网时拒绝连接（不依赖前置的 assertPublicHttpUrl） */
describe('publicOnlyDispatcher', () => {
  let server: Server
  let port = 0
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('internal secret'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => server.close())

  it('refuses to connect when the hostname resolves to loopback', async () => {
    const error = await fetch(`http://localhost:${port}/`, { dispatcher: publicOnlyDispatcher() } as RequestInit).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    )
    expect(error).not.toBeNull()
    expect(String(error?.cause?.message ?? error?.message)).toMatch(/内网|EPRIVATEADDR/)
  })

  it('still connects without the guard (control)', async () => {
    const res = await fetch(`http://localhost:${port}/`)
    expect(await res.text()).toBe('internal secret')
  })
})

describe('windowsNodeShim', () => {
  it('reads the exec path from the environment and never embeds a non-ASCII path', async () => {
    const { windowsNodeShim, EXEC_ENV } = await import('../src/services/kernels/node-runtime.js')
    const zh = windowsNodeShim('C:\\Users\\张三\\AppData\\Local\\Programs\\LULUX ETA\\LULUX ETA.exe')
    expect(zh).not.toContain('张三')
    expect(zh).toContain(`"%${EXEC_ENV}%" %*`)
    expect(zh).toContain('\r\n')
    const ascii = windowsNodeShim('C:\\Program Files\\LULUX ETA\\LULUX ETA.exe')
    expect(ascii).toContain(`if not defined ${EXEC_ENV} set "${EXEC_ENV}=C:\\Program Files\\LULUX ETA\\LULUX ETA.exe"`)
  })
})
