import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'

/**
 * 团队服务器：账户隔离 + 多人群聊（契约 §5.6a / §6.10），两个浏览器上下文：
 * A 新建群聊（LULUX + 同事 B）→ B 侧栏实时出现该群并发言 → A 不刷新就看到 B 的消息与 Agent 回复 →
 * C（同组织的第三人）和管理员都看不到这个群。
 * 截图见 tenancy-shots.spec.ts（E2E_TENANCY_SHOTS=1）。
 * 文件名排在 team.spec 之后：复用它创建的 owner；单独运行时自己初始化。
 */
test.describe.configure({ mode: 'serial' })

const TEAM = `http://localhost:${process.env.E2E_PORT_TEAMWEB || 52891}`
const CHAT_LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}/v1`
const OWNER = { email: 'owner@mingchuan.example.com', password: 'Owner-pass-2026', name: 'Koko Chen' }
const PASSWORD = 'Member-pass-2026'
const stamp = Date.now().toString(36)
const GROUP = `欧洲线报价群 ${stamp}`

interface Account {
  token: string
  id: string
  name: string
  email: string
}
let owner: Account
let alice: Account
let bob: Account
let carol: Account
let groupId = ''

async function call<T = unknown>(
  request: APIRequestContext,
  method: string,
  path: string,
  token: string | null,
  data?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await request.fetch(`${TEAM}${path}`, {
    method,
    data: data === undefined ? undefined : data,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  return { status: res.status(), json: (text ? JSON.parse(text) : null) as T }
}

async function joinOrg(request: APIRequestContext, name: string, email: string): Promise<Account> {
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

/** 新浏览器上下文，直接带上登录态（登录页本身由 login / team 用例覆盖） */
async function signedIn(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
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

test.beforeAll(async ({ request }) => {
  const mode = await call<{ setupRequired: boolean }>(request, 'GET', '/api/auth/mode', null)
  if (mode.json.setupRequired) {
    const setupToken = readFileSync(join(process.env.E2E_SERVER_DATA_DIR as string, 'setup-token'), 'utf8').trim()
    const setup = await call(request, 'POST', '/api/auth/setup', null, { setupToken, orgName: '明川外贸', ...OWNER })
    expect(setup.status).toBe(201)
  }
  const login = await call<{ token: string; user: { id: string } }>(request, 'POST', '/api/auth/login', null, {
    email: OWNER.email,
    password: OWNER.password,
  })
  expect(login.status).toBe(200)
  owner = { token: login.json.token, id: login.json.user.id, name: OWNER.name, email: OWNER.email }
  alice = await joinOrg(request, '林晓雨', `alice.${stamp}@mingchuan.example.com`)
  bob = await joinOrg(request, '陈志远', `bob.${stamp}@mingchuan.example.com`)
  carol = await joinOrg(request, '周婷', `carol.${stamp}@mingchuan.example.com`)

  const providers = await call<Array<{ id: string; baseUrl: string }> | { providers: Array<{ baseUrl: string }> }>(
    request,
    'GET',
    '/api/providers',
    owner.token,
  )
  const list = Array.isArray(providers.json) ? providers.json : (providers.json.providers ?? [])
  if (!list.some((p) => p.baseUrl === CHAT_LLM)) {
    const created = await call(request, 'POST', '/api/providers', owner.token, {
      name: 'E2E Mock',
      kind: 'openai',
      baseUrl: CHAT_LLM,
      apiKey: 'sk-e2e-mock-123456',
      model: 'mock-model',
    })
    expect(created.status).toBe(201)
  }
  await call(request, 'PATCH', '/api/settings', owner.token, { autoTitle: false, llmMaxRetries: 0 })
})

test('A 建群（LULUX + 同事 B）→ B 实时看到群并发言 → A 实时看到 B 的消息与 Agent 回复；C 看不到', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000)
  const pageA = await signedIn(browser, alice)
  const pageB = await signedIn(browser, bob)
  const pageC = await signedIn(browser, carol)

  // A：侧栏“+” → 新建群聊 → 勾选同事 B
  await pageA.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click()
  await pageA
    .locator('.kernel-menu')
    .getByRole('menuitem', { name: /新建群聊/ })
    .click()
  const dialog = pageA.getByRole('dialog', { name: '新建群聊' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('群聊名称').fill(GROUP)
  const picker = dialog.getByTestId('colleague-picker')
  await expect(picker).toContainText(bob.name)
  await expect(picker).toContainText(carol.name)
  await expect(picker).not.toContainText(alice.name)
  await picker.getByRole('menuitemcheckbox', { name: new RegExp(bob.name) }).click()
  await expect(picker).toContainText('已邀请 1 人')
  await dialog.getByRole('button', { name: '创建群聊' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(pageA.locator('.chat-header h1')).toContainText(GROUP)
  const itemA = pageA.locator('.session-item', { hasText: GROUP })
  await expect(itemA.getByTestId('session-people')).toHaveText('2')

  const created = await call<{
    sessions: Array<{ id: string; groupName: string; participants: Array<{ userId: string }> }>
  }>(request, 'GET', '/api/sessions', alice.token)
  const group = created.json.sessions.find((s) => s.groupName === GROUP)!
  expect(group.participants.map((p) => p.userId)).toEqual([alice.id, bob.id])
  groupId = group.id

  // B：不刷新，侧栏实时出现这个群（全局事件 session.updated）
  const itemB = pageB.locator('.session-item', { hasText: GROUP })
  await expect(itemB).toBeVisible({ timeout: 15_000 })
  await itemB.click()
  await expect(pageB.locator('.chat-header h1')).toContainText(GROUP)
  // 普通成员：右键看到同事列表与“退出群聊”，没有删除
  await itemB.click({ button: 'right' })
  const menuB = pageB.locator('.context-menu')
  await expect(menuB.getByTestId('group-people')).toContainText(alice.name)
  await expect(menuB.getByTestId('group-people')).toContainText('群主')
  await expect(menuB.getByTestId('group-leave')).toBeVisible()
  await expect(menuB.locator('.context-remove')).toHaveCount(0)
  await menuB.getByRole('button', { name: '完成' }).click()

  // B 发言
  const question = `@LULUX 汉堡港 40HQ 到港运费大概多少？（${stamp}）`
  await pageB.getByLabel('消息内容').fill(question)
  await pageB.getByLabel('消息内容').press('Enter')
  await expect(pageB.locator('.message.user', { hasText: question })).toBeVisible()

  // A：不刷新就看到 B 的消息（左侧、带名字），随后看到 Agent 回复
  const fromBob = pageA.locator('.message.user.from-other', { hasText: question })
  await expect(fromBob).toBeVisible({ timeout: 15_000 })
  await expect(fromBob.getByTestId('message-sender')).toHaveText(bob.name)
  // Agent（主管派发不变）回应 B 的提问：两边都在 B 的消息之后出现回复
  const replyAfter = (page: Page, text: string) =>
    page.locator('.message.user', { hasText: text }).locator('~ .message.assistant').first()
  await expect(replyAfter(pageA, question)).toContainText('报价', { timeout: 30_000 })
  await expect(replyAfter(pageB, question)).toContainText('报价', { timeout: 30_000 })
  // 别人的提问在回复中时，A 的输入框显示“停止生成”（与发起人同一个运行）；结束后才能接着发
  await expect(pageB.getByRole('button', { name: '停止生成' })).toHaveCount(0, { timeout: 30_000 })
  await expect(pageA.getByRole('button', { name: '停止生成' })).toHaveCount(0, { timeout: 30_000 })

  // A 也发一句：B 实时看到（A 的名字）
  await pageA.getByLabel('消息内容').fill(`收到，我来跟进报价单（${stamp}）`)
  await pageA.getByLabel('消息内容').press('Enter')
  await expect(pageB.locator('.message.user.from-other', { hasText: `我来跟进报价单（${stamp}）` })).toBeVisible({
    timeout: 15_000,
  })
  await expect(replyAfter(pageA, `我来跟进报价单（${stamp}）`)).toContainText('报价', { timeout: 30_000 })
  await expect(replyAfter(pageB, `我来跟进报价单（${stamp}）`)).toContainText('报价', { timeout: 30_000 })

  // 群设置：A（群主）看到两位同事与移出按钮
  await itemA.click({ button: 'right' })
  const menuA = pageA.locator('.context-menu')
  await expect(menuA.getByTestId('group-people').locator('.group-person')).toHaveCount(2)
  await expect(menuA.getByRole('button', { name: `把 ${bob.name} 移出群聊` })).toBeVisible()
  await menuA.getByRole('button', { name: '完成' }).click()

  // C：同组织的第三人看不到这个群（侧栏、接口都没有）
  await pageC.reload()
  await expect(pageC.locator('.sidebar')).toBeVisible()
  await expect(pageC.locator('.session-item', { hasText: GROUP })).toHaveCount(0)
  const asCarol = await call(request, 'GET', `/api/sessions/${groupId}`, carol.token)
  expect(asCarol.status).toBe(404)
  // 管理员 / owner 同样看不到（没有“看全部”）
  const asOwner = await call<{ sessions: Array<{ id: string }> }>(
    request,
    'GET',
    '/api/sessions?scope=all',
    owner.token,
  )
  expect(asOwner.json.sessions.map((s) => s.id)).not.toContain(groupId)
  expect((await call(request, 'GET', `/api/sessions/${groupId}`, owner.token)).status).toBe(404)

  await pageA.context().close()
  await pageB.context().close()
  await pageC.context().close()
})

test('群主移出 B：B 的界面实时去掉这个群', async ({ browser, request }) => {
  const pageB = await signedIn(browser, bob)
  const itemB = pageB.locator('.session-item', { hasText: GROUP })
  await expect(itemB).toBeVisible()
  await itemB.click()
  await expect(pageB.locator('.chat-header h1')).toContainText(GROUP)
  const removed = await call(request, 'DELETE', `/api/sessions/${groupId}/participants/${bob.id}`, alice.token)
  expect(removed.status).toBe(204)
  await expect(itemB).toHaveCount(0, { timeout: 15_000 })
  await expect(pageB.locator('.chat-header h1')).not.toContainText(GROUP)
  expect((await call(request, 'GET', `/api/sessions/${groupId}`, bob.token)).status).toBe(404)
  await pageB.context().close()
})
