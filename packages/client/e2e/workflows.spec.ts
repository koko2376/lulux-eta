import { expect, test, type Page } from '@playwright/test'

/**
 * 工作流（画布）+ 定时任务（契约第 11 节），真服务 + tools/dev/mock-openai.js：
 * 新建 → 加节点 → 拖线连接 → 保存（刷新后还在）→ 成环被拒（400 CYCLE_DETECTED）→ 运行（运行历史里各节点状态 / 输出 /
 * 下游拿到上游输出 / 查看节点隐藏会话）→ 从工具栏「定时」建任务（预填）→ 定时任务页：白话计划、立即运行、运行记录、停用、删除
 * → 导出再导入 → 删除工作流。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)
let workflowId = ''

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
const one = <T>(v: unknown, key: string): T =>
  (v && typeof v === 'object' && key in (v as object) ? (v as Record<string, T>)[key] : v) as T

async function script(page: Page, responses: unknown[]): Promise<void> {
  const res = await page.request.post(`${LLM}/__mock/script`, { data: { responses } })
  expect(res.ok()).toBeTruthy()
}

/** 从 a 的输出点拖到 b 的输入点 */
async function connect(page: Page, from: string, to: string): Promise<void> {
  const src = page.locator(`.vue-flow__node[data-id="${from}"] .vue-flow__handle.source`)
  const dst = page.locator(`.vue-flow__node[data-id="${to}"] .vue-flow__handle.target`)
  const a = (await src.boundingBox())!
  const b = (await dst.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
}

test('准备：Provider 指向 mock LLM，关闭自动标题', async ({ page }) => {
  await page.goto('/')
  await page.request.post(`${LLM}/__mock/reset`)
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: `Workflow Mock ${stamp}`,
    kind: 'openai',
    baseUrl: `${LLM}/v1`,
    apiKey: 'sk-workflow-e2e-0001',
    model: 'mock-model',
    models: ['mock-model'],
  })
  await api(page, 'PATCH', '/api/settings', { defaultProviderId: provider.id, autoTitle: '0' })
})

test('导航有「工作流」「定时任务」，新建工作流 → 加节点 → 连线 → 保存，刷新后还在', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('rail-workflows').click()
  await expect(page).toHaveURL(/#\/workflows/)
  await page.getByTestId('workflow-new').click()
  await expect(page).toHaveURL(/#\/workflows\/[^/]+$/)
  workflowId = page.url().split('/').pop()!
  const nodes = page.getByTestId('workflow-node')
  await expect(nodes).toHaveCount(1)

  // 改名
  const row = page.getByTestId('workflow-item').filter({ has: page.locator(`a[href$="${workflowId}"]`) })
  await row.hover()
  await row.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await page.getByTestId('rename-input').fill(`询盘流水线 ${stamp}`)
  await page.getByTestId('rename-input').press('Enter')
  await expect(page.locator('.tb-title')).toHaveText(`询盘流水线 ${stamp}`)

  await page.getByTestId('workflow-add-node').click()
  await expect(nodes).toHaveCount(2)
  // 两个节点在画布上可能重叠一部分：把第二个拖开
  const second = nodes.nth(1)
  const head = (await second.locator('.wf-node-head').boundingBox())!
  await page.mouse.move(head.x + 40, head.y + head.height / 2)
  await page.mouse.down()
  await page.mouse.move(head.x + 360, head.y + 160, { steps: 10 })
  await page.mouse.up()

  const ids = await nodes.evaluateAll((els) => els.map((e) => e.getAttribute('data-node-id')!))
  await nodes.nth(0).getByTestId('node-prompt').fill('列出本周的新询盘')
  await nodes.nth(1).getByTestId('node-prompt').fill('根据上游清单写跟进建议')
  await nodes.nth(1).locator('input.wf-name').fill('跟进建议')
  await nodes.nth(1).locator('input.wf-name').press('Enter')
  await connect(page, ids[0], ids[1])
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  // 下游节点有了上游才显示汇合策略；起始节点显示“起始节点”
  await expect(nodes.nth(1).getByTestId('join-select')).toBeVisible()
  await expect(nodes.nth(0).getByTestId('root-note')).toBeVisible()
  // 内核下拉：LULUX 在最前；模型只给 LULUX
  await expect(nodes.nth(0).getByTestId('kernel-select')).toContainText('LULUX')
  await expect(nodes.nth(0).getByTestId('model-select')).toBeVisible()

  await expect(page.getByTestId('workflow-dirty')).toBeVisible()
  await page.getByTestId('workflow-save').click()
  await expect(page.getByTestId('workflow-dirty')).toHaveCount(0)
  await expect(row).toContainText('2 节点 · 1 连线')

  await page.reload()
  await expect(page.getByTestId('workflow-node')).toHaveCount(2)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  await expect(page.getByTestId('workflow-node').nth(1).locator('input.wf-name')).toHaveValue('跟进建议')

  const saved = one<{ nodes: { prompt: string }[]; edges: unknown[] }>(
    await api(page, 'GET', `/api/workflows/${workflowId}`),
    'workflow',
  )
  expect(saved.nodes.map((n) => n.prompt)).toEqual(['列出本周的新询盘', '根据上游清单写跟进建议'])
  expect(saved.edges).toHaveLength(1)
})

test('成环的连线：画布上拖不上，PATCH 返回 400 CYCLE_DETECTED', async ({ page }) => {
  const w = one<{ nodes: { id: string }[]; edges: { id: string; source: string; target: string }[] }>(
    await api(page, 'GET', `/api/workflows/${workflowId}`),
    'workflow',
  )
  const [a, b] = w.nodes.map((n) => n.id)
  const res = await page.request.patch(`/api/workflows/${workflowId}`, {
    data: { edges: [...w.edges, { id: 'back', source: b, target: a }] },
  })
  expect(res.status()).toBe(400)
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CYCLE_DETECTED')

  await page.goto(`/#/workflows/${workflowId}`)
  await expect(page.getByTestId('workflow-node')).toHaveCount(2)
  await connect(page, b, a)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  await expect(page.getByTestId('workflow-dirty')).toHaveCount(0)
})

test('运行：运行历史里节点依次完成，下游拿到上游输出，可查看节点会话', async ({ page }) => {
  await page.request.post(`${LLM}/__mock/reset`)
  await script(page, [
    { text: '新询盘：Nordlicht GmbH，BV-25 球阀 400 只。', delayMs: 300 },
    { text: '建议今天回复 Nordlicht，附上 FOB 报价。', delayMs: 300 },
  ])
  await page.goto(`/#/workflows/${workflowId}`)
  await page.getByTestId('workflow-run').click()
  await page.getByTestId('run-input').fill('本周')
  await page.getByTestId('run-confirm').click()

  const panel = page.getByTestId('run-history')
  await expect(panel).toBeVisible()
  const rows = panel.getByTestId('run-node')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('已完成', { timeout: 30_000 })
  await expect(rows.nth(1)).toContainText('已完成', { timeout: 30_000 })
  await expect(page.getByTestId('workflow-node').first().getByTestId('node-status')).toHaveText('已完成')
  await rows.nth(1).locator('.rh-node-head').click()
  await expect(rows.nth(1)).toContainText('建议今天回复 Nordlicht')

  // 下游节点的提示词里带上游输出
  const reqs = (await (await page.request.get(`${LLM}/__mock/requests`)).json()) as { body?: unknown }[]
  expect(JSON.stringify(reqs.at(-1))).toContain('Nordlicht GmbH')

  await rows.nth(1).getByTestId('open-session').click()
  await expect(page.getByTestId('session-peek')).toContainText('建议今天回复 Nordlicht')
  await page.keyboard.press('Escape')

  // 隐藏会话不出现在会话列表 / Agent 侧栏，只读（发消息 409）
  const runs = (await api<unknown>(page, 'GET', `/api/workflows/${workflowId}/runs`)) as {
    nodes: { sessionId: string | null }[]
  }[]
  const nodeSessions = runs[0].nodes.map((n) => n.sessionId).filter((id): id is string => Boolean(id))
  expect(nodeSessions).toHaveLength(2)
  const sessions = (await api<unknown>(page, 'GET', '/api/sessions')) as { id: string }[] | { sessions: unknown[] }
  const list = (Array.isArray(sessions) ? sessions : sessions.sessions) as {
    id: string
    workflowRunId?: string | null
  }[]
  expect(list.some((s) => nodeSessions.includes(s.id) || s.workflowRunId)).toBe(false)
  const hidden = await api<{ session: { workflowRunId: string | null } }>(
    page,
    'GET',
    `/api/sessions/${nodeSessions[0]}`,
  )
  expect(hidden.session.workflowRunId).toBeTruthy()
  const send = await page.request.post('/api/chat', { data: { sessionId: nodeSessions[0], content: '继续' } })
  expect(send.status()).toBe(409)
  expect(((await send.json()) as { error: { code: string } }).error.code).toBe('WORKFLOW_SESSION_READONLY')

  // 返回运行列表：最新一次在最前
  await panel.getByRole('button', { name: '返回运行列表' }).click()
  await expect(panel.getByTestId('run-row').first()).toContainText('已完成')
  await expect(panel.getByTestId('run-row').first()).toContainText('手动运行')

  await page.goto('/#/agent')
  await expect(page.locator('.session-item').first()).toBeVisible()
  await expect(page.locator('.session-item').filter({ hasText: '[工作流]' })).toHaveCount(0)
})

test('工具栏「定时」：对话框预填工作流，预览 5 次，保存后在定时任务页', async ({ page }) => {
  await page.goto(`/#/workflows/${workflowId}`)
  await page.getByTestId('workflow-schedule').click()
  const dialog = page.getByTestId('schedule-dialog')
  await expect(page.getByTestId('schedule-workflow')).toHaveValue(workflowId)
  await expect(page.getByTestId('schedule-name')).toHaveValue(`定时运行「询盘流水线 ${stamp}」`)
  await page.getByTestId('spec-weekly').click()
  // 每周默认一三五
  for (const d of [1, 3, 5]) await expect(page.getByTestId(`day-${d}`)).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('spec-time').fill('18:30')
  await expect(page.getByTestId('preview-item')).toHaveCount(5)
  await expect(page.getByTestId('schedule-preview')).toContainText('每周一三五 18:30')
  await expect(dialog).toBeVisible()
  await page.getByTestId('schedule-save').click()
  await expect(dialog).toHaveCount(0)

  await page.getByTestId('rail-schedules').click()
  const row = page.getByTestId('schedule-row').filter({ hasText: `询盘流水线 ${stamp}` })
  await expect(row).toContainText('每周一三五 18:30')
  await expect(row).toContainText('工作流')
})

test('定时任务页：立即运行 → 运行记录；停用；提示词任务的校验；删除', async ({ page }) => {
  await page.request.post(`${LLM}/__mock/reset`)
  await script(page, [{ text: '定时：询盘清单' }, { text: '定时：跟进建议' }])
  await page.goto('/#/schedules')
  const row = page.getByTestId('schedule-row').filter({ hasText: `询盘流水线 ${stamp}` })
  await row.getByTestId('schedule-run-now').click()
  await expect(page.locator('.toast', { hasText: '已开始运行' })).toBeVisible()
  await row.getByTestId('schedule-more').click()
  await row.getByTestId('schedule-history').click()
  const runs = page.getByTestId('schedule-runs')
  await expect(runs.locator('li').first()).toContainText(/运行中|排队中|已完成/)
  await expect
    .poll(async () => (await runs.locator('li').first().textContent()) ?? '', { timeout: 30_000, intervals: [1000] })
    .toContain('已完成')
  await page.keyboard.press('Escape')

  // 停用
  const sw = row.getByRole('switch')
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(row).toHaveClass(/off/)

  // 提示词任务：校验
  await page.getByTestId('schedule-new').click()
  await page.getByTestId('target-prompt').click()
  await page.getByTestId('spec-interval').click()
  await page.getByTestId('spec-minutes').fill('3')
  await page.getByTestId('schedule-save').click()
  await expect(page.getByTestId('schedule-dialog')).toContainText('请填写名称')
  await expect(page.getByTestId('schedule-dialog')).toContainText('请填写提示词')
  await expect(page.getByTestId('schedule-dialog')).toContainText('间隔为 5–10080 分钟的整数')
  await page.getByTestId('schedule-name').fill(`汇率提醒 ${stamp}`)
  await page.getByTestId('schedule-prompt').fill('查一下今天的美元汇率')
  await page.getByTestId('spec-minutes').fill('30')
  await page.getByTestId('schedule-save').click()
  const promptRow = page.getByTestId('schedule-row').filter({ hasText: `汇率提醒 ${stamp}` })
  await expect(promptRow).toContainText('每 30 分钟')
  await expect(promptRow).toContainText('LULUX')

  // 删除两个任务
  for (const name of [`汇率提醒 ${stamp}`, `询盘流水线 ${stamp}`]) {
    const r = page.getByTestId('schedule-row').filter({ hasText: name })
    await r.getByTestId('schedule-more').click()
    await r.getByTestId('schedule-delete').click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect(r).toHaveCount(0)
  }
})

test('导出再导入，删除工作流', async ({ page }) => {
  const exported = await api<unknown>(page, 'GET', `/api/workflows/${workflowId}/export`)
  await page.goto(`/#/workflows/${workflowId}`)
  await page.getByTestId('workflow-import-input').setInputFiles({
    name: 'flow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  })
  await expect(page.locator('.toast', { hasText: '已导入' })).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(`${workflowId}$`))
  const importedId = page.url().split('/').pop()!
  await expect(page.getByTestId('workflow-node')).toHaveCount(2)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)

  for (const id of [importedId, workflowId]) {
    const row = page.getByTestId('workflow-item').filter({ has: page.locator(`a[href$="${id}"]`) })
    await row.hover()
    await row.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '删除' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect(row).toHaveCount(0)
  }
})
