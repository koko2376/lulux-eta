import { expect, test, type Page } from '@playwright/test'

/**
 * 会话右侧面板的展开 / 收起按会话记住（localStorage lulux.panel.<accountId>.<sessionId>）：
 * A 收起 → 切到 B（没记过，默认展开详情）→ 切回 A 仍收起；刷新后同样保持。
 */
const stamp = Date.now().toString(36)
const A = `面板记忆A ${stamp}`
const B = `面板记忆B ${stamp}`
const ids: string[] = []

async function create(page: Page, title: string): Promise<void> {
  const res = await page.request.post('/api/sessions', { data: { title, agentIds: ['builtin'] } })
  expect(res.ok()).toBeTruthy()
  ids.push(((await res.json()) as { session: { id: string } }).session.id)
}

async function open(page: Page, title: string): Promise<void> {
  await page.locator('.session-item', { hasText: title }).first().click()
  await expect(page.locator('.chat-header h1')).toContainText(title)
}

test('面板状态按会话记住：收起 → 切会话 → 切回仍收起；另一个会话仍展开', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await create(page, A)
  await create(page, B)
  await page.goto('/#/agent')
  const panel = page.locator('.detail-panel')

  await open(page, A)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: '关闭面板' }).click()
  await expect(panel).toBeHidden()

  await open(page, B)
  await expect(panel).toBeVisible()

  await open(page, A)
  await expect(panel).toBeHidden()

  // 刷新后仍按会话恢复
  await page.reload()
  await open(page, B)
  await expect(panel).toBeVisible()
  await open(page, A)
  await expect(panel).toBeHidden()

  // 用顶栏按钮重新展开也会记住
  await page.getByRole('button', { name: '会话详情' }).click()
  await expect(panel).toBeVisible()
  await open(page, B)
  await open(page, A)
  await expect(panel).toBeVisible()

  for (const id of ids) await page.request.delete(`/api/sessions/${id}`)
})
