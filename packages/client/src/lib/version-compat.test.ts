import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkCompat,
  clientVersion,
  compareVersions,
  fetchServerVersion,
  parseVersion,
  refreshVersionCompat,
  resetVersionCompat,
  versionCompat,
} from './version-compat'

describe('版本号比较', () => {
  it('解析 x.y[.z]，忽略前缀 v 与预发布后缀', () => {
    expect(parseVersion('0.1.1')).toEqual([0, 1, 1])
    expect(parseVersion('v1.2')).toEqual([1, 2, 0])
    expect(parseVersion('2.0.0-beta.1')).toEqual([2, 0, 0])
    expect(parseVersion('abc')).toBeNull()
    expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.1', '0.1.1')).toBe(0)
    expect(compareVersions('x', '0.1.1')).toBeNull()
  })

  it('修订号不同视为兼容；次版本 / 主版本不同给出方向；低于最低版本拦截', () => {
    expect(checkCompat('0.1.1', { version: '0.1.5', minClientVersion: '0.1.0' }).status).toBe('ok')
    expect(checkCompat('0.2.0', { version: '0.1.5', minClientVersion: '0.1.0' }).status).toBe('client-newer')
    expect(checkCompat('1.0.0', { version: '0.9.0', minClientVersion: '' }).status).toBe('client-newer')
    expect(checkCompat('0.1.1', { version: '0.2.0', minClientVersion: '0.1.0' }).status).toBe('client-older')
    expect(checkCompat('0.1.1', { version: '0.3.0', minClientVersion: '0.2.0' }).status).toBe('blocked')
    // 最低版本只在客户端低于它时拦截，同一次版本也一样
    expect(checkCompat('0.1.1', { version: '0.1.4', minClientVersion: '0.1.2' }).status).toBe('blocked')
    expect(checkCompat('', { version: '0.1.0', minClientVersion: '' }).status).toBe('unknown')
  })

  it('客户端版本来自构建注入', () => {
    expect(clientVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('读取服务端版本', () => {
  afterEach(() => resetVersionCompat())

  it('优先 /api/version；没有时退回 /api/auth/mode（没有最低版本）；都失败返回 null', async () => {
    const ok = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith('/api/version') ? { version: '0.3.0', minClientVersion: '0.2.0' } : {}),
          { status: 200 },
        ),
    )
    expect(await fetchServerVersion('https://eta.example.com/', ok as unknown as typeof fetch)).toEqual({
      version: '0.3.0',
      minClientVersion: '0.2.0',
    })
    expect(ok.mock.calls[0]![0]).toBe('https://eta.example.com/api/version')

    const legacy = vi.fn(async (url: string) =>
      url.endsWith('/api/version')
        ? new Response('', { status: 404 })
        : new Response(JSON.stringify({ mode: 'server', version: '0.1.0' }), { status: 200 }),
    )
    expect(await fetchServerVersion('https://eta.example.com', legacy as unknown as typeof fetch)).toEqual({
      version: '0.1.0',
      minClientVersion: '',
    })

    const down = vi.fn(async () => {
      throw new TypeError('network')
    })
    expect(await fetchServerVersion('https://eta.example.com', down as unknown as typeof fetch)).toBeNull()
  })

  it('refresh 更新全局状态；连不上时保留上一次结果', async () => {
    const ok = vi.fn(
      async () => new Response(JSON.stringify({ version: '99.0.0', minClientVersion: '0.0.1' }), { status: 200 }),
    )
    await refreshVersionCompat('', ok as unknown as typeof fetch)
    expect(versionCompat.result?.status).toBe('client-older')
    const down = vi.fn(async () => {
      throw new TypeError('network')
    })
    await refreshVersionCompat('', down as unknown as typeof fetch)
    expect(versionCompat.result?.status).toBe('client-older')
  })
})

describe('版本提示组件', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetVersionCompat()
    const { auth } = await import('./session')
    auth.mode = 'desktop'
    auth.ready = false
    document.body.innerHTML = ''
  })

  async function mountNotice(body: Record<string, unknown>) {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    vi.stubGlobal('fetch', fetchFn)
    const { auth } = await import('./session')
    auth.mode = 'server'
    auth.ready = true
    const Notice = (await import('../components/VersionCompatNotice.vue')).default
    const w = mount(Notice, { attachTo: document.body })
    await flushPromises()
    return { w, fetchFn }
  }

  it('客户端更旧：可关闭的提示条，提示更新客户端；关闭后不再显示', async () => {
    const { w } = await mountNotice({ version: '99.0.0', minClientVersion: '0.0.1' })
    const banner = w.get('[data-testid=version-banner]')
    expect(banner.text()).toContain('团队服务器已升级到 99.0.0')
    expect(document.querySelector('[data-testid=version-blocked]')).toBeNull()
    await banner.findAll('button').at(-1)!.trigger('click')
    expect(w.find('[data-testid=version-banner]').exists()).toBe(false)
  })

  it('客户端更新：提示请管理员升级服务器', async () => {
    const { w } = await mountNotice({ version: '0.0.1', minClientVersion: '0.0.1' })
    expect(w.get('[data-testid=version-banner]').text()).toContain('请联系管理员升级服务器')
  })

  it('低于最低客户端版本：不可关闭的对话框', async () => {
    const { w } = await mountNotice({ version: '99.0.0', minClientVersion: '99.0.0' })
    expect(w.find('[data-testid=version-banner]').exists()).toBe(false)
    const dialog = document.querySelector('[role=dialog]')
    expect(dialog?.textContent).toContain('低于团队服务器要求的最低版本 99.0.0')
    expect(dialog?.querySelector('.modal-x')).toBeNull()
  })

  it('版本一致不显示；每 30 分钟复查一次', async () => {
    vi.useFakeTimers()
    const { w, fetchFn } = await mountNotice({ version: clientVersion(), minClientVersion: '0.0.1' })
    expect(w.find('[data-testid=version-banner]').exists()).toBe(false)
    const calls = fetchFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(fetchFn.mock.calls.length).toBeGreaterThan(calls)
  })

  it('本机模式不检查', async () => {
    const fetchFn = vi.fn()
    vi.stubGlobal('fetch', fetchFn)
    const { auth } = await import('./session')
    auth.mode = 'desktop'
    auth.ready = true
    const Notice = (await import('../components/VersionCompatNotice.vue')).default
    mount(Notice)
    await flushPromises()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
