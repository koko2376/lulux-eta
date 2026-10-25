import { expect, test, type Page } from '@playwright/test'

/**
 * 标题栏按平台（契约 §9.1）：注入 preload 等价的 window.lulux 模拟桌面端。
 * win32：右上角 最小化 / 最大化(还原) / 关闭，图标随最大化状态切换，按钮 no-drag，页头给按钮让位；
 * darwin：不自绘按钮，左上留出原生红绿灯位置；浏览器：不显示窗口按钮。
 */
async function fakeDesktop(page: Page, platform: string, nativeDblClick = true): Promise<void> {
  await page.addInitScript(
    ([p, nativeDbl]) => {
      const calls: string[] = []
      const listeners = new Set<(m: boolean) => void>()
      let maximized = false
      ;(window as unknown as Record<string, unknown>).__wcCalls = calls
      ;(window as unknown as Record<string, unknown>).lulux = {
        platform: p,
        titleBar: {
          style: p === 'darwin' ? 'mac-native' : 'custom',
          controls: p === 'darwin' ? 'left' : 'right',
          trafficLightInset: p === 'darwin' ? 80 : 0,
          doubleClickMaximizeNative: nativeDbl,
        },
        win: {
          minimize: () => calls.push('minimize'),
          toggleMaximize: () => {
            calls.push('toggleMaximize')
            maximized = !maximized
            for (const l of listeners) l(maximized)
          },
          close: () => calls.push('close'),
          isMaximized: async () => maximized,
          onMaximizeChange: (l: (m: boolean) => void) => {
            listeners.add(l)
            return () => listeners.delete(l)
          },
        },
      }
    },
    [platform, nativeDblClick] as [string, boolean],
  )
}

test('Windows：右上角窗口按钮，最大化后切换为“向下还原”，按钮不在拖拽区', async ({ page }) => {
  await fakeDesktop(page, 'win32')
  await page.goto('/#/customers')
  await expect(page.locator('html')).toHaveAttribute('data-chrome', 'win')
  const group = page.getByRole('group', { name: '窗口控制' })
  await expect(group).toBeVisible()
  const box = (await group.boundingBox())!
  expect(Math.round(box.x + box.width)).toBe(page.viewportSize()!.width)
  expect(box.y).toBe(0)
  await expect(page.locator('.app-side .dot')).toHaveCount(0)

  await group.getByRole('button', { name: '最小化' }).click()
  await group.getByRole('button', { name: '最大化' }).click()
  await expect(group.getByRole('button', { name: '向下还原' })).toBeVisible()
  await group.getByRole('button', { name: '向下还原' }).click()
  await expect(group.getByRole('button', { name: '最大化' })).toBeVisible()
  await group.getByRole('button', { name: '关闭' }).click()
  expect(await page.evaluate(() => (window as unknown as { __wcCalls: string[] }).__wcCalls)).toEqual([
    'minimize',
    'toggleMaximize',
    'toggleMaximize',
    'close',
  ])

  await expect(page.locator('.topbar button').last()).toBeVisible()
  const regions = await page.evaluate(() => {
    const region = (el: Element | null) =>
      el
        ? ((getComputedStyle(el) as unknown as Record<string, string>).webkitAppRegion ??
          getComputedStyle(el).getPropertyValue('-webkit-app-region'))
        : null
    return {
      group: region(document.querySelector('.win-controls')),
      btn: region(document.querySelector('.wc-btn')),
      topbar: region(document.querySelector('.topbar')),
      // 顶栏右侧是全局搜索 + 问 LULUX，取顶栏里最后一个按钮
      topbarBtn: region([...document.querySelectorAll('.topbar button')].pop() ?? null),
    }
  })
  // 无头 Chromium 也认 -webkit-app-region；不认时为空串，此时只校验按钮不是 drag
  expect(regions.btn).not.toBe('drag')
  expect(regions.topbarBtn).not.toBeNull()
  expect(regions.topbarBtn).not.toBe('drag')
  if (regions.topbar) expect(regions.topbar).toBe('drag')

  // 页头最右边的按钮不被窗口按钮挡住
  const last = page.locator('.topbar button').last()
  const lb = (await last.boundingBox())!
  expect(lb.x + lb.width).toBeLessThanOrEqual(box.x)

  // 关闭按钮悬停为红色
  await group.getByRole('button', { name: '关闭' }).hover()
  await expect(group.getByRole('button', { name: '关闭' })).toHaveCSS('background-color', 'rgb(196, 43, 28)')
})

test('macOS：不自绘窗口按钮，红绿灯区域（左上约 76×34）里没有任何可点的东西，展开 / 收起侧栏都一样', async ({ page }) => {
  await fakeDesktop(page, 'darwin')
  // 红绿灯区域里每个采样点下面都不能是按钮 / 链接 / 输入框（否则会被窗口按钮挡住点不到）
  const clickableUnderTrafficLights = () =>
    page.evaluate(() => {
      const hits: string[] = []
      for (let x = 8; x <= 72; x += 8)
        for (let y = 6; y <= 34; y += 7) {
          const el = document.elementFromPoint(x, y)
          const hit = el?.closest('a, button, input, textarea, select, [role="button"], [role="tab"]')
          if (hit) hits.push(`${x},${y}:${hit.tagName}.${hit.className}`)
        }
      return hits
    })
  for (const path of ['/#/customers', '/#/agent', '/#/', '/#/mailbox', '/#/workflows', '/#/settings/about']) {
    await page.goto(path)
    await expect(page.locator('html')).toHaveAttribute('data-chrome', 'mac')
    await expect(page.getByRole('group', { name: '窗口控制' })).toHaveCount(0)
    await expect(page.locator('.app-side .as-nav-item').first()).toBeVisible()
    expect(await clickableUnderTrafficLights(), path).toEqual([])
  }
  // 收起侧栏：顶部只剩展开按钮，也要让出红绿灯
  await page.getByTestId('side-toggle').click()
  await expect(page.getByTestId('app-side')).toHaveClass(/collapsed/)
  const top = (await page.locator('.as-top').boundingBox())!
  expect(top.height).toBeGreaterThanOrEqual(52)
  expect(await clickableUnderTrafficLights()).toEqual([])
})

test('浏览器：不显示任何窗口按钮', async ({ page }) => {
  await page.goto('/#/customers')
  await expect(page.locator('html')).toHaveAttribute('data-chrome', 'none')
  await expect(page.getByRole('group', { name: '窗口控制' })).toHaveCount(0)
  await expect(page.locator('.app-side .dot')).toHaveCount(0)
})

test('双击标题栏：doubleClickMaximizeNative=true 交给系统，false（linux）才由界面切换最大化（契约 §9.1）', async ({
  page,
}) => {
  const calls = () => page.evaluate(() => (window as unknown as { __wcCalls: string[] }).__wcCalls)
  await fakeDesktop(page, 'win32', true)
  await page.goto('/#/agent')
  await page.locator('.sidebar-top').dblclick({ position: { x: 4, y: 4 } })
  expect(await calls()).toEqual([])

  const linux = await page.context().newPage()
  await fakeDesktop(linux, 'linux', false)
  await linux.goto('/#/agent')
  await linux.locator('.sidebar-top').dblclick({ position: { x: 4, y: 4 } })
  expect(await linux.evaluate(() => (window as unknown as { __wcCalls: string[] }).__wcCalls)).toEqual([
    'toggleMaximize',
  ])
  await linux.close()
})
