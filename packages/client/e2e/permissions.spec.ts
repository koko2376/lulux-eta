import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * 会话权限级别（契约 §6.11），真服务 + tools/dev/mock-openai.js 的 /__mock/script 编排：
 * - 仅可查看：写工具不提供给模型；模型硬要调用也直接拒绝，不弹审批卡片，不写库
 * - 完全权限：写工具直接执行，不弹卡片
 * - 需审批：写工具弹审批卡片，允许后执行
 * 级别通过输入框旁的权限选择器切换，按会话保存。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)
const TITLE = `权限验收 ${stamp}`
let sessionId = ''
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

async function script(page: Page, responses: unknown[]): Promise<void> {
  await page.request.post(`${LLM}/__mock/reset`)
  const res = await page.request.post(`${LLM}/__mock/script`, { data: { responses } })
  expect(res.ok()).toBeTruthy()
}

/** 最近一次发给模型的请求里提供的工具名 */
async function offeredTools(page: Page): Promise<string[]> {
  const requests = (await (await page.request.get(`${LLM}/__mock/requests`)).json()) as Array<{
    tools?: Array<{ function?: { name?: string } }>
  }>
  const first = requests[0]
  return (first?.tools ?? []).map((tool) => tool.function?.name ?? '')
}

async function customerCount(page: Page, company: string): Promise<number> {
  const res = await api<{ total?: number; items?: unknown[] }>(
    page,
    'GET',
    `/api/customers?query=${encodeURIComponent(company)}`,
  )
  return res.total ?? res.items?.length ?? 0
}

async function openSession(page: Page): Promise<void> {
  await page.goto('/#/agent')
  await page.locator('.session-item', { hasText: TITLE }).first().click()
  await expect(page.locator('.chat-header h1')).toContainText(TITLE)
}

async function pickLevel(page: Page, label: string, level: string): Promise<void> {
  await page.getByTestId('permission-picker').click()
  const menu = page.getByTestId('permission-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitemradio', { name: new RegExp(label) }).click()
  await expect(page.getByTestId('permission-picker')).toHaveAttribute('data-level', level)
  // 按会话保存在服务端
  await expect
    .poll(
      async () =>
        (await api<{ session: { permissionLevel: string | null } }>(page, 'GET', `/api/sessions/${sessionId}`)).session
          .permissionLevel,
    )
    .toBe(level)
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('消息内容').fill(text)
  await page.getByLabel('消息内容').press('Enter')
}

test('准备：独立 Provider、全部工具、建“仅可查看”会话', async ({ page }) => {
  await page.goto('/')
  const settings = await api<Record<string, unknown>>(page, 'GET', '/api/settings')
  const current = (settings.settings ?? settings) as Record<string, unknown>
  restore = {
    defaultProviderId: current.defaultProviderId ?? '',
    autoTitle: current.autoTitle,
    toolLoading: current.toolLoading,
  }
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: `Permission Mock ${stamp}`,
    kind: 'openai',
    baseUrl: `${LLM}/v1`,
    apiKey: 'sk-perm-e2e-0001',
    model: 'mock-model',
    models: ['mock-model'],
  })
  await api(page, 'PATCH', '/api/settings', { defaultProviderId: provider.id, autoTitle: '0', toolLoading: 'all' })
  const { session } = await api<{ session: { id: string; permissionLevel: string | null } }>(
    page,
    'POST',
    '/api/sessions',
    {
      title: TITLE,
      agentIds: ['builtin'],
      permissionLevel: 'read',
    },
  )
  expect(session.permissionLevel).toBe('read')
  sessionId = session.id
})

test('仅可查看：写工具不提供给模型；硬调用直接拒绝、不弹卡片、不写库', async ({ page }) => {
  const company = `ReadOnly Co ${stamp}`
  await script(page, [
    { toolCalls: [{ name: 'create_customer', arguments: { company } }] },
    { text: '只读会话里没法新建客户。' },
  ])
  await openSession(page)
  await expect(page.getByTestId('permission-picker')).toHaveAttribute('data-level', 'read')
  await expect(page.getByTestId('permission-picker')).toHaveAttribute('aria-label', new RegExp('仅可查看'))
  await send(page, `新建客户 ${company}`)
  const reply = page.locator('.message.assistant').last()
  await expect(reply).toContainText('只读会话里没法新建客户', { timeout: 20_000 })
  await expect(page.locator('.tool-trace.is-pending')).toHaveCount(0)
  // 拒绝记在 LULUX 名下（不是“未知服务”），展开可见“仅可查看”的说明
  const refused = reply.locator('.tool-trace', { hasText: 'create_customer' })
  await expect(refused).toContainText('LULUX')
  await expect(refused).not.toContainText('未知服务')
  await refused.locator('.tool-head').click()
  await expect(refused).toContainText('仅可查看')
  const tools = await offeredTools(page)
  expect(tools.length).toBeGreaterThan(0)
  expect(tools).toContain('search_customers')
  expect(tools).not.toContain('create_customer')
  expect(await customerCount(page, company)).toBe(0)
})

test('完全权限：写工具直接执行，不弹审批卡片', async ({ page }) => {
  const company = `FullAccess Co ${stamp}`
  await openSession(page)
  await pickLevel(page, '完全权限', 'full')
  await script(page, [{ toolCalls: [{ name: 'create_customer', arguments: { company } }] }, { text: '客户已新建。' }])
  await send(page, `新建客户 ${company}`)
  await expect(page.locator('.message.assistant').last()).toContainText('客户已新建', { timeout: 20_000 })
  await expect(page.locator('.tool-trace.is-pending')).toHaveCount(0)
  expect(await offeredTools(page)).toContain('create_customer')
  expect(await customerCount(page, company)).toBe(1)
})

test('需审批：写工具弹审批卡片，允许后执行', async ({ page }) => {
  const company = `AskFirst Co ${stamp}`
  await openSession(page)
  await pickLevel(page, '需审批', 'ask')
  await script(page, [
    { toolCalls: [{ name: 'create_customer', arguments: { company } }] },
    { text: '审批后已新建客户。' },
  ])
  await send(page, `新建客户 ${company}`)
  const card = page.locator('.tool-trace.is-pending', { hasText: 'create_customer' })
  await expect(card).toBeVisible({ timeout: 20_000 })
  expect(await customerCount(page, company)).toBe(0)
  await card.getByRole('button', { name: '允许', exact: true }).click()
  await expect(page.locator('.message.assistant').last()).toContainText('审批后已新建客户', { timeout: 20_000 })
  expect(await customerCount(page, company)).toBe(1)
})

test('截图：打开的权限选择器（1440×900，中文，浅色；仅在设置 E2E_PERMISSION_SHOTS 时）', async ({ page }) => {
  const dir = process.env.E2E_PERMISSION_SHOTS || ''
  test.skip(!dir, '未设置 E2E_PERMISSION_SHOTS')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await openSession(page)
  await page.getByTestId('permission-picker').click()
  await expect(page.getByTestId('permission-menu')).toBeVisible()
  await page.waitForTimeout(300)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, 'picker.png') })
  await page.keyboard.press('Escape')
})

test('收尾：恢复全局设置', async ({ page }) => {
  await page.goto('/')
  const body = Object.fromEntries(Object.entries(restore).filter(([, value]) => value !== undefined))
  if (Object.keys(body).length) await api(page, 'PATCH', '/api/settings', body)
})
