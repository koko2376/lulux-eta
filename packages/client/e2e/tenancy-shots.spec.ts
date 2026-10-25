import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { FAKE_CLAUDE_REPLY, installFakeClaudeCode } from './fixtures/fake-kernel.mjs'

/**
 * 多人群聊截图（1440×900，中文，浅色）：只在 E2E_TENANCY_SHOTS=1 且设置了 E2E_SHOTS_DIR 时运行，
 * 不进常规套件（会开启团队服务器的内核开关并装替身 Claude Code，影响其它用例的前提）。
 * 群成员：LULUX + Claude Code（替身内核）+ 两位同事（林晓雨 = alice 群主，陈志远 = bob）。
 * 产出：group-alice-1440.png、group-bob-1440.png、group-people-1440.png。
 */
const SHOTS = process.env.E2E_SHOTS_DIR || ''
test.skip(process.env.E2E_TENANCY_SHOTS !== '1' || !SHOTS, '仅在 E2E_TENANCY_SHOTS=1 时截图')
test.describe.configure({ mode: 'serial' })

const TEAM = `http://localhost:${process.env.E2E_PORT_TEAMWEB || 52891}`
const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const OWNER = { email: 'owner@mingchuan.example.com', password: 'Owner-pass-2026', name: 'Koko Chen' }
const PASSWORD = 'Member-pass-2026'
const stamp = Date.now().toString(36)
const GROUP = '欧洲线报价群'

interface Account {
  token: string
  id: string
  name: string
  email: string
}

async function call<T = unknown>(
  request: APIRequestContext,
  method: string,
  path: string,
  token: string | null,
  data?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await request.fetch(`${TEAM}${path}`, {
    method,
    data,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  return { status: res.status(), json: (text ? JSON.parse(text) : null) as T }
}

async function joinOrg(request: APIRequestContext, owner: Account, name: string, email: string): Promise<Account> {
  const invite = await call<{ code: string }>(request, 'POST', '/api/team/invites', owner.token, { role: 'member' })
  expect(invite.status).toBe(201)
  const accepted = await call<{ token: string; user: { id: string } }>(
    request,
    'POST',
    '/api/auth/invites/accept',
    null,
    {
      code: invite.json.code,
      email,
      password: PASSWORD,
      name,
    },
  )
  expect(accepted.status).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id, name, email }
}

async function signedIn(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    colorScheme: 'light',
  })
  await context.addInitScript(
    ({ token, user }) => {
      if (!localStorage.getItem('lulux.session'))
        localStorage.setItem('lulux.session', JSON.stringify({ token, user, baseUrl: '' }))
    },
    { token: account.token, user: { id: account.id, name: account.name, email: account.email, role: 'member' } },
  )
  const page = await context.newPage()
  await page.goto(`${TEAM}/#/agent`)
  await expect(page).not.toHaveURL(/login/)
  return page
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, name) })
}

/** 消息列表滚到底，让最后几条（两位同事的发言 + Agent 回复）都在视口里 */
async function scrollToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.message-list, .messages, .chat-scroll')) {
      el.scrollTop = el.scrollHeight
    }
  })
  await page.waitForTimeout(400)
}

test('截图：LULUX + Claude Code + 两位同事的群聊', async ({ browser, request }) => {
  test.setTimeout(120_000)
  // owner：初始化或登录
  const mode = await call<{ setupRequired: boolean }>(request, 'GET', '/api/auth/mode', null)
  if (mode.json.setupRequired) {
    const setupToken = readFileSync(join(process.env.E2E_SERVER_DATA_DIR as string, 'setup-token'), 'utf8').trim()
    expect(
      (await call(request, 'POST', '/api/auth/setup', null, { setupToken, orgName: '明川外贸', ...OWNER })).status,
    ).toBe(201)
  }
  const login = await call<{ token: string; user: { id: string } }>(request, 'POST', '/api/auth/login', null, {
    email: OWNER.email,
    password: OWNER.password,
  })
  expect(login.status).toBe(200)
  const owner: Account = { token: login.json.token, id: login.json.user.id, name: OWNER.name, email: OWNER.email }

  // 团队服务器开启内核 + 装替身 Claude Code（scoped，走会话 Provider）
  installFakeClaudeCode(process.env.E2E_SERVER_DATA_DIR)
  const security = await call(request, 'PATCH', '/api/team/security', owner.token, {
    allowKernels: true,
    confirm: 'I_UNDERSTAND',
  })
  expect(security.status).toBe(200)

  // Provider（短回复用 mock 编排）
  const providers = await call<
    Array<{ id: string; baseUrl: string }> | { providers: Array<{ id: string; baseUrl: string }> }
  >(request, 'GET', '/api/providers', owner.token)
  const list = Array.isArray(providers.json) ? providers.json : (providers.json.providers ?? [])
  let providerId = list.find((p) => p.baseUrl === `${LLM}/v1`)?.id
  if (!providerId) {
    const created = await call<{ provider: { id: string } }>(request, 'POST', '/api/providers', owner.token, {
      name: 'E2E Mock',
      kind: 'openai',
      baseUrl: `${LLM}/v1`,
      apiKey: 'sk-e2e-mock-123456',
      model: 'mock-model',
    })
    expect(created.status).toBe(201)
    providerId = created.json.provider.id
  }
  await call(request, 'PATCH', '/api/settings', owner.token, {
    defaultProviderId: providerId,
    autoTitle: false,
    llmMaxRetries: 0,
  })
  await request.post(`${LLM}/__mock/reset`)

  const alice = await joinOrg(request, owner, '林晓雨', `alice.shot.${stamp}@mingchuan.example.com`)
  const bob = await joinOrg(request, owner, '陈志远', `bob.shot.${stamp}@mingchuan.example.com`)

  // alice 建群：LULUX + Claude Code + bob
  const created = await call<{ session: { id: string; agentIds: string[]; participants: Array<{ userId: string }> } }>(
    request,
    'POST',
    '/api/sessions',
    alice.token,
    { kind: 'group', groupName: GROUP, agentIds: ['builtin', 'kernel-claude-code'], userIds: [bob.id] },
  )
  expect(created.status).toBe(201)
  expect(created.json.session.agentIds).toEqual(['builtin', 'kernel-claude-code'])

  const pageA = await signedIn(browser, alice)
  const pageB = await signedIn(browser, bob)
  for (const page of [pageA, pageB]) {
    await page.locator('.session-item', { hasText: GROUP }).first().click()
    await expect(page.locator('.chat-header h1')).toContainText(GROUP)
  }

  // bob：@LULUX 问运费 → LULUX 短回复
  await request.post(`${LLM}/__mock/script`, {
    data: { responses: [{ text: '汉堡港 40HQ 本周约 USD 2,350（含 THC），船期每周二、五。' }] },
  })
  const q1 = '@LULUX 汉堡港 40HQ 运费现在多少？'
  await pageB.getByLabel('消息内容').fill(q1)
  await pageB.getByLabel('消息内容').press('Enter')
  const reply1 = (page: Page) => page.locator('.message.assistant', { hasText: 'USD 2,350' })
  await expect(reply1(pageA)).toBeVisible({ timeout: 30_000 })
  await expect(reply1(pageB)).toBeVisible({ timeout: 30_000 })
  await expect(pageB.getByRole('button', { name: '停止生成' })).toHaveCount(0, { timeout: 30_000 })
  await expect(pageA.getByRole('button', { name: '停止生成' })).toHaveCount(0, { timeout: 30_000 })

  // alice：@Claude Code → 替身内核固定短回复
  const q2 = '@Claude Code 帮我把报价单按这个运费更新一下'
  await pageA.getByLabel('消息内容').fill(q2)
  await pageA.getByLabel('消息内容').press('Enter')
  const reply2 = (page: Page) => page.locator('.message.assistant', { hasText: FAKE_CLAUDE_REPLY })
  await expect(reply2(pageA)).toBeVisible({ timeout: 30_000 })
  await expect(reply2(pageB)).toBeVisible({ timeout: 30_000 })
  await expect(pageA.getByRole('button', { name: '停止生成' })).toHaveCount(0, { timeout: 30_000 })
  await expect(pageB.getByRole('button', { name: '停止生成' })).toHaveCount(0, { timeout: 30_000 })

  // 视角校验：自己的靠右，同事的靠左带名字
  await expect(pageA.locator('.message.user.from-other', { hasText: q1 }).getByTestId('message-sender')).toHaveText(
    bob.name,
  )
  await expect(pageB.locator('.message.user.from-other', { hasText: q2 }).getByTestId('message-sender')).toHaveText(
    alice.name,
  )

  for (const page of [pageA, pageB]) {
    await page.mouse.move(720, 20)
    await scrollToEnd(page)
    // 右侧会话详情滚到“群里的同事”，两位同事都露出来
    await page.locator('.detail-panel .detail-people').evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await page.waitForTimeout(300)
  }
  await shot(pageA, 'group-alice-1440.png')
  await shot(pageB, 'group-bob-1440.png')

  // 群成员面板（alice = 群主，右键会话）
  await pageA.locator('.session-item', { hasText: GROUP }).first().click({ button: 'right' })
  const menu = pageA.locator('.context-menu')
  await expect(menu.getByTestId('group-people').locator('.group-person')).toHaveCount(2)
  await pageA.waitForTimeout(300)
  await shot(pageA, 'group-people-1440.png')
  await menu.getByRole('button', { name: '完成' }).click()

  await pageA.context().close()
  await pageB.context().close()
})
