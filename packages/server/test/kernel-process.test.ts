import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeKernelPackage, startTestServer, type TestServer } from './helpers.js'

/**
 * CLI 内核进程管理回归（审计 2026-10-24 #3 #4 #10）：
 * 停止时 SIGTERM → 超时 SIGKILL 整个进程组；孙进程占着 stdout 也能收尾；无输出 / 总时长超时；
 * 非零退出码但已有部分输出时按出错收尾并保留输出。
 */
let server: TestServer
beforeAll(async () => {
  // 内核登录态与本机环境无关：给一个假的 API Key，CI 上没有真实凭据也能跑
  server = await startTestServer({ OPENAI_API_KEY: `test-${'key'}` })
})
afterAll(async () => {
  await server.close()
})

function install(script: string): void {
  fakeKernelPackage(join(server.home, 'kernels'), 'codex', '@openai/codex', 'codex', 'bin/codex.js', `#!/usr/bin/env node\n${script}`)
}
const OUT = `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Drained {
  texts: string[]
  finished: boolean
  error?: { message: string; code?: string }
}

function drain(gen: AsyncGenerator<{ text: string }>): { live: Drained; done: Promise<void> } {
  const live: Drained = { texts: [], finished: false }
  const done = (async () => {
    try {
      for await (const event of gen) live.texts.push(event.text)
    } catch (error: any) {
      live.error = { message: error.message, code: error.code }
    }
    live.finished = true
  })()
  return { live, done }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(50)
  }
  return check()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const posix = process.platform !== 'win32'

describe('CLI 内核进程管理', () => {
  it('停止：子进程忽略 SIGTERM 时超时升级为 SIGKILL，运行能结束', async () => {
    install(`${OUT}
process.on('SIGTERM', () => {});
process.stdin.resume(); process.stdin.on('end', () => {
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });
  setInterval(() => {}, 1000);
});`)
    const { runKernel } = await import('../src/services/kernels/kernel-runner.js')
    const ac = new AbortController()
    const { live } = drain(runKernel({ kernelId: 'codex', prompt: 'hi', signal: ac.signal, timeouts: { idleMs: 0, totalMs: 0 } }))
    expect(await until(() => live.texts.length > 0, 5000)).toBe(true)
    ac.abort()
    expect(await until(() => live.finished, 8000)).toBe(true)
    expect(live.texts).toEqual(['hello'])
  }, 20_000)

  it.runIf(posix)('停止：同组的孙进程占着 stdout 也会被一起结束', async () => {
    const pidFile = join(server.home, 'grandchild.pid')
    install(`${OUT}
const { spawn } = require('child_process');
const fs = require('fs');
process.stdin.resume(); process.stdin.on('end', () => {
  const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'working' } });
  setInterval(() => {}, 1000);
});`)
    const { runKernel } = await import('../src/services/kernels/kernel-runner.js')
    const ac = new AbortController()
    const { live } = drain(runKernel({ kernelId: 'codex', prompt: 'hi', signal: ac.signal, timeouts: { idleMs: 0, totalMs: 0 } }))
    expect(await until(() => live.texts.length > 0, 5000)).toBe(true)
    const { readFileSync } = await import('node:fs')
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(grandchild)).toBe(true)
    ac.abort()
    expect(await until(() => live.finished, 8000)).toBe(true)
    expect(await until(() => !alive(grandchild), 3000)).toBe(true)
  }, 20_000)

  it('CLI 已退出、逃出进程组的孙进程还占着 stdout：短宽限后结束读取，按正常完成', async () => {
    install(`${OUT}
const { spawn } = require('child_process');
process.stdin.resume(); process.stdin.on('end', () => {
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 15000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
  process.exit(0);
});`)
    const { runKernel } = await import('../src/services/kernels/kernel-runner.js')
    const { live } = drain(runKernel({ kernelId: 'codex', prompt: 'hi', signal: new AbortController().signal, timeouts: { idleMs: 0, totalMs: 0 } }))
    expect(await until(() => live.finished, 6000)).toBe(true)
    expect(live.texts).toEqual(['done'])
    expect(live.error).toBeUndefined()
  }, 20_000)

  it('无输出超时：卡住不输出的 CLI 被结束，给出可读的 KERNEL_TIMEOUT 错误', async () => {
    install(`process.stdin.resume(); process.stdin.on('end', () => { setInterval(() => {}, 1000) });`)
    const { runKernel } = await import('../src/services/kernels/kernel-runner.js')
    const { live } = drain(runKernel({ kernelId: 'codex', prompt: 'hi', signal: new AbortController().signal, timeouts: { idleMs: 800, totalMs: 0 } }))
    expect(await until(() => live.finished, 8000)).toBe(true)
    expect(live.error?.code).toBe('KERNEL_TIMEOUT')
    expect(live.error?.message).toContain('没有任何输出')
  }, 20_000)

  it('总时长上限：一直有输出也会在上限到时结束', async () => {
    install(`${OUT}
process.stdin.resume(); process.stdin.on('end', () => {
  setInterval(() => out({ type: 'item.completed', item: { type: 'agent_message', text: '.' } }), 100);
});`)
    const { runKernel } = await import('../src/services/kernels/kernel-runner.js')
    const { live } = drain(runKernel({ kernelId: 'codex', prompt: 'hi', signal: new AbortController().signal, timeouts: { idleMs: 0, totalMs: 1200 } }))
    expect(await until(() => live.finished, 8000)).toBe(true)
    expect(live.texts.length).toBeGreaterThan(0)
    expect(live.error?.code).toBe('KERNEL_TIMEOUT')
    expect(live.error?.message).toContain('不完整')
  }, 20_000)

  it('超时设置默认读取 kernelIdleTimeoutSeconds / kernelMaxRunMinutes', async () => {
    const { kernelTimeouts } = await import('../src/services/kernels/kernel-runner.js')
    expect(kernelTimeouts()).toEqual({ idleMs: 600_000, totalMs: 3_600_000 })
    const patched = await server.request('PATCH', '/api/settings', { body: { kernelIdleTimeoutSeconds: 30, kernelMaxRunMinutes: 0 } })
    expect(patched.status, patched.text).toBe(200)
    expect(kernelTimeouts()).toEqual({ idleMs: 30_000, totalMs: 0 })
    await server.request('PATCH', '/api/settings', { body: { kernelIdleTimeoutSeconds: 600, kernelMaxRunMinutes: 60 } })
  })

  it('非零退出码 + 已有部分输出：保留输出，按出错收尾（不当成完整回答）', async () => {
    install(`${OUT}
process.stdin.resume(); process.stdin.on('end', () => {
  out({ type: 'item.completed', item: { type: 'agent_message', text: '前半段' } });
  process.stderr.write('panic: segfault'); process.exit(139);
});`)
    const { runKernel } = await import('../src/services/kernels/kernel-runner.js')
    const { live, done } = drain(runKernel({ kernelId: 'codex', prompt: 'hi', signal: new AbortController().signal }))
    await done
    expect(live.texts).toEqual(['前半段'])
    expect(live.error?.code).toBe('KERNEL_EXITED')
    expect(live.error?.message).toContain('退出码 139')
  }, 20_000)

  it('非零退出码在会话里：部分回答保留，消息记为 error', async () => {
    install(`${OUT}
process.stdin.resume(); process.stdin.on('end', () => {
  out({ type: 'item.completed', item: { type: 'agent_message', text: '半截回答' } });
  process.exit(3);
});`)
    await server.request('PATCH', '/api/settings', { body: { kernelModeCodex: 'global', autoTitle: false } })
    const session = (await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-codex'] } })).json.session
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: 'hi' } })
    expect(res.text).toContain('KERNEL_EXITED')
    let messages: any[] = []
    for (let i = 0; i < 100; i += 1) {
      messages = (await server.request('GET', `/api/sessions/${session.id}`)).json.messages
      if (messages.some((m: any) => m.role === 'assistant')) break
      await sleep(50)
    }
    const reply = messages.find((m: any) => m.role === 'assistant')
    expect(reply.content).toBe('半截回答')
    expect(reply.finishReason).toBe('error')
  }, 20_000)
})
