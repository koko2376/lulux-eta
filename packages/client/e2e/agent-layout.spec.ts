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
  const items = page.locator('.rail .rail-item')
  await expect(items.nth(0)).toHaveText('LULUX')
  await expect(items.nth(0)).toHaveAttribute('href', '#/agent')
  await expect(items.nth(1)).toHaveText('工作台')
  await expect(page.locator('.rail')).not.toContainText('Agent')
  await items.nth(0).click()
  await expect(page).toHaveURL(/#\/agent/)
  await expect(items.nth(0)).toHaveClass(/\bon\b/)
})

test('左侧会话列表：页头按钮收起 / 展开，Ctrl+B，刷新后保持；右侧面板不受影响', async ({ page }) => {
  await page.goto('/#/agent')
  const pageEl = page.locator('.agent-page')
  const sidebar = page.locator('.agent-page .sidebar')
  const toggle = page.getByTestId('sidebar-toggle')
  await expect(sidebar).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-label', '收起会话列表')
  await expect(toggle).toHaveAttribute('title', /Ctrl\+B|⌘B/)

  await toggle.click()
  await expect(pageEl).toHaveClass(/sidebar-collapsed/)
  await expect(sidebar).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-label', '展开会话列表')
  expect(await page.evaluate(() => localStorage.getItem('lulux.agent.sidebarCollapsed'))).toBe('1')
  // 收起后对话区占满（会话列表不再占宽度）
  const chat = (await page.locator('.chat-view').boundingBox())!
  const rail = (await page.locator('.rail').boundingBox())!
  expect(chat.x).toBeLessThanOrEqual(rail.x + rail.width + 1)

  await page.reload()
  await expect(pageEl).toHaveClass(/sidebar-collapsed/)
  await expect(sidebar).toBeHidden()

  await page.keyboard.press('Control+b')
  await expect(pageEl).not.toHaveClass(/sidebar-collapsed/)
  await expect(sidebar).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('lulux.agent.sidebarCollapsed'))).toBeNull()

  // 在输入框里也能用快捷键
  await page.locator('.composer textarea').focus()
  await page.keyboard.press('Control+b')
  await expect(pageEl).toHaveClass(/sidebar-collapsed/)
  await page.keyboard.press('Control+b')
  await expect(sidebar).toBeVisible()

  // 右侧面板按会话记住，和左侧收起互不影响
  const detail = page.getByRole('button', { name: '会话详情' })
  if (await detail.count()) {
    const before = await page.locator('.detail-panel').count()
    await toggle.click()
    expect(await page.locator('.detail-panel').count()).toBe(before)
    await toggle.click()
  }
})

test('紧凑密度：正文 14.5px、输入框 14.5px、页头 48px、会话头像 34px', async ({ page }) => {
  await page.goto('/#/agent')
  await expect(page.locator('.chat-header')).toHaveCSS('height', '48px')
  await expect(page.locator('.composer textarea')).toHaveCSS('font-size', '14.5px')
  const avatar = page.locator('.session-item').first().locator('.agent-avatar, .group-avatar')
  if (await avatar.count()) await expect(avatar).toHaveCSS('width', '34px')
  await expect(page.locator('.agent-page .sidebar-search input')).toHaveCSS('height', '32px')
})
