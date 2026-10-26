import { expect, test, type Page } from '@playwright/test'

/**
 * 设置 → 关于与更新（契约 §9.2、AUTO-UPDATE.md 第 5 节）：注入与 preload 等价的 window.lulux.updater 假实现，
 * 覆盖 检查 → 发现新版本（纯文本发布说明）→ 下载进度 → 已下载 → 全局“新版本已就绪”提示 → 重启并安装；
 * 设置开关与通道；canAutoInstall=false / canCheck=false；浏览器模式“前往下载页”；作者与许可信息、第三方许可。
 */
interface FakeOpts {
  canCheck?: boolean
  canAutoInstall?: boolean
  limitation?: string | null
}

async function fakeUpdater(page: Page, opts: FakeOpts = {}): Promise<void> {
  await page.addInitScript((o) => {
    const calls: unknown[] = []
    const listeners = new Set<(s: unknown) => void>()
    let settings = { autoCheck: true, autoDownload: false, channel: 'stable', skippedVersion: null as string | null }
    let state: Record<string, unknown> = {
      status: 'idle',
      currentVersion: '0.1.1',
      platform: 'win32',
      arch: 'x64',
      canCheck: o.canCheck ?? true,
      canAutoInstall: o.canAutoInstall ?? true,
      limitation: o.limitation ?? null,
      channel: 'stable',
      source: { provider: 'github', repo: 'koko2376/lulux-eta' },
      downloadPage: 'https://github.com/koko2376/lulux-eta/releases/tag/v0.1.2',
      available: null,
      progress: null,
      lastCheckedAt: null,
      lastError: null,
    }
    const emit = (patch: Record<string, unknown>) => {
      state = { ...state, ...patch }
      for (const l of listeners) l(state)
      return state
    }
    const available = {
      version: '0.1.2',
      releaseName: 'LULUX ETA 0.1.2',
      releaseDate: '2026-10-20T08:00:00Z',
      notes: '<b>新增</b> 关于与更新页\n修复：报价预览',
      prerelease: false,
    }
    const w = window as unknown as Record<string, unknown>
    w.__updCalls = calls
    w.__updEmit = emit
    w.lulux = {
      platform: 'win32',
      titleBar: { style: 'custom', controls: 'right', trafficLightInset: 0, doubleClickMaximizeNative: true },
      win: {
        minimize() {},
        toggleMaximize() {},
        close() {},
        isMaximized: async () => false,
        onMaximizeChange: () => () => undefined,
      },
      updater: {
        check: async () => {
          calls.push('check')
          return emit({ status: 'available', available, lastCheckedAt: new Date().toISOString() })
        },
        download: async () => {
          calls.push('download')
          return emit({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } })
        },
        install: async () => {
          calls.push('install')
          return true
        },
        getState: async () => state,
        onState: (l: (s: unknown) => void) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        getSettings: async () => settings,
        setSettings: async (p: Record<string, unknown>) => {
          calls.push({ setSettings: p })
          settings = { ...settings, ...p }
          return settings
        },
      },
    }
  }, opts)
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __updCalls: unknown[] }).__updCalls)
const emit = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((p) => (window as unknown as { __updEmit: (x: unknown) => void }).__updEmit(p), patch)

test('桌面端：检查 → 新版本（纯文本说明）→ 下载进度 → 已就绪全局提示 → 重启并安装', async ({ page }) => {
  await fakeUpdater(page)
  await page.goto('/#/settings/about')
  await expect(page.getByRole('heading', { name: '软件更新' })).toBeVisible()
  await expect(page.getByTestId('about-version')).toHaveText('v0.1.1')
  await expect(page.getByText('GitHub · koko2376/lulux-eta')).toBeVisible()
  await expect(page.getByRole('img', { name: 'LULUX ETA 标志' })).toBeVisible()

  await page.getByRole('button', { name: '检查更新' }).click()
  await expect(page.getByText('发现新版本 v0.1.2')).toBeVisible()
  await expect(page.getByText('发布于 2026-10-20')).toBeVisible()
  const notes = page.getByTestId('release-notes')
  await expect(notes).toContainText('<b>新增</b> 关于与更新页')
  await expect(notes.locator('b')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '在 GitHub 查看' })).toBeVisible()

  await page.getByRole('button', { name: '下载', exact: true }).click()
  await emit(page, {
    progress: {
      percent: 42.4,
      transferred: 42 * 1024 * 1024,
      total: 100 * 1024 * 1024,
      bytesPerSecond: 2.5 * 1024 * 1024,
    },
  })
  await expect(page.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '42')
  await expect(page.getByText('42% · 42.0 MB / 100 MB · 2.5 MB/s')).toBeVisible()

  await emit(page, { status: 'downloaded', progress: null })
  const banner = page.getByRole('status', { name: '更新提示' })
  await expect(banner).toContainText('新版本 v0.1.2 已就绪')
  // 全局提示不是模态：页面其他部分仍可操作
  await expect(page.locator('[role="dialog"]')).toHaveCount(0)
  await page.getByRole('link', { name: '模型与密钥' }).click()
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: '重启并安装' }).click()
  await banner.getByRole('button', { name: '稍后' }).click()
  await expect(banner).toHaveCount(0)
  expect(await calls(page)).toEqual(['check', 'download', 'install'])
})

test('桌面端：自动检查 / 自动下载开关与更新通道写入 setSettings', async ({ page }) => {
  await fakeUpdater(page)
  await page.goto('/#/settings/about')
  await expect(page.getByRole('switch', { name: '自动检查更新' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('switch', { name: '自动检查更新' }).click()
  await expect(page.getByRole('switch', { name: '自动检查更新' })).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('switch', { name: '自动下载更新' }).click()
  await page.getByRole('radio', { name: '测试版' }).click()
  await expect(page.getByRole('radio', { name: '测试版' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('测试版通道')).toBeVisible()
  expect(await calls(page)).toEqual([
    { setSettings: { autoCheck: false } },
    { setSettings: { autoDownload: true } },
    { setSettings: { channel: 'beta' } },
  ])
})

test('桌面端：未签名 mac 等不能自动安装时为“前往下载页”；未配置更新源时检查按钮置灰', async ({ page }) => {
  await fakeUpdater(page, { canAutoInstall: false, limitation: 'mac-unsigned' })
  await page.goto('/#/settings/about')
  await expect(page.getByRole('switch', { name: '自动下载更新' })).toBeDisabled()
  await page.getByRole('button', { name: '检查更新' }).click()
  await expect(page.getByText('当前 macOS 版本未签名，无法自动更新').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '前往下载页' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载', exact: true })).toHaveCount(0)

  const p2 = await page.context().newPage()
  await fakeUpdater(p2, { canCheck: false, limitation: 'unconfigured' })
  await p2.goto('/#/settings/about')
  await expect(p2.getByText('此版本未配置更新源').first()).toBeVisible()
  await expect(p2.getByRole('button', { name: '检查更新' })).toBeDisabled()
  await p2.close()
})

test('浏览器模式：没有更新操作，只给“前往下载页”；作者、联系邮箱、许可与第三方许可', async ({ page }) => {
  await page.goto('/#/settings/about')
  await expect(page.getByRole('heading', { name: '关于与更新' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '软件更新' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '前往下载页' })).toBeVisible()
  await expect(page.getByRole('button', { name: '检查更新' })).toHaveCount(0)

  await expect(page.getByText('koko · 中国浙江温州')).toBeVisible()
  await expect(page.getByRole('link', { name: 'kokozenshii0308@gmail.com' })).toHaveAttribute(
    'href',
    'mailto:kokozenshii0308@gmail.com',
  )
  await expect(page.locator('#author-title').locator('xpath=../..')).not.toContainText(/定制|培训/)
  await expect(page.getByRole('link', { name: 'github.com/koko2376/lulux-eta' })).toHaveAttribute(
    'href',
    'https://github.com/koko2376/lulux-eta',
  )
  await expect(page.getByTestId('license-name')).toHaveText('Business Source License 1.1')
  await expect(page.getByText('禁止将本软件或其修改版收费销售、收费托管。')).toBeVisible()
  await expect(page.getByText('2030-10-20 起转为 Apache-2.0。')).toBeVisible()

  await page.getByRole('button', { name: '第三方许可' }).click()
  const dialog = page.getByRole('dialog', { name: '第三方许可' })
  await expect(dialog.getByRole('heading', { name: /从 Hermes Agent 导入的内置技能/ })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'vue', exact: true })).toBeVisible()
  await dialog.getByRole('searchbox', { name: '搜索组件或许可证' }).fill('meeting-action')
  await expect(dialog.getByRole('cell', { name: 'meeting-action-items' })).toBeVisible()
  await expect(dialog.getByRole('cell', { name: 'MIT' })).toHaveCount(1)
  await dialog.getByText('NOTICE 全文').click()
  await expect(dialog.getByText(/Copyright \(c\) 2025 Nous Research/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
