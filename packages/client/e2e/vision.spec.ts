import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * 图片输入（vision）：输入框粘贴两张图 → 缩略图 → 发送 → 图片内容块真的到达上游（mock-openai GET /__mock/last），
 * 已发送消息里显示缩略图、点击放大；设置 → 模型 关闭“看图”后输入框提示、只发文件路径。
 * 截图：设置 E2E_SHOTS_DIR 时另存一份到该目录（composer.png / sent.png / lightbox.png / non-vision.png）。
 */
test.describe.configure({ mode: 'serial' })

const LLM = `http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}`
const stamp = Date.now().toString(36)
const title = `看图验收 ${stamp}`
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

async function shot(page: Page, name: string, target?: ReturnType<Page['locator']>): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR
  const path = join(dir || test.info().outputDir, name)
  if (target) await target.screenshot({ path })
  else await page.screenshot({ path })
}

/** 在页面里画两张示例图（报价单截图 + 产品图），作为剪贴板文件粘贴进输入框 */
async function pasteImages(page: Page, count: number): Promise<void> {
  await page.locator('[data-composer-input]').focus()
  await page.evaluate(async (n) => {
    const draw = (kind: number): Promise<File> => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 420
      const ctx = canvas.getContext('2d')!
      if (kind === 0) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, 640, 420)
        ctx.fillStyle = '#111'
        ctx.font = 'bold 28px sans-serif'
        ctx.fillText('QUOTATION  BV-25 Ball Valve', 30, 56)
        ctx.font = '20px sans-serif'
        const rows = [
          ['Item', 'Qty', 'FOB USD'],
          ['BV-25 brass', '400', '12.50'],
          ['BV-32 brass', '200', '15.80'],
          ['Lead time', '30 days', ''],
        ]
        rows.forEach((row, i) => {
          ctx.strokeStyle = '#ccc'
          ctx.strokeRect(30, 90 + i * 64, 580, 64)
          row.forEach((cell, j) => ctx.fillText(cell, 46 + j * 200, 130 + i * 64))
        })
      } else {
        const g = ctx.createLinearGradient(0, 0, 640, 420)
        g.addColorStop(0, '#f6d365')
        g.addColorStop(1, '#fda085')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, 640, 420)
        ctx.fillStyle = '#b87333'
        ctx.beginPath()
        ctx.arc(320, 210, 120, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#7a4a1f'
        ctx.fillRect(170, 190, 300, 40)
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 26px sans-serif'
        ctx.fillText('Brass valve sample', 200, 380)
      }
      return new Promise((resolve) =>
        canvas.toBlob(
          (blob) => resolve(new File([blob!], kind === 0 ? 'image.png' : 'valve-sample.png', { type: 'image/png' })),
          'image/png',
        ),
      )
    }
    const data = new DataTransfer()
    for (let i = 0; i < n; i += 1) data.items.add(await draw(i % 2))
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    document.querySelector('[data-composer-input]')!.dispatchEvent(event)
  }, count)
}

test('准备：看图 Provider（mock-model 打开 vision）、会话', async ({ page }) => {
  await page.goto('/')
  await page.request.post(`${LLM}/__mock/reset`)
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: `Vision Mock ${stamp}`,
    kind: 'openai',
    baseUrl: `${LLM}/v1`,
    apiKey: 'sk-vision-e2e-0001',
    model: 'mock-model',
    models: ['mock-model'],
  })
  providerId = provider.id
  await api(page, 'PATCH', '/api/settings', {
    defaultProviderId: provider.id,
    autoTitle: '0',
    modelCapabilities: JSON.stringify({ 'mock-model': { vision: true } }),
  })
  await api(page, 'POST', '/api/sessions', { title, agentIds: ['builtin'], providerId: provider.id })
})

test('粘贴两张图 → 缩略图 → 发送 → 上游收到两个 image_url 内容块；消息里缩略图可放大', async ({ page }) => {
  await page.goto('/#/agent')
  await page.locator('.session-item', { hasText: title }).first().click()
  await expect(page.locator('.chat-header h1')).toContainText(title)
  await page.request.post(`${LLM}/__mock/reset`)

  await pasteImages(page, 2)
  const thumbs = page.locator('[data-testid="composer-image"]')
  await expect(thumbs).toHaveCount(2)
  await expect(page.locator('[data-testid="composer-image"].done')).toHaveCount(2)
  await page.locator('[data-composer-input]').fill('帮我看看这张报价单和样品图，单价和交期分别是多少？')
  await expect(page.locator('[data-testid="composer-vision-note"]')).toHaveCount(0)
  await shot(page, 'composer.png', page.locator('.composer-wrap'))
  await shot(page, 'composer-page.png')

  await page.locator('.composer-send').click()
  const sent = page.locator('.message.user').last()
  await expect(sent.locator('[data-testid="message-images"] img')).toHaveCount(2)
  await expect(page.locator('.message.assistant').last()).toContainText('收到 2 张图片', { timeout: 20_000 })

  const last = await (await page.request.get(`${LLM}/__mock/last`)).json()
  expect(last.images).toHaveLength(2)
  for (const image of last.images) expect(image).toMatchObject({ role: 'user', mime: 'image/png', dataUrl: true })
  expect(last.images[0].base64Length).toBeGreaterThan(1000)

  await shot(page, 'sent.png')
  await sent.locator('.message-image').first().click()
  await expect(page.locator('[data-testid="image-lightbox"] img')).toBeVisible()
  await shot(page, 'lightbox.png')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="image-lightbox"]')).toHaveCount(0)

  // 刷新后从服务端读回：消息带图片引用，缩略图经鉴权下载显示
  await page.reload()
  await page.locator('.session-item', { hasText: title }).first().click()
  await expect(page.locator('.message.user').last().locator('[data-testid="message-images"] img')).toHaveCount(2)
})

test('设置 → 模型 关闭“看图”：输入框提示、上游只收到文件路径、运行提示不支持看图', async ({ page }) => {
  await page.goto('/#/settings/models')
  const toggle = page.locator(`[data-testid="vision-${providerId}"] [role="switch"]`)
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await page.goto('/#/agent')
  await page.locator('.session-item', { hasText: title }).first().click()
  await page.request.post(`${LLM}/__mock/reset`)
  await pasteImages(page, 1)
  await expect(page.locator('[data-testid="composer-image"].done')).toHaveCount(1)
  await expect(page.locator('[data-testid="composer-vision-note"]')).toContainText('mock-model 不支持看图')
  await shot(page, 'non-vision.png', page.locator('.composer-wrap'))
  await page.locator('[data-composer-input]').fill('这张呢？')
  await page.locator('.composer-send').click()
  await expect(page.locator('.run-notice.vision').last()).toContainText('不支持看图', { timeout: 20_000 })
  await expect(page.locator('.message.assistant').last()).toContainText('好的', { timeout: 20_000 })
  const last = await (await page.request.get(`${LLM}/__mock/last`)).json()
  expect(last.images).toHaveLength(0)
  const user = last.request.messages[last.request.messages.length - 1]
  expect(user.content).toContain('uploads/')
})
