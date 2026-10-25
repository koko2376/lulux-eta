import { expect, test, type Page } from '@playwright/test'

/**
 * 服务端持有的会话运行（契约 §6.9）：关窗 / 刷新 / 切会话都不会停止运行；重新打开时接上运行流，
 * 实时显示进度直到完成；停止按钮显式取消。真服务 + 可编排的 tools/dev/mock-openai.js（delayMs 让回复足够慢）。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)
let providerId = ''

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

/** 20 段、每段一个 chunk、每 chunk 250ms：约 5 秒的回复 */
const PARTS = Array.from({ length: 20 }, (_, i) => `第${i + 1}段。`)
const REPLY = PARTS.join('')

async function slowReply(page: Page): Promise<void> {
  await page.request.post(`${LLM}/__mock/reset`)
  await page.request.post(`${LLM}/__mock/script`, {
    data: { responses: [{ text: REPLY, chunkSize: PARTS[0].length, delayMs: 250 }] },
  })
}

async function newSession(page: Page, title: string): Promise<string> {
  if (!providerId) {
    const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
      name: `Detached Mock ${stamp}`,
      kind: 'openai',
      baseUrl: `${LLM}/v1`,
      apiKey: 'sk-detached-e2e-0001',
      model: 'mock-model',
      models: ['mock-model'],
    })
    providerId = provider.id
  }
  const { session } = await api<{ session: { id: string } }>(page, 'POST', '/api/sessions', {
    title,
    agentIds: ['builtin'],
    providerId,
  })
  return session.id
}

async function openSession(page: Page, id: string, title: string): Promise<void> {
  await page.goto(`/#/agent?session=${id}`)
  await expect(page.locator('.chat-header h1')).toContainText(title)
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel('消息内容').fill(text)
  await page.getByLabel('消息内容').press('Enter')
}

/** 正在流式显示的气泡（带光标）已有部分内容 */
async function expectStreamingPartial(page: Page): Promise<string> {
  const bubble = page.locator('.bubble', { has: page.locator('.caret') })
  await expect(bubble).toContainText('第1段', { timeout: 15_000 })
  return (await bubble.innerText()).trim()
}

async function expectFinished(page: Page, id: string): Promise<void> {
  // 完成：光标消失，只有一条完整的助手消息（草稿与回放不重复）
  const assistant = page.locator('article.message.assistant')
  await expect(assistant.last()).toContainText('第20段。', { timeout: 20_000 })
  await expect(page.locator('.caret')).toHaveCount(0)
  await expect(assistant).toHaveCount(1)
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  const detail = await api<{
    session: { running: boolean }
    messages: Array<{ role: string; content: string; finishReason: string | null }>
  }>(page, 'GET', `/api/sessions/${id}`)
  expect(detail.session.running).toBe(false)
  const replies = detail.messages.filter((m) => m.role === 'assistant')
  expect(replies).toHaveLength(1)
  expect(replies[0]).toMatchObject({ content: REPLY, finishReason: 'stop' })
}

test('生成中刷新页面：运行不停，刷新后接上流继续实时显示直到完成', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  const title = `刷新不停 ${stamp}`
  const id = await newSession(page, title)
  await slowReply(page)
  await openSession(page, id, title)
  await sendMessage(page, '写一段很长的开发信')
  const before = await expectStreamingPartial(page)
  expect(before).not.toContain('第20段')

  await page.reload()
  await expect(page.locator('.chat-header h1')).toContainText(title)
  // 刷新后：侧栏运行中、停止按钮在、流式气泡接着增长
  await expect(page.locator('.session-item', { hasText: title }).locator('.session-preview.running')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
  const bubble = page.locator('.bubble', { has: page.locator('.caret') })
  await expect(bubble).toContainText(before.replace(/\s+/g, '').slice(0, 6))
  await expect(bubble).toContainText('第12段', { timeout: 15_000 })
  await expectFinished(page, id)
  await expect(page.locator('.toast.error')).toHaveCount(0)
})

test('生成中关闭页面、稍后重新打开：运行在服务端跑完，打开即看到进度与结果', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  const title = `关窗不停 ${stamp}`
  const id = await newSession(page, title)
  await slowReply(page)
  await openSession(page, id, title)
  await sendMessage(page, '写一段很长的开发信')
  await expectStreamingPartial(page)
  await page.close()

  // 关窗期间服务端继续跑：重新打开时仍在运行，接上后看到进度
  const reopened = await context.newPage()
  await reopened.goto('/')
  await expect(reopened.getByRole('navigation', { name: '主导航' })).toBeVisible()
  const state = await api<{ session: { running: boolean; activeRunId: string | null } }>(
    reopened,
    'GET',
    `/api/sessions/${id}`,
  )
  expect(state.session.running).toBe(true)
  expect(state.session.activeRunId).toMatch(/^run_/)
  await openSession(reopened, id, title)
  await expect(reopened.locator('.bubble', { has: reopened.locator('.caret') })).toContainText('第1段')
  await expectFinished(reopened, id)

  // 运行结束后关窗再开：直接是完整结果
  await reopened.close()
  const later = await context.newPage()
  await later.goto('/')
  await expect(later.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await openSession(later, id, title)
  await expect(later.locator('article.message.assistant')).toHaveCount(1)
  await expect(later.locator('article.message.assistant')).toContainText('第20段。')
})

test('切到别的会话再切回：运行不停；重新打开后点停止 → 显式取消，保留已输出部分', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  const title = `停止接上 ${stamp}`
  const other = `另一个会话 ${stamp}`
  const id = await newSession(page, title)
  const otherId = await newSession(page, other)
  await slowReply(page)
  await openSession(page, id, title)
  await sendMessage(page, '写一段很长的开发信')
  await expectStreamingPartial(page)

  // 切走再切回：仍在生成
  await page.locator('.session-item', { hasText: other }).first().click()
  await expect(page.locator('.chat-header h1')).toContainText(other)
  await expect(page.locator('.session-item', { hasText: title }).locator('.session-preview.running')).toBeVisible()
  await page.locator('.session-item', { hasText: title }).first().click()
  await expect(page.locator('.bubble', { has: page.locator('.caret') })).toContainText('第3段', { timeout: 15_000 })
  expect(otherId).toBeTruthy()

  // 关窗重开后停止
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('/')
  await expect(reopened.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await openSession(reopened, id, title)
  await expect(reopened.locator('.bubble', { has: reopened.locator('.caret') })).toContainText('第1段')
  await reopened.getByRole('button', { name: '停止生成' }).click()
  const assistant = reopened.locator('article.message.assistant')
  await expect(assistant).toHaveCount(1, { timeout: 10_000 })
  await expect(assistant.locator('.message-flag')).toHaveText('已停止')
  await expect(reopened.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  const detail = await api<{
    session: { running: boolean }
    messages: Array<{ role: string; content: string; finishReason: string }>
  }>(reopened, 'GET', `/api/sessions/${id}`)
  expect(detail.session.running).toBe(false)
  const reply = detail.messages.find((m) => m.role === 'assistant')!
  expect(reply.finishReason).toBe('aborted')
  expect(REPLY.startsWith(reply.content)).toBe(true)
  expect(reply.content.length).toBeLessThan(REPLY.length)
})
