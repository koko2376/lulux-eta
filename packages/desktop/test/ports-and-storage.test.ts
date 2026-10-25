import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOCAL_PORT, initialLocalPort } from '../src/local-port'
import { sanitizeUiStorage, UiStorageStore } from '../src/ui-storage'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() }, safeStorage: {} }))

describe('本地端口：固定端口在动态端口段之外，被占用时按固定顺序换', () => {
  it('默认端口不在各系统的动态 / 临时端口段内', () => {
    expect(DEFAULT_LOCAL_PORT).toBeGreaterThanOrEqual(1024)
    expect(DEFAULT_LOCAL_PORT).toBeLessThan(32768)
  })
  it('Windows 上旧的动态段端口迁到固定端口；其他系统、其他端口沿用上次的', () => {
    expect(initialLocalPort(null, 'win32')).toBe(DEFAULT_LOCAL_PORT)
    expect(initialLocalPort(51789, 'win32')).toBe(DEFAULT_LOCAL_PORT)
    expect(initialLocalPort(31795, 'win32')).toBe(31795)
    expect(initialLocalPort(51789, 'darwin')).toBe(51789)
    expect(initialLocalPort(51789, 'linux')).toBe(51789)
  })
  it('pickPort：首选端口被占用 / 被保留时依次试 P+1…，都不行才交给系统分配', async () => {
    const { pickPort } = await import('../src/server')
    const tried: number[] = []
    const busy = new Set([31789, 31790])
    const probe = async (port: number): Promise<number> => {
      tried.push(port)
      if (busy.has(port)) throw new Error('EACCES')
      return port === 0 ? 61000 : port
    }
    expect(await pickPort(31789, probe)).toBe(31791)
    expect(tried).toEqual([31789, 31790, 31791])
    tried.length = 0
    expect(await pickPort(40000, async (port) => (port === 0 ? 61000 : Promise.reject(new Error('x'))), 2)).toBe(61000)
    expect(await pickPort(undefined, probe)).toBe(61000)
  })
})

describe('界面偏好快照：端口变化后在新 origin 还原，会话不进快照', () => {
  it('只收 lulux.* 字符串键，剔除会话键与非本机 origin', () => {
    const snapshot = sanitizeUiStorage({
      origin: 'http://127.0.0.1:31789',
      items: { 'lulux.panel.width': '320', 'lulux.session': 'x', 'lulux.localSession': 'y', other: 'z', 'lulux.n': 1 },
    })
    expect(snapshot?.items).toEqual({ 'lulux.panel.width': '320' })
    expect(sanitizeUiStorage({ origin: 'https://evil.example.com', items: {} })).toBeNull()
  })
  it('保存后可读回', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lulux-ui-')), 'ui-storage.json')
    const store = new UiStorageStore(file)
    expect(store.save({ origin: 'http://127.0.0.1:31789', items: { 'lulux.a': '1' } })).toBe(true)
    expect(new UiStorageStore(file).get()).toMatchObject({ origin: 'http://127.0.0.1:31789', items: { 'lulux.a': '1' } })
    expect(readFileSync(file, 'utf8')).not.toContain('session')
  })
})
