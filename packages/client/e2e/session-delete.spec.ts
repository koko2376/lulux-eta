import { expect, test, type Page } from '@playwright/test'

/**
 * 右键会话 → 删除会话：应用内确认框（不是原生 confirm）在 1440/1280/1024 三个尺寸下
 * 完整可见、居中、压在菜单之上；Esc/取消关闭；确认后删除并选中相邻会话；群聊、当前会话、生成中会话都可删。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)

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

async function newSession(page: Page, title: string, agentIds = ['builtin']): Promise<string> {
  const { session } = await api<{ session: { id: string } }>(page, 'POST', '/api/sessions', { title, agentIds })
  return session.id
}

/** 确认框可见、在视口内、水平居中、且最上层元素就是确认框（菜单没有压住它） */
async function expectDialogOnTop(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '删除会话' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.locator('.context-menu')).toHaveCount(0)
  const box = (await dialog.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(4)
  for (const name of ['取消', '删除']) {
    const btn = dialog.getByRole('button', { name, exact: true })
    const b = (await btn.boundingBox())!
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('[role="dialog"]') !== null,
      [b.x + b.width / 2, b.y + b.height / 2],
    )
    expect(hit, `${name} 按钮被遮挡`).toBeTruthy()
  }
}

async function openDelete(page: Page, title: string): Promise<void> {
  await page.locator('.session-item', { hasText: title }).first().click({ button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()
  await page.locator('.context-menu').getByRole('button', { name: '删除会话' }).click()
}

for (const [w, h] of [
  [1440, 900],
  [1280, 800],
  [1024, 700],
] as const) {
  test(`删除会话确认框 ${w}×${h}：可见、居中、在菜单之上；Esc/取消关闭；确认删除并选中相邻会话`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h })
    await page.goto('/')
    // 等首屏路由完成：vue-router 在首次导航结束前不监听 hashchange，紧接着的 goto('/#/agent') 会被吞掉（工作台请求较多时偶发）
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
    await expect(page.locator('main .topbar')).toBeVisible()
    let nativeDialog = false
    page.on('dialog', (d) => {
      nativeDialog = true
      void d.dismiss()
    })
    const a = `删除验收A ${w} ${stamp}`
    const b = `删除验收B ${w} ${stamp}`
    const g = `删除验收群 ${w} ${stamp}`
    await newSession(page, a)
    await newSession(page, b)
    await newSession(page, g, ['builtin', 'kernel-claude-code'])
    await page.goto('/#/agent')
    await page.locator('.session-item', { hasText: b }).first().click()
    await expect(page.locator('.chat-header h1')).toContainText(b)

    // Esc 关闭，不删除
    await openDelete(page, b)
    await expectDialogOnTop(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.session-item', { hasText: b })).toHaveCount(1)

    // 取消关闭，不删除
    await openDelete(page, b)
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.session-item', { hasText: b })).toHaveCount(1)

    // 确认删除当前会话：选中另一个会话
    await openDelete(page, b)
    await expectDialogOnTop(page)
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.session-item', { hasText: b })).toHaveCount(0)
    await expect(page.locator('.session-item.active')).toHaveCount(1)
    await expect(page.locator('.chat-header h1')).not.toContainText(b)

    // 群聊
    await openDelete(page, g)
    await expectDialogOnTop(page)
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.locator('.session-item', { hasText: g })).toHaveCount(0)
    await expect(page.locator('.context-menu')).toHaveCount(0)

    // 删除后输入框仍可聚焦（原生 confirm 在 Electron 下会让焦点丢失）
    await page.locator('.session-item', { hasText: a }).first().click()
    await page.getByLabel('消息内容').click()
    await expect(page.getByLabel('消息内容')).toBeFocused()
    expect(nativeDialog, '不应弹出原生 confirm').toBeFalsy()
    await expect(page.locator('.toast.error')).toHaveCount(0)
  })
}

test('生成中的会话：删除前先停止，再删除', async ({ page }) => {
  await page.goto('/')
  // 用本文件自己的 Provider（指向可编排的 mock），不依赖其他 spec 设置的默认 Provider
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: `Delete Mock ${stamp}`,
    kind: 'openai',
    baseUrl: `${LLM}/v1`,
    apiKey: 'sk-delete-e2e-0001',
    model: 'mock-model',
    models: ['mock-model'],
  })
  await page.request.post(`${LLM}/__mock/script`, {
    data: { responses: [{ text: '很长的回答，'.repeat(80), chunkSize: 4, delayMs: 150 }] },
  })
  const title = `删除生成中 ${stamp}`
  await api(page, 'POST', '/api/sessions', { title, agentIds: ['builtin'], providerId: provider.id })
  await page.goto('/#/agent')
  await page.locator('.session-item', { hasText: title }).first().click()
  await page.getByLabel('消息内容').fill('写一段很长的开发信')
  await page.getByLabel('消息内容').press('Enter')
  await expect(page.locator('.session-item', { hasText: title }).locator('.session-preview.running')).toBeVisible({
    timeout: 10_000,
  })
  await openDelete(page, title)
  const dialog = page.getByRole('dialog', { name: '删除会话' })
  await expect(dialog).toContainText('正在生成')
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.locator('.session-item', { hasText: title })).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.toast.error')).toHaveCount(0)
})
