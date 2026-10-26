import { expect, test } from '@playwright/test'

/** 界面语言：设置 → 外观切到 English 立即生效、刷新后保持；切回简体中文 */
test('切换界面语言：即时生效并持久化', async ({ page }) => {
  await page.goto('/#/settings/appearance')
  const group = page.getByTestId('language')
  await expect(group.getByRole('radio', { name: '简体中文' })).toHaveAttribute('aria-checked', 'true')

  await group.getByRole('radio', { name: 'English' }).click()
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByTestId('language').getByRole('radio', { name: 'Follow system' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible()
  await page.goto('/#/customers')
  await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible()
  // 页面里不应残留常见的中文按钮
  await expect(page.getByRole('button', { name: '新建客户' })).toHaveCount(0)

  await page.goto('/#/settings/appearance')
  await page.getByTestId('language').getByRole('radio', { name: '简体中文' }).click()
  await expect(page.getByRole('heading', { name: '外观', level: 1 })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
})
