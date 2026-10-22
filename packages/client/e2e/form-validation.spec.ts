import { expect, test } from '@playwright/test'

/**
 * 表单必填：内联错误（role=alert + .invalid + 聚焦首个错误字段），不是浏览器原生气泡；
 * 窄窗口（<1280）右侧面板是浮层：有遮罩，点遮罩 / Esc 关闭；1280 及以上停靠在右侧。
 */

test('设置表单必填项显示内联错误', async ({ page }) => {
  await page.goto('/#/settings/rules')
  await page
    .getByRole('button', { name: /新建规则|添加规则|新建/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('[data-field="name"]').fill('')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog.getByRole('alert')).toContainText('请填写规则名称')
  await expect(dialog.locator('[data-field="name"]')).toBeFocused()
  await expect(dialog.locator('[data-field="name"]')).toHaveClass(/invalid/)
  await dialog.locator('[data-field="name"]').fill('x')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('button', { name: '取消' }).click()

  await page.goto('/#/settings/templates')
  await page.getByRole('button', { name: '新建模板' }).first().click()
  const tpl = page.getByRole('dialog')
  await tpl.getByRole('button', { name: '保存' }).click()
  await expect(tpl.getByRole('alert')).toHaveCount(2)
  await expect(tpl.locator('[data-field="name"]')).toBeFocused()
})

test('窄窗口右侧面板：遮罩 + 点外部 / Esc 关闭', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/#/agent')
  const toggle = page.getByRole('button', { name: '会话详情' })
  await expect(toggle).toBeVisible()
  await expect(page.locator('.detail-panel')).toHaveCount(0)
  await toggle.click()
  await expect(page.locator('.detail-panel')).toBeVisible()
  await expect(page.locator('.panel-backdrop')).toBeVisible()
  await page.mouse.click(300, 400)
  await expect(page.locator('.detail-panel')).toHaveCount(0)
  await toggle.click()
  await expect(page.locator('.detail-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.detail-panel')).toHaveCount(0)
  // 1440 停靠：不显示遮罩
  await page.setViewportSize({ width: 1440, height: 900 })
  await toggle.click()
  await expect(page.locator('.detail-panel')).toBeVisible()
  await expect(page.locator('.panel-backdrop')).toBeHidden()
})
