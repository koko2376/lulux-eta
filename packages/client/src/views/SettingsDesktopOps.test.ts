import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'
import type { UpdaterSettings, UpdaterState } from '../lib/updater'

const stubs = { SettingsSidebar: true, PageTopbar: true, RouterLink: true, teleport: true, ThirdPartyLicenses: true }

function updaterState(extra: Partial<UpdaterState> = {}): UpdaterState {
  return {
    status: 'idle',
    currentVersion: '0.1.1',
    platform: 'win32',
    arch: 'x64',
    canCheck: true,
    canAutoInstall: true,
    limitation: null,
    channel: 'stable',
    source: { provider: 'github', repo: 'acme/lulux-eta' },
    downloadPage: null,
    available: null,
    progress: null,
    lastCheckedAt: null,
    lastError: null,
    ...extra,
  }
}

function installBridge(state: UpdaterState, settings: UpdaterSettings) {
  const updaterBridge = {
    check: vi.fn(async () => state),
    download: vi.fn(),
    install: vi.fn(),
    getState: vi.fn(async () => state),
    onState: vi.fn(() => () => undefined),
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (patch: Partial<UpdaterSettings>) => ({ ...settings, ...patch })),
  }
  const desktop = {
    getPrefs: vi.fn(async () => ({
      closeToTray: true,
      launchAtLogin: false,
      platform: 'win32',
      trayAvailable: true,
      launchAtLoginSupported: true,
    })),
    setPrefs: vi.fn(async (patch: Record<string, boolean>) => ({
      closeToTray: true,
      launchAtLogin: false,
      platform: 'win32',
      trayAvailable: true,
      launchAtLoginSupported: true,
      ...patch,
    })),
    openLogsDir: vi.fn(async () => true),
    exportDiagnostics: vi.fn(async () => ({ ok: true, path: 'C:/Users/x/Downloads/d.zip', files: 3 })),
    onCommand: vi.fn(() => () => undefined),
    onNotice: vi.fn(() => () => undefined),
  }
  ;(window as unknown as { lulux: unknown }).lulux = { platform: 'win32', updater: updaterBridge, desktop }
  return { updaterBridge, desktop }
}

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(api, 'getHealth').mockResolvedValue({ ok: true } as never)
})

afterEach(() => {
  delete (window as unknown as { lulux?: unknown }).lulux
  auth.mode = 'desktop'
  auth.me = null
  vi.restoreAllMocks()
})

describe('设置 → 桌面', () => {
  it('显示托盘 / 开机自启动开关并写回主进程', async () => {
    const { desktop } = installBridge(updaterState(), {
      autoCheck: true,
      autoDownload: true,
      channel: 'stable',
      skippedVersion: null,
    })
    const View = (await import('./SettingsDesktopView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    const switches = wrapper.findAll('[role="switch"]')
    expect(switches).toHaveLength(2)
    expect(wrapper.text()).toContain('关闭窗口时最小化到托盘')
    expect(wrapper.text()).toContain('开机自启动')
    await switches[1]!.trigger('click')
    await flushPromises()
    expect(desktop.setPrefs).toHaveBeenCalledWith({ launchAtLogin: true })
  })

  it('系统没有安全存储：如实提示已用本机文件保存；有退出应用的入口', async () => {
    const { desktop } = installBridge(updaterState(), {
      autoCheck: true,
      autoDownload: true,
      channel: 'stable',
      skippedVersion: null,
    })
    desktop.getPrefs.mockResolvedValue({
      closeToTray: false,
      launchAtLogin: false,
      platform: 'linux',
      trayAvailable: false,
      launchAtLoginSupported: true,
      secureStorage: false,
    } as never)
    const quit = vi.fn(async () => true)
    Object.assign(desktop, { quit })
    const View = (await import('./SettingsDesktopView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-testid="desktop-storage-file"]').text()).toContain('系统没有安全存储，已用本机文件保存')
    await wrapper.find('[data-testid="desktop-quit"]').trigger('click')
    expect(quit).toHaveBeenCalled()
  })

  it('有安全存储时不显示本机文件提示', async () => {
    installBridge(updaterState(), { autoCheck: true, autoDownload: true, channel: 'stable', skippedVersion: null })
    const View = (await import('./SettingsDesktopView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-testid="desktop-storage-file"]').exists()).toBe(false)
  })

  it('浏览器里没有桌面桥时只给说明', async () => {
    const View = (await import('./SettingsDesktopView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-testid="desktop-prefs"]').exists()).toBe(false)
  })
})

describe('设置 → 关于：诊断与更新源', () => {
  it('桌面端：打开日志目录、导出诊断包', async () => {
    const { desktop } = installBridge(updaterState(), {
      autoCheck: true,
      autoDownload: true,
      channel: 'stable',
      skippedVersion: null,
      feedUrl: null,
    })
    const View = (await import('./SettingsAboutView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    await wrapper.get('[data-testid="open-logs"]').trigger('click')
    await wrapper.get('[data-testid="export-diagnostics"]').trigger('click')
    await flushPromises()
    expect(desktop.openLogsDir).toHaveBeenCalled()
    expect(desktop.exportDiagnostics).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="server-logs"]').exists()).toBe(false)
  })

  it('更新源地址：保存 / 恢复默认，主进程报错时就地显示', async () => {
    const { updaterBridge } = installBridge(updaterState(), {
      autoCheck: true,
      autoDownload: true,
      channel: 'stable',
      skippedVersion: null,
      feedUrl: null,
    })
    const View = (await import('./SettingsAboutView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    const row = wrapper.get('[data-testid="update-feed"]')
    await row.get('input').setValue('https://mirror.example.com/lulux')
    await row.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(updaterBridge.setSettings).toHaveBeenCalledWith({ feedUrl: 'https://mirror.example.com/lulux' })

    updaterBridge.setSettings.mockRejectedValueOnce(
      new Error("Error invoking remote method 'updater:set-settings': Error: 更新源地址只支持 http:// 或 https://"),
    )
    await row.get('input').setValue('ftp://x')
    await row.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(row.get('[role="alert"]').text()).toBe('更新源地址只支持 http:// 或 https://')
  })

  it('手动检查失败（网络）显示明确说明与原始信息', async () => {
    installBridge(
      updaterState({
        status: 'error',
        lastError: {
          message: 'net::ERR_NAME_NOT_RESOLVED',
          at: '2026-10-21T00:00:00Z',
          interactive: true,
          kind: 'network',
        },
      }),
      { autoCheck: true, autoDownload: true, channel: 'stable', skippedVersion: null, feedUrl: null },
    )
    const View = (await import('./SettingsAboutView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    expect(wrapper.get('[data-testid="update-error"]').text()).toContain('连不上更新服务器')
    expect(wrapper.text()).toContain('net::ERR_NAME_NOT_RESOLVED')
  })

  it('浏览器访问团队服务器：管理员可以下载服务器日志，成员看不到', async () => {
    const session = await import('../lib/session')
    session.auth.mode = 'server'
    session.auth.me = {
      mode: 'server',
      user: { id: 'a', email: 'a@x.com', name: 'A', role: 'admin', disabled: false, createdAt: 0, lastLoginAt: null },
      org: { id: 'o', name: 'Acme', createdAt: 0 },
      teams: [],
      permissions: [...api.ALL_PERMISSIONS].filter((p) => p !== 'security:manage'),
      session: null,
    } as never
    const builtin = await import('../api/builtin')
    const download = vi.spyOn(builtin, 'downloadServerLogs').mockResolvedValue(new Blob(['zip']))
    const dl = await import('../lib/download')
    const save = vi.spyOn(dl, 'downloadBlob').mockImplementation(() => undefined)
    const View = (await import('./SettingsAboutView.vue')).default
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-testid="open-logs"]').exists()).toBe(false)
    await wrapper.get('[data-testid="server-logs"]').trigger('click')
    await flushPromises()
    expect(download).toHaveBeenCalledWith(3)
    expect(save.mock.calls[0]![1]).toMatch(/^lulux-server-logs-\d{8}\.zip$/)
    wrapper.unmount()

    const admin = session.auth.me as unknown as { user: Record<string, unknown> }
    session.auth.me = { ...admin, user: { ...admin.user, role: 'member' }, permissions: ['data:read'] } as never
    const member = mount(View, { global: { stubs } })
    await flushPromises()
    expect(member.find('[data-testid="diagnostics"]').exists()).toBe(false)
  })
})
