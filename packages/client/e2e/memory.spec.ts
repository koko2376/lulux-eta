import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * 长期记忆（契约 §6.12），真服务 + 可编排的 tools/dev/mock-openai.js：
 * 在对话里说“记住我主营阀门出口到中东” → 模型调用 memory_add（不弹审批）→ 回复里出现“已更新记忆”
 * → 设置 → 记忆里看到这条 → 新会话的系统提示（mock 收到的请求）带上这条记忆。
 * 截图：设置 E2E_MEMORY_SHOTS_DIR 时把设置页（1440×900，中文，浅色）存为 settings.png。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)
const FACT = '主营阀门出口到中东'

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

async function script(page: Page, responses: unknown[]): Promise<void> {
  const res = await page.request.post(`${LLM}/__mock/script`, { data: { responses } })
  expect(res.ok()).toBeTruthy()
}

async function mockRequests(page: Page): Promise<Array<{ messages: Array<{ role: string; content: unknown }> }>> {
  return (await page.request.get(`${LLM}/__mock/requests`)).json()
}

const systemOf = (request: { messages: Array<{ role: string; content: unknown }> }): string =>
  String(request.messages.find((m) => m.role === 'system')?.content ?? '')

async function openSession(page: Page, title: string): Promise<void> {
  await page.goto('/#/agent')
  await page.locator('.session-item', { hasText: title }).first().click()
  await expect(page.locator('.chat-header h1')).toContainText(title)
}

test('准备：独立 Provider、清空记忆与 mock 队列', async ({ page }) => {
  await page.goto('/')
  await page.request.post(`${LLM}/__mock/reset`)
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: `Memory Mock ${stamp}`,
    kind: 'openai',
    baseUrl: `${LLM}/v1`,
    apiKey: 'sk-memory-e2e-0001',
    model: 'mock-model',
    models: ['mock-model'],
  })
  await api(page, 'PATCH', '/api/settings', { defaultProviderId: provider.id, autoTitle: '0', toolApproval: 'ask' })
  await api(page, 'DELETE', '/api/memory')
  await api(page, 'PATCH', '/api/memory/settings', { enabled: true, autoExtract: true })
})

test('对话里说“记住…”：memory_add 不弹审批，回复里显示“已更新记忆”', async ({ page }) => {
  await script(page, [
    { toolCalls: [{ name: 'memory_add', arguments: { section: 'profile', content: FACT } }] },
    { text: `好的，已记住：您${FACT}。之后写开发信和报价会按这个来。` },
  ])
  await api(page, 'POST', '/api/sessions', { title: `记忆验收 ${stamp}`, agentIds: ['builtin'] })
  await openSession(page, `记忆验收 ${stamp}`)
  await page.getByLabel('消息内容').fill(`记住我${FACT}`)
  await page.getByLabel('消息内容').press('Enter')

  const reply = page.locator('.message.assistant').last()
  await expect(reply.locator('.bubble')).toContainText('已记住', { timeout: 20_000 })
  const trace = reply.locator('.tool-trace', { hasText: 'memory_add' })
  await expect(trace).toContainText('保存记忆')
  await expect(trace).toContainText('已完成')
  await expect(trace.getByTestId('memory-updated')).toContainText('已更新记忆')
  // 记忆工具不需要审批：没有出现“允许 / 拒绝”
  await expect(page.locator('.tool-actions')).toHaveCount(0)

  // 刷新后（从持久化的工具轨迹渲染）仍显示
  await page.reload()
  await expect(
    page
      .locator('.message.assistant')
      .last()
      .locator('.tool-trace', { hasText: 'memory_add' })
      .getByTestId('memory-updated'),
  ).toBeVisible()
})

test('设置 → 记忆：看到这条，用量正确；截图', async ({ page }) => {
  await page.goto('/#/settings/memory')
  await expect(page.locator('.side .nav-row.on')).toHaveText('记忆')
  const profile = page.getByTestId('memory-section-profile')
  await expect(profile.getByTestId('memory-entry')).toHaveCount(1)
  await expect(profile.getByTestId('memory-entry')).toContainText(FACT)
  await expect(profile.getByTestId('memory-entry')).toContainText('Agent 保存')
  await expect(profile.getByTestId('memory-usage')).toHaveText(`已用 ${FACT.length} / 2,000 字`)

  // 再手动加一条记忆，截图更接近真实使用
  await page.getByTestId('memory-add-notes').fill('报价默认 FOB Ningbo，美元，有效期 30 天')
  await page.getByTestId('memory-section-notes').getByRole('button', { name: '添加' }).click()
  await expect(page.getByTestId('memory-section-notes').getByTestId('memory-entry')).toContainText('FOB Ningbo')
  // 含密钥的内容被拒绝
  await page.getByTestId('memory-add-notes').fill('OpenAI key 是 sk-proj-AbCdEf0123456789XyZaBcDeF')
  await page.getByTestId('memory-section-notes').getByRole('button', { name: '添加' }).click()
  await expect(page.locator('.toast').last()).toContainText('不能保存凭据')
  await expect(page.getByTestId('memory-section-notes').getByTestId('memory-entry')).toHaveCount(1)
  await page.getByTestId('memory-add-notes').fill('')

  const dir = process.env.E2E_MEMORY_SHOTS_DIR
  if (dir) {
    // 截图前补几条真实感的条目（只在截图时写，不影响下面的断言），刷新让提示条消失
    for (const [section, content] of [
      ['profile', '阀门工厂外贸业务员，负责中东和北非市场'],
      ['profile', '英文邮件偏正式：称呼用 Dear Mr./Ms.，结尾 Best regards，不用缩写和表情'],
      ['notes', '沙特、阿联酋客户周五周六休息，开发信安排在周日到周四上午发'],
      ['notes', '迪拜客户 Al Noor Trading 每季度复购 DN50 不锈钢球阀，询价当天回复'],
    ] as const) {
      await api(page, 'POST', '/api/memory/entries', { section, content })
    }
    await page.reload()
    await expect(page.getByTestId('memory-section-notes').getByTestId('memory-entry')).toHaveCount(3)
    await expect(page.locator('.toast')).toHaveCount(0)
    mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, 'settings.png') })
  }
})

test('新会话：系统提示带上这条记忆（mock 模型收到的请求）', async ({ page }) => {
  await page.request.post(`${LLM}/__mock/reset`)
  await script(page, [{ text: `针对中东的阀门进口商，开发信可以这样开头……` }])
  await api(page, 'POST', '/api/sessions', { title: `记忆新会话 ${stamp}`, agentIds: ['builtin'] })
  await openSession(page, `记忆新会话 ${stamp}`)
  await page.getByLabel('消息内容').fill('帮我写一封开发信的开头')
  await page.getByLabel('消息内容').press('Enter')
  await expect(page.locator('.message.assistant').last().locator('.bubble')).toContainText('中东的阀门进口商', {
    timeout: 20_000,
  })
  const requests = await mockRequests(page)
  expect(requests.length).toBeGreaterThan(0)
  const system = systemOf(requests[0]!)
  expect(system).toContain('## 长期记忆')
  expect(system).toContain(`- ${FACT}`)
  expect(system).toContain('FOB Ningbo')
})

test('仅可查看的会话：模型拿不到记忆工具', async ({ page }) => {
  await page.request.post(`${LLM}/__mock/reset`)
  await script(page, [{ text: '好的' }])
  const { session } = await api<{ session: { id: string } }>(page, 'POST', '/api/sessions', {
    title: `记忆只读 ${stamp}`,
    agentIds: ['builtin'],
    permissionLevel: 'read',
  })
  const res = await page.request.post('/api/chat', { data: { sessionId: session.id, content: '记住我喜欢简洁的邮件' } })
  expect(res.ok()).toBeTruthy()
  const requests = (await mockRequests(page)) as Array<{ tools?: Array<{ function: { name: string } }> }>
  expect(requests.length).toBeGreaterThan(0)
  for (const request of requests) {
    expect((request.tools ?? []).map((t) => t.function.name)).not.toContain('memory_add')
  }
})

test('设置 → 记忆：“群聊中使用我的记忆”默认关，可打开并保存', async ({ page }) => {
  await page.goto('/#/settings/memory')
  const toggle = page.getByTestId('memory-group')
  await expect(page.getByText('群聊中使用我的记忆')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.getByTestId('memory-group')).toHaveAttribute('aria-checked', 'true')
  expect((await api<{ groupMemory: boolean }>(page, 'GET', '/api/memory')).groupMemory).toBe(true)
  await page.getByTestId('memory-group').click()
  await expect(page.getByTestId('memory-group')).toHaveAttribute('aria-checked', 'false')
})

test('关闭长期记忆：新会话不再带记忆；清空全部', async ({ page }) => {
  await page.goto('/#/settings/memory')
  await page.getByTestId('memory-enabled').click()
  await expect(page.getByText('长期记忆已关闭')).toBeVisible()
  await page.request.post(`${LLM}/__mock/reset`)
  await script(page, [{ text: '好的' }])
  const { session } = await api<{ session: { id: string } }>(page, 'POST', '/api/sessions', {
    title: `记忆关闭 ${stamp}`,
    agentIds: ['builtin'],
  })
  const res = await page.request.post('/api/chat', { data: { sessionId: session.id, content: '你好' } })
  expect(res.ok()).toBeTruthy()
  expect(systemOf((await mockRequests(page))[0]!)).not.toContain(FACT)

  await page.getByTestId('memory-enabled').click()
  await page.getByTestId('memory-clear').click()
  await page.getByRole('dialog').getByRole('button', { name: '清空全部' }).click()
  await expect(page.getByTestId('memory-section-profile')).toContainText('还没有条目')
  await expect(page.getByTestId('memory-section-notes')).toContainText('还没有条目')
})
