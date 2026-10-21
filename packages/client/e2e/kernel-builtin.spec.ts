import { expect, test, type Page } from '@playwright/test'
import { FAKE_CLAUDE_REPLY, installFakeClaudeCode } from './fixtures/fake-kernel.mjs'

/**
 * 内置内核客户端配合点（契约 §6.8），真服务 + 可编排的 tools/dev/mock-openai.js（POST /__mock/script）：
 * reasoning 折叠块、工具调用、429 退避重试提示、用量行、重新生成、编辑重发、停止、审批“本会话始终允许”、
 * 产物面板自动打开、@成员、客户绑定、用量页与单价编辑、导出 Markdown。
 * 文件名排在 flow.spec 之后：会把默认 Provider 换成本文件创建的 Provider（mail.spec 会再换成自己的）。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)
let sessionId = ''
let groupId = ''

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

async function openSession(page: Page, title: string): Promise<void> {
  await page.goto('/#/agent')
  await page.locator('.session-item', { hasText: title }).first().click()
  await expect(page.locator('.chat-header h1')).toContainText(title)
}

const usage = (prompt: number, completion: number) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: 64 },
})

test('准备：独立 Provider、关闭自动标题、清空 mock 队列、建会话', async ({ page }) => {
  await page.goto('/')
  await page.request.post(`${LLM}/__mock/reset`)
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: `Builtin Mock ${stamp}`,
    kind: 'openai',
    baseUrl: `${LLM}/v1`,
    apiKey: 'sk-builtin-e2e-0001',
    model: 'mock-model',
    models: ['mock-model'],
  })
  await api(page, 'PATCH', '/api/settings', {
    defaultProviderId: provider.id,
    autoTitle: '0',
    toolApproval: 'ask',
    llmMaxRetries: 3,
    'agent.maxTurns': 90,
    modelPricing: JSON.stringify({ 'mock-model': { input: 2, output: 8, currency: 'CNY' } }),
  })
  const { session } = await api<{ session: { id: string } }>(page, 'POST', '/api/sessions', {
    title: `内核验收 ${stamp}`,
    agentIds: ['builtin'],
  })
  sessionId = session.id
  // 群聊的第二个成员：替身 Claude Code 内核（scoped 模式，只要求已安装 + 有 Provider）；群聊本身在下面的用例里从界面新建
  installFakeClaudeCode()
  await api(page, 'POST', '/api/customers', {
    company: `Bound Customer ${stamp} GmbH`,
    country: 'Germany',
    website: `https://bound-${stamp}.example.com`,
    stage: 'lead',
    tags: [],
    source: 'e2e',
    notes: '',
    contacts: [],
  })
})

test('推理折叠块 + 工具调用 + 429 重试提示 + 用量行', async ({ page }) => {
  await script(page, [
    {
      reasoning: '先用计算器算一下 400 只的总价。',
      toolCalls: [{ name: 'calculator', arguments: { expression: '12.5*400' } }],
      usage: usage(900, 30),
    },
    { status: 429, headers: { 'retry-after': '2' }, body: '{"error":{"message":"rate limited"}}' },
    { text: '按 USD 12.5 计算，400 只总价 **USD 5,000**。', usage: usage(1200, 40), delayMs: 5 },
  ])
  await openSession(page, `内核验收 ${stamp}`)
  await page.getByLabel('消息内容').fill('DN25 球阀 400 只，单价 12.5 美元，总价多少？')
  await page.getByLabel('消息内容').press('Enter')

  // 429：服务端遵守 Retry-After 退避，界面显示“正在重试”
  await expect(page.locator('.run-notice.retry')).toContainText('正在重试（第 1/3 次', { timeout: 10_000 })
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()

  const reply = page.locator('.message.assistant').last()
  await expect(reply.locator('.bubble')).toContainText('USD 5,000', { timeout: 20_000 })
  // 推理默认折叠，展开后是模型的思考
  const reasoning = reply.locator('.reasoning')
  await expect(reasoning.getByTestId('thinking-done')).toHaveText(/已思考 \d+ 秒/)
  await expect(reasoning.locator('.reasoning-collapse')).not.toHaveClass(/open/)
  await reasoning.getByRole('button').click()
  await expect(reasoning.locator('.reasoning-collapse')).toHaveClass(/open/)
  await expect(reasoning.locator('.reasoning-body')).toContainText('先用计算器')
  // 工具调用轨迹
  await expect(reply.locator('.tool-trace', { hasText: 'calculator' })).toContainText('已完成')
  // 用量：两次调用合计（缓存命中）与按单价估算的费用
  await expect(reply.locator('.message-usage')).toContainText('输入 2,100（缓存 128）/ 输出 70')
  await expect(reply.locator('.message-usage')).toContainText('约 ¥')
  await expect(page.locator('.run-notice.retry')).toHaveCount(0)
})

test('Grok 式思考：扫光“思考中 · N 秒”+ 实时预览 → 自动折叠“已思考 N 秒”；刷新后“已思考 · N 字”', async ({ page }) => {
  const thought =
    '客户问的是 DN50 不锈钢球阀的 FOB 价格，需要先确认材质 304 还是 316，再看起订量和交期，最后按美元报价。'
  await script(page, [{ reasoning: thought, text: '请确认材质：304 还是 316？', usage: usage(300, 20), delayMs: 400 }])
  // 独立会话：不影响后面“重新生成 / 编辑重发”对最后一条消息的断言
  await api(page, 'POST', '/api/sessions', { title: `思考验收 ${stamp}`, agentIds: ['builtin'] })
  await openSession(page, `思考验收 ${stamp}`)
  await page.getByLabel('消息内容').fill('DN50 不锈钢球阀 FOB 多少？')
  await page.getByLabel('消息内容').press('Enter')

  const live = page.locator('.message.streaming .reasoning.live')
  await expect(live.locator('.shimmer')).toHaveText('思考中')
  await expect(page.locator('.bubble.typing')).toHaveCount(0)
  await expect(live.getByTestId('thinking-elapsed')).toContainText(/\d+ 秒/, { timeout: 5000 })
  await expect(live.locator('.reasoning-preview')).toContainText('DN50')

  const reply = page.locator('.message.assistant').last()
  await expect(reply.locator('.bubble')).toContainText('304 还是 316', { timeout: 20_000 })
  await expect(reply.getByTestId('thinking-done')).toHaveText(/^已思考 \d+ 秒$/)
  await expect(reply.locator('.reasoning-collapse')).not.toHaveClass(/open/)

  await page.reload()
  await expect(page.locator('.chat-header h1')).toContainText(`思考验收 ${stamp}`)
  const after = page.locator('.message.assistant').last()
  await expect(after.getByTestId('thinking-done')).toHaveText(`已思考 · ${thought.length} 字`)
})

test('重新生成：只替换这一轮回答', async ({ page }) => {
  await script(page, [{ text: '重新计算：总价 USD 5,000（不含运费）。', usage: usage(800, 20) }])
  await openSession(page, `内核验收 ${stamp}`)
  const before = await page.locator('.message.assistant').count()
  await page.locator('.message.assistant').last().hover()
  await page.locator('.message.assistant').last().getByRole('button', { name: '重新生成' }).click()
  await expect(page.locator('.message.assistant').last().locator('.bubble')).toContainText('不含运费', {
    timeout: 20_000,
  })
  await expect(page.locator('.message.assistant')).toHaveCount(before)
})

test('编辑重发：提示会删除后续消息，旧回答被替换', async ({ page }) => {
  await script(page, [{ text: '500 只的总价是 USD 6,250。', usage: usage(700, 18) }])
  await openSession(page, `内核验收 ${stamp}`)
  const user = page.locator('.message.user').last()
  await user.hover()
  await user.getByRole('button', { name: '编辑后重发' }).click()
  await expect(page.locator('.composer-editing')).toContainText('之后的 1 条消息将被删除')
  const input = page.getByLabel('消息内容')
  await expect(input).toHaveValue(/400 只/)
  await input.fill('DN25 球阀 500 只，单价 12.5 美元，总价多少？')
  await input.press('Enter')
  await expect(page.locator('.message.assistant').last()).toContainText('USD 6,250', { timeout: 20_000 })
  await expect(page.locator('.message.user').last()).toContainText('500 只')
  await expect(page.locator('.message', { hasText: '不含运费' })).toHaveCount(0)
  await expect(page.locator('.composer-editing')).toHaveCount(0)
})

test('停止：生成中点停止，保留已生成部分并标记“已停止”', async ({ page }) => {
  await script(page, [{ text: '这是一段很长的回答，'.repeat(40), chunkSize: 4, delayMs: 120 }])
  await openSession(page, `内核验收 ${stamp}`)
  await page.getByLabel('消息内容').fill('写一段很长的开发信')
  await page.getByLabel('消息内容').press('Enter')
  await expect(page.locator('.message.streaming .bubble')).toContainText('很长的回答', { timeout: 10_000 })
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.message.assistant').last().locator('.message-flag')).toHaveText('已停止')
})

test('审批卡片“本会话始终允许” + create_artifact 自动打开产物面板', async ({ page }) => {
  await script(page, [
    { toolCalls: [{ name: 'workspace_write', arguments: { path: 'notes/a.txt', content: 'hello' } }] },
    { toolCalls: [{ name: 'workspace_write', arguments: { path: 'notes/b.txt', content: 'again' } }] },
    {
      toolCalls: [
        {
          name: 'create_artifact',
          arguments: {
            title: 'Quote Sheet',
            language: 'html',
            content: '<!doctype html><title>Quote Sheet</title><h1>Quote</h1>',
          },
        },
      ],
    },
    { text: '两个文件已写入，报价单已生成。' },
  ])
  await openSession(page, `内核验收 ${stamp}`)
  await page.getByLabel('消息内容').fill('把备注写进工作区并生成报价单')
  await page.getByLabel('消息内容').press('Enter')
  const card = page.locator('.tool-trace.is-pending', { hasText: 'workspace_write' })
  await expect(card).toContainText('写入', { timeout: 15_000 })
  await card.getByRole('button', { name: '本会话始终允许' }).click()
  // 第二次同名写入不再询问；产物事件打开产物面板
  await expect(page.locator('.message.assistant').last()).toContainText('报价单已生成', { timeout: 20_000 })
  await expect(
    page.locator('.message.assistant').last().locator('.tool-trace', { hasText: 'workspace_write' }),
  ).toHaveCount(2)
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveClass(/active/)
  await expect(page.locator('.artifact-panel')).toContainText('Quote Sheet')
})

test('群聊就是群聊：单聊右键只能换内核；“+ → 新建群聊”建一个全新的空群聊，原会话不变', async ({ page }) => {
  await page.goto('/#/agent')
  // 单聊右键：内核是单选，没有群名 / 主管，提示去新建群聊
  await page.locator('.session-item', { hasText: `内核验收 ${stamp}` }).click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(0)
  await expect(menu.getByRole('menuitemradio').first()).toBeVisible()
  await expect(menu.locator('.context-group')).toHaveCount(0)
  await expect(menu.locator('.supervisor-picker')).toHaveCount(0)
  await expect(menu.locator('.context-hint')).toContainText('新建群聊')
  await menu.getByRole('button', { name: '完成' }).click()

  // 侧栏“+” → 新建群聊
  await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click()
  await page
    .locator('.kernel-menu')
    .getByRole('menuitem', { name: /新建群聊/ })
    .click()
  const dialog = page.getByRole('dialog', { name: '新建群聊' })
  await expect(dialog).toBeVisible()
  const create = dialog.getByRole('button', { name: '创建群聊' })
  await expect(create).toBeDisabled()
  await dialog.getByLabel('群聊名称').fill(`群聊验收 ${stamp}`)
  await dialog.getByRole('menuitemcheckbox', { name: /Claude Code/ }).click()
  await expect(dialog.getByRole('menuitemcheckbox', { name: /LULUX/ })).toHaveAttribute('aria-checked', 'true')
  await expect(create).toBeEnabled()
  await create.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.chat-header h1')).toContainText(`群聊验收 ${stamp}`)
  await expect(page.locator('.message')).toHaveCount(0)
  const groupAvatar = page.locator('.session-item', { hasText: `群聊验收 ${stamp}` }).locator('.group-avatar')
  await expect(groupAvatar).toHaveAttribute('data-count', '2')
  await expect(groupAvatar.locator('.group-avatar-cell')).toHaveCount(2)

  const { sessions } = await api<{
    sessions: Array<{
      id: string
      title: string
      groupName: string | null
      kind: string
      agentIds: string[]
      messageCount: number
    }>
  }>(page, 'GET', '/api/sessions')
  const group = sessions.find((s) => s.groupName === `群聊验收 ${stamp}`)!
  expect(group).toMatchObject({ kind: 'group', agentIds: ['builtin', 'kernel-claude-code'], messageCount: 0 })
  groupId = group.id
  // 原会话仍是单聊，成员与历史都没变
  const original = sessions.find((s) => s.id === sessionId)!
  expect(original).toMatchObject({ kind: 'single', agentIds: ['builtin'] })
  expect(original.messageCount).toBeGreaterThan(0)
  // 服务端也不允许把单聊变成群聊
  const res = await page.request.fetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    data: { agentIds: ['builtin', 'kernel-claude-code'] },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status()).toBe(400)
})

test('群聊 @成员 弹出选择并插入名字；本轮发言顺序', async ({ page }) => {
  // 群聊成员：LULUX + 替身 Claude Code 内核；@ 内置内核后本轮只有它发言
  await script(page, [{ text: '内置：德国市场以分销商为主。' }])
  await openSession(page, `群聊验收 ${stamp}`)
  const input = page.getByLabel('消息内容')
  await input.fill('请 @')
  const list = page.getByRole('listbox', { name: '选择要 @ 的成员' })
  await expect(list).toBeVisible()
  await expect(list.getByRole('option')).toHaveCount(2)
  await expect(list.getByRole('option').nth(1)).toContainText('Claude Code')
  await input.press('ArrowDown')
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(input).toHaveValue('请 @LULUX ')
  await input.pressSequentially('分析一下德国市场')
  await input.press('Enter')
  await expect(page.locator('.message.assistant').last()).toContainText('德国市场以分销商为主', { timeout: 20_000 })
  await expect(page.locator('.message.assistant').last().locator('.message-sender')).toHaveText('LULUX')
  await expect(page.locator('.message.assistant', { hasText: FAKE_CLAUDE_REPLY })).toHaveCount(0)
  await expect(page.locator('.message.assistant')).toHaveCount(1)

  // 不 @ 时由主管（默认 LULUX）分派：规划 → Claude Code 按分工回答 → 主管汇总（Markdown 表格）
  await script(page, [
    {
      toolCalls: [
        { name: 'dispatch_members', arguments: { members: ['kernel-claude-code'], instructions: '列出德国认证清单' } },
      ],
    },
    { text: '这个问题请 Claude Code 先列认证清单，我稍后汇总。' },
    { text: '**汇总**\n\n| 事项 | 负责人 |\n| --- | --- |\n| 确认 DVGW 证书 | 质检 |\n| 发报价单 | 业务 |' },
  ])
  await input.fill('大家都说说下一步')
  await input.press('Enter')
  const assistants = page.locator('.message.assistant')
  await expect(assistants).toHaveCount(4, { timeout: 20_000 })
  await expect(page.locator('.message.streaming')).toHaveCount(0, { timeout: 20_000 })
  const plan = assistants.nth(1)
  await expect(plan.locator('.message-sender')).toContainText('LULUX')
  await expect(plan.locator('.supervisor-tag')).toHaveText('主管 · 分派')
  await expect(plan.locator('.dispatch-note')).toContainText('已分派给 Claude Code')
  await expect(plan.locator('.dispatch-note')).toContainText('分工：列出德国认证清单')
  await expect(plan.locator('.message-avatar .supervisor-dot')).toBeVisible()
  await expect(assistants.nth(2).locator('.message-sender')).toHaveText('Claude Code')
  await expect(assistants.nth(2)).toContainText(FAKE_CLAUDE_REPLY)
  await expect(assistants.nth(2).locator('.supervisor-tag')).toHaveCount(0)
  const summary = assistants.nth(3)
  await expect(summary.locator('.supervisor-tag')).toHaveText('主管 · 汇总')
  // 助手消息按 Markdown 渲染：粗体 + 表格
  await expect(summary.locator('.bubble strong')).toHaveText('汇总')
  await expect(summary.locator('.bubble table td').first()).toHaveText('确认 DVGW 证书')

  // 会话详情里把主管改成“无主管”：恢复旧行为，全体按顺序发言
  const picker = page.locator('.detail-panel').getByLabel('选择本群主管')
  if (!(await picker.isVisible())) await page.getByRole('button', { name: '会话详情', exact: true }).click()
  await expect(picker).toHaveValue('builtin')
  await picker.selectOption('none')
  await expect
    .poll(
      async () =>
        (await api<{ session: { supervisorId: string } }>(page, 'GET', `/api/sessions/${groupId}`)).session
          .supervisorId,
    )
    .toBe('none')
  await script(page, [{ text: '内置：先看认证再报价。' }])
  await input.fill('都说说')
  await input.press('Enter')
  await expect(assistants).toHaveCount(6, { timeout: 20_000 })
  await expect(assistants.nth(4)).toContainText('先看认证再报价')
  await expect(assistants.nth(5).locator('.message-sender')).toHaveText('Claude Code')
  await expect(page.locator('.supervisor-tag')).toHaveCount(2)
  await picker.selectOption('builtin')
})

test('会话头部绑定客户；导出 Markdown', async ({ page }) => {
  await openSession(page, `内核验收 ${stamp}`)
  await page.getByRole('button', { name: '绑定客户或报价' }).click()
  const dialog = page.getByRole('dialog', { name: '绑定客户 / 报价' })
  await dialog.getByLabel('搜索客户').fill(`Bound Customer ${stamp}`)
  await dialog.getByRole('option', { name: new RegExp(`Bound Customer ${stamp}`) }).click()
  await dialog.getByRole('button', { name: '保存' }).click()
  // 绑定按钮是次要的图标按钮：已绑定时带圆点，客户名在 aria-label / 提示里
  await expect(page.locator('.context-chip')).toHaveAttribute('aria-label', new RegExp(`Bound Customer ${stamp}`))
  await expect(page.locator('.context-chip .context-chip-dot')).toBeVisible()
  const ctx = await api<{ customerId: string | null }>(page, 'GET', `/api/chat/sessions/${sessionId}/context`)
  expect(ctx.customerId).toBeTruthy()

  await page.locator('.session-item', { hasText: `内核验收 ${stamp}` }).click({ button: 'right' })
  const download = page.waitForEvent('download')
  await page.locator('.context-menu').getByRole('button', { name: '导出 Markdown' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/内核验收.*\.md$/)
  expect(groupId).toBeTruthy()
})

test('工具轮数上限提示；生成中切到别的会话再切回，继续显示生成进度', async ({ page }) => {
  await page.goto('/')
  await api(page, 'PATCH', '/api/settings', { 'agent.maxTurns': 1 })
  await script(page, [
    { toolCalls: [{ name: 'calculator', arguments: { expression: '1+1' } }] },
    { toolCalls: [{ name: 'calculator', arguments: { expression: '2+2' } }] },
    { text: '基于已有结果：1+1=2。' },
  ])
  await openSession(page, `内核验收 ${stamp}`)
  await page.getByLabel('消息内容').fill('连续算两次')
  await page.getByLabel('消息内容').press('Enter')
  const last = page.locator('.message.assistant').last()
  await expect(last).toContainText('基于已有结果', { timeout: 20_000 })
  await expect(last.locator('.run-notice.tool_limit')).toContainText('已达工具调用上限（1 轮）')
  await expect(last.locator('.message-flag')).toHaveText('工具轮数达上限')
  await api(page, 'PATCH', '/api/settings', { 'agent.maxTurns': 90 })

  await page.request.post(`${LLM}/__mock/reset`)
  await script(page, [{ text: '慢慢写的回答。'.repeat(30), chunkSize: 3, delayMs: 60 }])
  await page.getByLabel('消息内容').fill('慢一点回答')
  await page.getByLabel('消息内容').press('Enter')
  await expect(page.locator('.message.streaming .bubble')).toContainText('慢慢写', { timeout: 10_000 })
  await page.locator('.session-item', { hasText: `群聊验收 ${stamp}` }).click()
  await expect(page.locator('.chat-header h1')).toContainText('群聊验收')
  await expect(page.locator('.session-item', { hasText: `内核验收 ${stamp}` }).locator('.session-preview')).toHaveText(
    '生成中…',
  )
  await page.locator('.session-item', { hasText: `内核验收 ${stamp}` }).click()
  await expect(page.locator('.message.streaming .bubble')).toContainText('慢慢写')
  await expect(page.locator('.message.assistant').last().locator('.bubble')).toContainText('慢慢写的回答。慢慢写', {
    timeout: 20_000,
  })
  await expect(page.locator('.message.streaming')).toHaveCount(0)
})

test('设置 → 用量：按天汇总、明细；单价表格编辑并保存', async ({ page }) => {
  await page.goto('/#/settings/usage')
  await expect(page.locator('.usage-stat').first()).toContainText('模型调用')
  await expect(page.getByRole('table', { name: '用量明细' }).locator('tbody tr').first()).toContainText('mock-model')
  await page.getByRole('tab', { name: '按模型' }).click()
  await expect(page.getByRole('table', { name: '用量汇总' })).toContainText('mock-model')
  const pricing = page.getByTestId('model-pricing')
  await expect(pricing.getByLabel('模型名').first()).toHaveValue('mock-model')
  await pricing.getByRole('button', { name: '添加模型' }).click()
  await pricing.getByLabel('模型名').last().fill('deepseek-*')
  await pricing.getByLabel('输入单价').last().fill('2')
  await pricing.getByLabel('输出单价').last().fill('abc')
  await pricing.getByRole('button', { name: '保存单价' }).click()
  await expect(pricing.getByRole('alert')).toContainText('不是有效数字')
  await pricing.getByLabel('输出单价').last().fill('8')
  await pricing.getByRole('button', { name: '保存单价' }).click()
  await expect(page.locator('.toast').filter({ hasText: '单价已保存' })).toBeVisible()
  const { settings } = await api<{ settings: Record<string, string> }>(page, 'GET', '/api/settings')
  expect(JSON.parse(settings.modelPricing)['deepseek-*']).toEqual({ input: 2, output: 8, currency: 'CNY' })
})

test('设置 → 对话与工具：保存循环设置与联网搜索', async ({ page }) => {
  await page.goto('/#/settings/builtin')
  await page.locator('input[name="agent.maxTurns"]').fill('60')
  await page.locator('input[name=timezone]').fill('Asia/Shanghai')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.toast').filter({ hasText: '对话设置已保存' })).toBeVisible()
  const search = page.getByTestId('search-config')
  await search.locator('select[name=searchProvider]').selectOption('searxng')
  await search.getByPlaceholder('https://searx.example.com').fill('https://searx.example.com')
  await search.getByRole('button', { name: '保存搜索设置' }).click()
  await expect(search.locator('.badge-on')).toHaveText('已启用')
  const { settings } = await api<{ settings: Record<string, string> }>(page, 'GET', '/api/settings')
  expect(settings['agent.maxTurns']).toBe('60')
  expect(settings.timezone).toBe('Asia/Shanghai')
  // 还原，避免影响后续用例
  await api(page, 'PUT', '/api/chat/search-config', { provider: 'none' })
  await page.request.post(`${LLM}/__mock/reset`)
})
