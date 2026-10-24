import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * 输入框右侧的模型 / 推理强度选择器（契约 §6.13），真服务 + tools/dev/mock-openai.js：
 * 在选择器里切换模型（二级菜单）与推理强度（滑块），按会话保存；发消息时假模型收到所选的 model 与 reasoning_effort。
 * E2E_MODEL_SHOTS=<dir> 时额外截图：弹层 + 模型二级菜单（1440×900，中文，浅色），以及打开详情面板时的输入框。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)
const TITLE = `模型选择 ${stamp}`
const PROVIDER = `Picker Mock ${stamp}`
let sessionId = ''
let providerId = ''
let restore: Record<string, unknown> = {}

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

async function sessionState(page: Page): Promise<{ model: string | null; reasoningEffort: string | null }> {
  return (
    await api<{ session: { model: string | null; reasoningEffort: string | null } }>(
      page,
      'GET',
      `/api/sessions/${sessionId}`,
    )
  ).session
}

async function openSession(page: Page): Promise<void> {
  await page.goto('/#/agent')
  await page.locator('.session-item', { hasText: TITLE }).first().click()
  await expect(page.locator('.chat-header h1')).toContainText(TITLE)
}

async function openModelSubmenu(page: Page): Promise<void> {
  await page.getByTestId('model-picker').click()
  await expect(page.getByTestId('model-menu')).toBeVisible()
  await page.getByTestId('model-row').click()
  await expect(page.getByTestId('model-submenu')).toBeVisible()
}

test('准备：带多个模型的 Provider，LULUX 单聊', async ({ page }) => {
  await page.goto('/')
  const settings = await api<Record<string, unknown>>(page, 'GET', '/api/settings')
  const current = (settings.settings ?? settings) as Record<string, unknown>
  restore = {
    defaultProviderId: current.defaultProviderId ?? '',
    autoTitle: current.autoTitle,
    reasoningEffort: current.reasoningEffort ?? 'off',
  }
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: PROVIDER,
    kind: 'openai',
    baseUrl: `${LLM}/v1`,
    apiKey: 'sk-model-e2e-0001',
    model: 'mock-model',
    models: ['mock-model', 'gpt-5.2', 'o3-mini'],
  })
  providerId = provider.id
  await api(page, 'PATCH', '/api/settings', { defaultProviderId: provider.id, autoTitle: '0', reasoningEffort: 'off' })
  const { session } = await api<{ session: { id: string } }>(page, 'POST', '/api/sessions', {
    title: TITLE,
    agentIds: ['builtin'],
  })
  sessionId = session.id
})

test('切换模型与推理强度：按会话保存，假模型收到所选 model 与 reasoning_effort', async ({ page }) => {
  await openSession(page)
  const picker = page.getByTestId('model-picker')
  await expect(picker).toContainText('mock-model')

  // 默认模型不是推理模型：滑块除“关闭”外全部置灰
  await picker.click()
  const menu = page.getByTestId('model-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('更快')
  await expect(menu).toContainText('更聪明')
  await expect(menu.locator('.mp-stop[data-level="xhigh"]')).toBeDisabled()
  await expect(menu.getByTestId('effort-unsupported')).toBeVisible()

  // 二级菜单：默认在第一个
  await page.getByTestId('model-row').click()
  const sub = page.getByTestId('model-submenu')
  await expect(sub).toBeVisible()
  await expect(sub.locator('.mp-option').first()).toContainText('默认')
  // 只有一个 Provider 时不显示分组标题；多个时按 Provider 分组
  if (await sub.locator('.mp-group').count())
    await expect(sub.locator('.mp-group', { hasText: PROVIDER })).toBeVisible()
  await expect(sub.locator('.mp-option[data-model="gpt-5.2"]')).toBeVisible()
  await sub.locator('.mp-option[data-model="gpt-5.2"]').first().click()
  await expect(sub).toBeHidden()
  await expect(picker).toHaveAttribute('data-model', 'gpt-5.2')
  await expect.poll(async () => (await sessionState(page)).model).toBe('gpt-5.2')

  // 推理强度：gpt-5.2 支持极高
  await picker.click()
  await expect(menu.locator('.mp-stop[data-level="xhigh"]')).toBeEnabled()
  await menu.locator('.mp-stop[data-level="xhigh"]').click()
  await expect(picker).toHaveAttribute('data-effort', 'xhigh')
  await expect(picker).toContainText('极高')
  await expect.poll(async () => (await sessionState(page)).reasoningEffort).toBe('xhigh')
  await page.keyboard.press('Escape')

  await page.request.post(`${LLM}/__mock/reset`)
  await page.request.post(`${LLM}/__mock/script`, { data: { responses: [{ text: '已用所选模型回答。' }] } })
  await page.getByLabel('消息内容').fill('用选好的模型回答')
  await page.getByLabel('消息内容').press('Enter')
  await expect(page.locator('.message.assistant').last()).toContainText('已用所选模型回答', { timeout: 20_000 })
  const requests = (await (await page.request.get(`${LLM}/__mock/requests`)).json()) as Array<{
    model?: string
    reasoning_effort?: string
  }>
  expect(requests[0]?.model).toBe('gpt-5.2')
  expect(requests[0]?.reasoning_effort).toBe('xhigh')

  // 重新打开会话仍是所选模型
  await openSession(page)
  await expect(page.getByTestId('model-picker')).toHaveAttribute('data-model', 'gpt-5.2')
})

test('截图：弹层 + 模型二级菜单；详情面板打开时输入框不溢出（仅在设置 E2E_MODEL_SHOTS 时）', async ({ page }) => {
  const dir = process.env.E2E_MODEL_SHOTS || ''
  test.skip(!dir, '未设置 E2E_MODEL_SHOTS')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await openSession(page)
  const detail = page.getByRole('button', { name: '会话详情' })
  // 先在详情面板关闭时截图（胶囊显示完整的“模型名 强度”）
  if (await detail.evaluate((el) => el.classList.contains('active'))) await detail.click()
  await openModelSubmenu(page)
  await page.waitForTimeout(300)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, 'picker.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await detail.click()
  await expect(detail).toHaveClass(/active/)
  await page.waitForTimeout(300)
  const composer = page.locator('.composer')
  const box = await composer.boundingBox()
  const scroll = await composer.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
  expect(scroll.sw).toBeLessThanOrEqual(scroll.cw + 1)
  const send = await page.locator('.composer-send').boundingBox()
  expect(send && box && send.x + send.width <= box.x + box.width).toBeTruthy()
  await page.screenshot({ path: join(dir, 'detail-open.png') })
})

test('收尾：恢复全局设置、删除测试 Provider', async ({ page }) => {
  await page.goto('/')
  const body = Object.fromEntries(Object.entries(restore).filter(([, value]) => value !== undefined))
  if (Object.keys(body).length) await api(page, 'PATCH', '/api/settings', body)
  if (sessionId) await page.request.delete(`/api/sessions/${sessionId}`)
  if (providerId) await page.request.delete(`/api/providers/${providerId}`)
})
