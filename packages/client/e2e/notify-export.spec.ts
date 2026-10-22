import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/** 顶栏通知铃（到期任务 / 逾期应收）与客户 CSV 导出 */
test.describe.configure({ mode: 'serial' })
const stamp = Date.now().toString(36)
const COMPANY = `Bell Test ${stamp} GmbH`

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.request.fetch(path, {
    method,
    data: body === undefined ? undefined : body,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy()
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

test('通知铃：已过期任务出现在面板，可直接完成；Esc / 点外部关闭', async ({ page }) => {
  const c = await api<{ id: string }>(page, 'POST', '/api/customers', { company: COMPANY, country: 'Austria' })
  await api(page, 'POST', '/api/tasks', {
    title: `回访 ${stamp}`,
    customerId: c.id,
    dueAt: Date.now() - 3_600_000,
  })
  await page.goto('/#/customers')
  const bell = page.getByTestId('notify-bell').first()
  await expect(bell.locator('.bell-badge')).toBeVisible()
  await bell.click()
  const panel = page.getByTestId('notify-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText(`回访 ${stamp}`)
  await expect(panel).toContainText('已过期')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await bell.click()
  // 点外部：点顶栏标题（固定坐标在数据多时会点中客户行并跳转，重挂载顶栏）
  await page.getByRole('heading', { level: 1 }).first().click()
  await expect(panel).toHaveCount(0)
  await bell.click()
  await panel.getByRole('button', { name: `把“回访 ${stamp}”标为完成` }).click()
  await expect(panel).not.toContainText(`回访 ${stamp}`)
})

test('客户列表导出 CSV：按当前搜索导出，带 BOM 与表头', async ({ page }) => {
  await page.goto('/#/customers')
  await page.getByPlaceholder(/搜索/).first().fill(stamp)
  await expect(page.locator('main')).toContainText(COMPANY)
  const download = page.waitForEvent('download')
  await page.getByTestId('customers-export').click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^customers-\d{8}-\d{4}\.csv$/)
  const text = readFileSync((await file.path())!, 'utf8')
  expect(text.charCodeAt(0)).toBe(0xfeff)
  const lines = text.trim().split(/\r?\n/)
  expect(lines[0]).toContain('company')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain(COMPANY)
})
