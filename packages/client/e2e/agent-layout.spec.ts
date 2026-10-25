import { expect, test } from '@playwright/test'

/**
 * 主导航与 Agent 页版式：
 * - “LULUX”（Agent 会话）在导航第一位，但进入应用的首页仍是工作台；
 * - 左侧会话列表可收起（页头按钮 / Ctrl+B），状态记在 localStorage，刷新后保持；
 * - 紧凑密度：正文 14.5px、页头 48px、会话头像 34px。
 */
test.describe.configure({ mode: 'serial' })

test('导航：LULUX 排第一、工作台第二；打开应用落在工作台', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await expect(page).not.toHaveURL(/#\/agent/)
  const items = page.locator('.app-side .as-nav .as-nav-item')
  await expect(items).toHaveCount(6)
  await expect(items.nth(0)).toHaveText('LULUX')
  await expect(items.nth(0)).toHaveAttribute('href', '#/agent')
  await expect(items.nth(1)).toHaveText('工作台')
  await expect(page.locator('.app-side .as-nav')).not.toContainText('Agent')
  await items.nth(0).click()
  await expect(page).toHaveURL(/#\/agent/)
  await expect(items.nth(0)).toHaveClass(/\bon\b/)
})

test('侧栏：底部按钮收起 / 展开，Ctrl+B，刷新后保持；收起后只剩图标栏，对话区占满', async ({ page }) => {
  await page.goto('/#/agent')
  const shell = page.locator('.shell')
  const side = page.getByTestId('app-side')
  const sessions = page.locator('.app-side .sidebar')
  const toggle = page.getByTestId('side-toggle')
  await expect(sessions).toBeVisible()
  // 对话页头不再重复放收起按钮
  await expect(page.locator('.chat-header .sidebar-toggle')).toBeHidden()
  await expect(toggle).toHaveCount(1)
  await expect(toggle).toHaveAttribute('aria-label', '收起侧栏')
  await expect(toggle).toHaveAttribute('title', /Ctrl\+B|⌘B/)

  await toggle.click()
  await expect(shell).toHaveClass(/side-collapsed/)
  await expect(side).toHaveClass(/collapsed/)
  await expect(sessions).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-label', '展开侧栏')
  expect(await page.evaluate(() => localStorage.getItem('lulux.agent.sidebarCollapsed'))).toBe('1')
  // 侧栏宽度有过渡动画：等动画结束再量（对话区紧贴图标栏右边，允许 1px 分隔线 + 亚像素）
  await expect
    .poll(async () => {
      const chat = (await page.locator('.chat-view').boundingBox())!
      const rail = (await side.boundingBox())!
      return rail.width <= 72 && chat.x <= rail.x + rail.width + 1.5
    })
    .toBe(true)
  // 收起后 6 个入口仍在（只剩图标），可点
  await expect(page.locator('.app-side .as-nav-item')).toHaveCount(6)

  await page.reload()
  await expect(shell).toHaveClass(/side-collapsed/)
  await expect(sessions).toBeHidden()

  await page.keyboard.press('Control+b')
  await expect(shell).not.toHaveClass(/side-collapsed/)
  await expect(sessions).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('lulux.agent.sidebarCollapsed'))).toBeNull()

  // 在输入框里也能用快捷键
  await page.locator('.composer textarea').focus()
  await page.keyboard.press('Control+b')
  await expect(shell).toHaveClass(/side-collapsed/)
  await page.keyboard.press('Control+b')
  await expect(sessions).toBeVisible()
})

test('版式：页头 52px、输入框 15px、会话搜索框 36px', async ({ page }) => {
  await page.goto('/#/agent')
  await expect(page.locator('.chat-header')).toHaveCSS('height', '52px')
  await expect(page.locator('.composer textarea')).toHaveCSS('font-size', '15px')
  await expect(page.locator('.app-side .sidebar-search input')).toHaveCSS('height', '36px')
})
